"""Личные сообщения и поток событий реального времени (SSE)."""
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


def _member(conv_id: int, v: int) -> dict:
    row = db.one("SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?", (conv_id, v))
    if not row:
        raise ApiError(404, "Диалог не найден")
    return row


def _other_id(conv_id: int, v: int) -> int | None:
    return db.value("SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id!=?", (conv_id, v))


def _msg_view(m: dict) -> dict:
    return {"id": m["id"], "conversation_id": m["conversation_id"], "sender_id": m["sender_id"],
            "text": m["text"], "created_at": m["created_at"]}


def _conv_view(conv_id: int, v: int) -> dict:
    other = _other_id(conv_id, v)
    card = social.cards_by_ids([other]).get(other) if other else None
    last = db.one("SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", (conv_id,))
    me = _member(conv_id, v)
    other_read = db.value("SELECT last_read_id FROM conversation_members WHERE conversation_id=? AND user_id=?",
                          (conv_id, other)) or 0
    unread = db.value("SELECT count(*) FROM messages WHERE conversation_id=? AND id>? AND sender_id!=?",
                      (conv_id, me["last_read_id"], v))
    can_write = bool(other) and _can_message(v, other)[0]
    return {"id": conv_id, "user": card or {"id": None, "name": "Удалённый пользователь", "username": "", "avatar": None, "online": False},
            "last_message": _msg_view(last) if last else None, "unread": unread,
            "other_last_read_id": other_read, "can_write": can_write}


def _can_message(v: int, other: int) -> tuple[bool, str]:
    if social.blocked_between(v, other):
        return False, "Вы не можете написать этому пользователю"
    priv = db.value("SELECT message_privacy FROM profiles WHERE user_id=?", (other,))
    if priv == "friends" and not social.are_friends(v, other):
        return False, "Пользователь принимает сообщения только от друзей"
    return True, ""


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
    key = f"{min(v, other)}:{max(v, other)}"
    conv = db.value("SELECT id FROM conversations WHERE direct_key=?", (key,))
    if not conv:
        allowed, reason = _can_message(v, other)
        if not allowed:
            raise ApiError(403, reason)
        with db.tx() as c:
            conv = c.execute("INSERT INTO conversations (direct_key) VALUES (?)", (key,)).lastrowid
            c.execute("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?,?),(?,?)", (conv, v, conv, other))
    return JSONResponse(_conv_view(conv, v))


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
    return JSONResponse({"items": items, "has_more": len(rows) > PAGE})


@auth(require_verified=True)
async def send_message(request: Request):
    limit(request, "message")
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    other = _other_id(conv, v)
    if not other:
        raise ApiError(403, "Собеседник удалил аккаунт")
    allowed, reason = _can_message(v, other)
    if not allowed:
        raise ApiError(403, reason)
    data = await body(request)
    text = censor(clean_text(data.get("text"), config.MESSAGE_MAX_LEN))
    if not text:
        raise ApiError(400, "Пустое сообщение")
    now = db.now()
    with db.tx() as c:
        mid = c.execute("INSERT INTO messages (conversation_id, sender_id, text, created_at) VALUES (?,?,?,?)",
                        (conv, v, text, now)).lastrowid
        c.execute("UPDATE conversations SET last_message_at=? WHERE id=?", (now, conv))
        c.execute("UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?", (mid, conv, v))
    msg = _msg_view(db.one("SELECT * FROM messages WHERE id=?", (mid,)))
    sender = social.cards_by_ids([v])[v]
    hub.publish(other, "message", {"message": msg, "sender": sender})
    hub.publish(v, "message", {"message": msg, "sender": sender})
    social.push_counters(other)
    return JSONResponse(msg, status_code=201)


@auth()
async def mark_read(request: Request):
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    last = db.value("SELECT max(id) FROM messages WHERE conversation_id=?", (conv,)) or 0
    db.run("UPDATE conversation_members SET last_read_id=max(last_read_id, ?) WHERE conversation_id=? AND user_id=?",
           (last, conv, v))
    other = _other_id(conv, v)
    if other:
        hub.publish(other, "read", {"conversation_id": conv, "user_id": v, "last_read_id": last})
    social.push_counters(v)
    return ok()


@auth()
async def typing(request: Request):
    v = request.state.user["id"]
    conv = path_int(request)
    _member(conv, v)
    other = _other_id(conv, v)
    if other:
        hub.publish(other, "typing", {"conversation_id": conv, "user_id": v})
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
    Route("/api/conversations/{id:int}", get_conversation, methods=["GET"]),
    Route("/api/conversations/{id:int}/messages", list_messages, methods=["GET"]),
    Route("/api/conversations/{id:int}/messages", send_message, methods=["POST"]),
    Route("/api/conversations/{id:int}/read", mark_read, methods=["POST"]),
    Route("/api/conversations/{id:int}/typing", typing, methods=["POST"]),
    Route("/api/stream", stream, methods=["GET"]),
]
