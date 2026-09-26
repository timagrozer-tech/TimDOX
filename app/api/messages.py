"""Личные и групповые сообщения, поток событий реального времени (SSE)."""
import asyncio

from sse_starlette.sse import EventSourceResponse
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, social
from ..realtime import hub
from ..security import censor, clean_text
from ..web import ApiError, auth, body, int_param, limit, ok, path_int

PAGE = 40
MAX_GROUP = 50


def _member(conv_id: int, v: int) -> dict:
    row = db.one("SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?", (conv_id, v))
    if not row:
        raise ApiError(404, "Диалог не найден")
    return row


def _conv(conv_id: int) -> dict:
    row = db.one("SELECT * FROM conversations WHERE id=?", (conv_id,))
    if not row:
        raise ApiError(404, "Диалог не найден")
    return row


def member_ids(conv_id: int) -> list[int]:
    return [r["user_id"] for r in db.all("SELECT user_id FROM conversation_members WHERE conversation_id=?", (conv_id,))]


def _other_id(conv_id: int, v: int) -> int | None:
    return db.value("SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id!=?", (conv_id, v))


def _msg_view(m: dict) -> dict:
    return {"id": m["id"], "conversation_id": m["conversation_id"], "sender_id": m["sender_id"],
            "text": m["text"], "kind": m.get("kind") or "text", "created_at": m["created_at"]}


def _can_message(v: int, other: int) -> tuple[bool, str]:
    if social.blocked_between(v, other):
        return False, "Вы не можете написать этому пользователю"
    priv = db.value("SELECT message_privacy FROM profiles WHERE user_id=?", (other,))
    if priv == "friends" and not social.are_friends(v, other):
        return False, "Пользователь принимает сообщения только от друзей"
    return True, ""


def _conv_view(conv_id: int, v: int) -> dict:
    conv = _conv(conv_id)
    me = _member(conv_id, v)
    last = db.one("SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", (conv_id,))
    unread = db.value("SELECT count(*) FROM messages WHERE conversation_id=? AND id>? AND sender_id!=?",
                      (conv_id, me["last_read_id"], v))
    others = [r for r in db.all("SELECT user_id, last_read_id FROM conversation_members WHERE conversation_id=? AND user_id!=?",
                                (conv_id, v))]
    # «прочитано», если прочитал хотя бы один собеседник
    other_read = max((r["last_read_id"] for r in others), default=0)
    base = {"id": conv_id, "is_group": bool(conv["is_group"]), "last_message": _msg_view(last) if last else None,
            "unread": unread, "other_last_read_id": other_read}
    if last and conv["is_group"]:
        base["last_sender"] = social.cards_by_ids([last["sender_id"]]).get(last["sender_id"])
    if conv["is_group"]:
        members = social.cards_by_ids([r["user_id"] for r in others] + [v])
        return {**base, "title": conv["title"] or "Беседа", "user": None, "can_write": True,
                "members": sorted(members.values(), key=lambda m: m["name"]), "created_by": conv["created_by"]}
    other = others[0]["user_id"] if others else None
    card = social.cards_by_ids([other]).get(other) if other else None
    return {**base, "user": card or {"id": None, "name": "Удалённый пользователь", "username": "", "avatar": None, "online": False},
            "title": card["name"] if card else "Удалённый пользователь",
            "can_write": bool(other) and _can_message(v, other)[0]}


def direct_conversation(v: int, other: int) -> int:
    """Возвращает личный диалог (создаёт при необходимости, с проверкой приватности)."""
    key = f"{min(v, other)}:{max(v, other)}"
    conv = db.value("SELECT id FROM conversations WHERE direct_key=?", (key,))
    if conv:
        return conv
    allowed, reason = _can_message(v, other)
    if not allowed:
        raise ApiError(403, reason)
    with db.tx() as c:
        conv = c.execute("INSERT INTO conversations (direct_key) VALUES (?)", (key,)).lastrowid
        c.execute("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?,?),(?,?)", (conv, v, conv, other))
    return conv


def deliver_message(conv_id: int, sender: int, text: str, kind: str = "text") -> dict:
    """Сохраняет сообщение и рассылает его участникам в реальном времени."""
    now = db.now()
    with db.tx() as c:
        mid = c.execute("INSERT INTO messages (conversation_id, sender_id, text, kind, created_at) VALUES (?,?,?,?,?)",
                        (conv_id, sender, text, kind, now)).lastrowid
        c.execute("UPDATE conversations SET last_message_at=? WHERE id=?", (now, conv_id))
        c.execute("UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?", (mid, conv_id, sender))
    msg = _msg_view(db.one("SELECT * FROM messages WHERE id=?", (mid,)))
    sender_card = social.cards_by_ids([sender])[sender]
    for uid in member_ids(conv_id):
        hub.publish(uid, "message", {"message": msg, "sender": sender_card})
        if uid != sender:
            social.push_counters(uid)
    return msg


@auth()
async def list_conversations(request: Request):
    v = request.state.user["id"]
    ids = [r["conversation_id"] for r in db.all("""
        SELECT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id=? AND c.last_message_at IS NOT NULL ORDER BY c.last_message_at DESC LIMIT 100""", (v,))]
    return JSONResponse({"items": [_conv_view(i, v) for i in ids]})


@auth()
async def open_conversation(request: Request):
    v = request.state.user["id"]
    data = await body(request)
    try:
        other = int(data.get("user_id"))
    except (TypeError, ValueError):
        raise ApiError(400, "Не указан собеседник")
    if other == v or not db.value("SELECT 1 FROM users WHERE id=?", (other,)):
        raise ApiError(404, "Пользователь не найден")
    return JSONResponse(_conv_view(direct_conversation(v, other), v))


def _friend_ids_from(data: dict, v: int) -> list[int]:
    try:
        ids = [int(x) for x in data.get("user_ids") or []]
    except (TypeError, ValueError):
        raise ApiError(400, "Некорректный список участников")
    friends = set(social.friend_ids(v))
    bad = [i for i in ids if i not in friends]
    if bad:
        raise ApiError(403, "В беседу можно добавить только друзей")
    return list(dict.fromkeys(ids))


@auth(require_verified=True)
async def create_group(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    title = censor(clean_text(data.get("title"), 80)) or None
    ids = _friend_ids_from(data, v)
    if len(ids) < 2:
        raise ApiError(400, "Добавьте в беседу хотя бы двух друзей")
    if len(ids) + 1 > MAX_GROUP:
        raise ApiError(400, f"В беседе может быть не больше {MAX_GROUP} участников")
    if not title:
        names = [c["name"].split()[0] for c in social.cards_by_ids(ids[:3]).values()]
        title = ", ".join([request.state.user["name"].split()[0], *names])[:80]
    with db.tx() as c:
        conv = c.execute("INSERT INTO conversations (is_group, title, created_by) VALUES (1,?,?)", (title, v)).lastrowid
        for uid in [v, *ids]:
            c.execute("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?,?)", (conv, uid))
    deliver_message(conv, v, f"{request.state.user['name']} создал(а) беседу «{title}»", kind="system")
    return JSONResponse(_conv_view(conv, v), status_code=201)


@auth()
async def update_group(request: Request):
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    if not _conv(conv_id)["is_group"]:
        raise ApiError(400, "Это не беседа")
    data = await body(request)
    title = censor(clean_text(data.get("title"), 80))
    if not title:
        raise ApiError(400, "Название не может быть пустым")
    db.run("UPDATE conversations SET title=? WHERE id=?", (title, conv_id))
    deliver_message(conv_id, v, f"{request.state.user['name']} переименовал(а) беседу в «{title}»", kind="system")
    return JSONResponse(_conv_view(conv_id, v))


@auth()
async def add_members(request: Request):
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    if not _conv(conv_id)["is_group"]:
        raise ApiError(400, "Это не беседа")
    ids = [i for i in _friend_ids_from(await body(request), v) if i not in member_ids(conv_id)]
    if len(member_ids(conv_id)) + len(ids) > MAX_GROUP:
        raise ApiError(400, f"В беседе может быть не больше {MAX_GROUP} участников")
    last = db.value("SELECT max(id) FROM messages WHERE conversation_id=?", (conv_id,)) or 0
    for uid in ids:
        # новые участники не видят непрочитанными старые сообщения
        db.run("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_id) VALUES (?,?,?)",
               (conv_id, uid, last))
    if ids:
        names = ", ".join(c["name"] for c in social.cards_by_ids(ids).values())
        deliver_message(conv_id, v, f"{request.state.user['name']} добавил(а): {names}", kind="system")
    return JSONResponse(_conv_view(conv_id, v))


@auth()
async def leave_group(request: Request):
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    if not _conv(conv_id)["is_group"]:
        raise ApiError(400, "Из личного диалога выйти нельзя")
    deliver_message(conv_id, v, f"{request.state.user['name']} покинул(а) беседу", kind="system")
    db.run("DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?", (conv_id, v))
    if not member_ids(conv_id):
        db.run("DELETE FROM conversations WHERE id=?", (conv_id,))
    social.push_counters(v)
    return ok()


@auth()
async def get_conversation(request: Request):
    v = request.state.user["id"]
    return JSONResponse(_conv_view(path_int(request), v))


@auth()
async def list_messages(request: Request):
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    before = int_param(request, "before", 2**62)
    rows = db.all("SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?",
                  (conv, before, PAGE + 1))
    items = [_msg_view(m) for m in reversed(rows[:PAGE])]
    senders = social.cards_by_ids({m["sender_id"] for m in items})
    return JSONResponse({"items": items, "has_more": len(rows) > PAGE,
                         "senders": {str(k): val for k, val in senders.items()}})


@auth(require_verified=True)
async def send_message(request: Request):
    limit(request, "message")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    conv = _conv(conv_id)
    if not conv["is_group"]:
        other = _other_id(conv_id, v)
        if not other:
            raise ApiError(403, "Собеседник удалил аккаунт")
        allowed, reason = _can_message(v, other)
        if not allowed:
            raise ApiError(403, reason)
    data = await body(request)
    text = censor(clean_text(data.get("text"), config.MESSAGE_MAX_LEN))
    if not text:
        raise ApiError(400, "Пустое сообщение")
    return JSONResponse(deliver_message(conv_id, v, text), status_code=201)


@auth()
async def mark_read(request: Request):
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    last = db.value("SELECT max(id) FROM messages WHERE conversation_id=?", (conv,)) or 0
    db.run("UPDATE conversation_members SET last_read_id=greatest(last_read_id, ?) WHERE conversation_id=? AND user_id=?",
           (last, conv, v))
    for uid in member_ids(conv):
        if uid != v:
            hub.publish(uid, "read", {"conversation_id": conv, "user_id": v, "last_read_id": last})
    social.push_counters(v)
    return ok()


@auth()
async def typing(request: Request):
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    name = request.state.user["name"]
    for uid in member_ids(conv):
        if uid != v:
            hub.publish(uid, "typing", {"conversation_id": conv, "user_id": v, "name": name})
    return ok()


# ----------------------------------------------------------------------------
# Поток событий
# ----------------------------------------------------------------------------
@auth()
async def stream(request: Request):
    v = request.state.user["id"]
    q, first = hub.subscribe(v)
    if first:
        hub.publish_many(social.friend_ids(v), "presence", {"user_id": v, "online": True})

    async def events():
        try:
            yield {"event": "hello", "data": "{}"}
            while True:
                try:
                    event, payload = await asyncio.wait_for(q.get(), timeout=20)
                    yield {"event": event, "data": payload}
                except asyncio.TimeoutError:
                    yield {"comment": "ping"}
        finally:
            if hub.unsubscribe(v, q):
                db.run("UPDATE users SET last_seen_at=? WHERE id=?", (db.now(), v))
                hub.publish_many(social.friend_ids(v), "presence", {"user_id": v, "online": False})

    return EventSourceResponse(events(), ping=None, headers={"X-Accel-Buffering": "no"})


routes = [
    Route("/api/conversations", list_conversations, methods=["GET"]),
    Route("/api/conversations", open_conversation, methods=["POST"]),
    Route("/api/conversations/group", create_group, methods=["POST"]),
    Route("/api/conversations/{id:int}", get_conversation, methods=["GET"]),
    Route("/api/conversations/{id:int}", update_group, methods=["PATCH"]),
    Route("/api/conversations/{id:int}/members", add_members, methods=["POST"]),
    Route("/api/conversations/{id:int}/leave", leave_group, methods=["POST"]),
    Route("/api/conversations/{id:int}/messages", list_messages, methods=["GET"]),
    Route("/api/conversations/{id:int}/messages", send_message, methods=["POST"]),
    Route("/api/conversations/{id:int}/read", mark_read, methods=["POST"]),
    Route("/api/conversations/{id:int}/typing", typing, methods=["POST"]),
    Route("/api/stream", stream, methods=["GET"]),
]
