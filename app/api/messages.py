"""Личные и групповые сообщения, поток событий реального времени (SSE)."""
import asyncio
import json

from sse_starlette.sse import EventSourceResponse
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, media, social
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


REACTION_EMOJI = {"👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👎", "🙏", "😡"}
EDIT_WINDOW_HOURS = 48


def _preview_text(m: dict) -> str:
    kind = m.get("kind") or "text"
    if kind == "deleted":
        return "Сообщение удалено"
    labels = {"photo": "📷 Фото", "video": "🎬 Видео", "audio": "🎵 Музыка", "voice": "🎤 Голосовое", "sticker": "Стикер"}
    base = labels.get(kind, "")
    text = (m.get("text") or "").strip()
    if kind == "sticker":
        return f"{text} Стикер".strip()
    return (f"{base} {text}".strip() if base else text)[:120]


def _enrich(views: list[dict]) -> list[dict]:
    """Добавляет к сообщениям цитату (ответ) и реакции — пачкой, без запроса на каждое сообщение."""
    if not views:
        return views
    ids = [v["id"] for v in views]
    reacts: dict[int, dict[str, list[int]]] = {}
    for r in db.all(f"SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN ({db.placeholders(ids)}) ORDER BY created_at",
                    tuple(ids)):
        reacts.setdefault(r["message_id"], {}).setdefault(r["emoji"], []).append(r["user_id"])
    reply_ids = list({v["reply_to"] for v in views if v.get("reply_to")})
    replies = {r["id"]: r for r in db.all(f"SELECT id, sender_id, text, kind FROM messages WHERE id IN ({db.placeholders(reply_ids)})",
                                          tuple(reply_ids))} if reply_ids else {}
    for v in views:
        v["reactions"] = [{"emoji": e, "users": u} for e, u in reacts.get(v["id"], {}).items()]
        if v.get("reply_to"):
            r = replies.get(v["reply_to"])
            v["reply"] = {"id": r["id"], "sender_id": r["sender_id"], "kind": r["kind"], "text": _preview_text(r)} if r \
                else {"id": v["reply_to"], "sender_id": None, "kind": "deleted", "text": "Сообщение удалено"}
    return views


def _msg_view(m: dict) -> dict:
    view = {"id": m["id"], "conversation_id": m["conversation_id"], "sender_id": m["sender_id"],
            "text": m["text"], "kind": m.get("kind") or "text", "created_at": m["created_at"],
            "reply_to": m.get("reply_to"), "edited_at": m.get("edited_at")}
    if m.get("media"):
        try:
            view["media"] = json.loads(m["media"])
        except ValueError:
            pass
    return view


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
    if card:
        hidden = other in social.invisible_ids() or social.blocked_between(v, other)
        card = {**card, "last_seen_at": None if hidden else db.value("SELECT last_seen_at FROM users WHERE id=?", (other,))}
    return {**base, "user": card or {"id": None, "name": "Удалённый пользователь", "username": "", "avatar": None, "online": False},
            "title": card["name"] if card else "Удалённый пользователь",
            "can_write": bool(other) and _can_message(v, other)[0]}


def _conv_views(ids: list[int], v: int) -> list[dict]:
    """Список диалогов за несколько запросов вместо ~8 на каждый диалог."""
    if not ids:
        return []
    ph = db.placeholders(ids)
    convs = {c["id"]: c for c in db.all(f"SELECT * FROM conversations WHERE id IN ({ph})", tuple(ids))}
    members: dict[int, list[dict]] = {}
    for r in db.all(f"SELECT conversation_id, user_id, last_read_id FROM conversation_members WHERE conversation_id IN ({ph})", tuple(ids)):
        members.setdefault(r["conversation_id"], []).append(r)
    lasts = {m["conversation_id"]: m for m in db.all(
        f"SELECT * FROM messages WHERE id IN (SELECT max(id) FROM messages WHERE conversation_id IN ({ph}) GROUP BY conversation_id)", tuple(ids))}
    unread = {r["conversation_id"]: r["n"] for r in db.all(f"""
        SELECT m.conversation_id, count(*) AS n FROM messages m
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.conversation_id IN ({ph}) AND m.id > cm.last_read_id AND m.sender_id <> ?
        GROUP BY m.conversation_id""", (v, *ids, v))}
    people = {r["user_id"] for ms in members.values() for r in ms} | {m["sender_id"] for m in lasts.values()}
    cards = social.cards_by_ids(list(people))
    direct_others = [next((r["user_id"] for r in members.get(i, []) if r["user_id"] != v), None)
                     for i in ids if not convs.get(i, {}).get("is_group")]
    direct_others = [x for x in direct_others if x]
    seen = {r["id"]: r["last_seen_at"] for r in db.all(
        f"SELECT id, last_seen_at FROM users WHERE id IN ({db.placeholders(direct_others)})", tuple(direct_others))} if direct_others else {}
    blocked = {r["other"] for r in db.all(
        f"""SELECT CASE WHEN blocker_id = ? THEN blocked_id ELSE blocker_id END AS other FROM blocks
            WHERE (blocker_id = ? AND blocked_id IN ({db.placeholders(direct_others)}))
               OR (blocked_id = ? AND blocker_id IN ({db.placeholders(direct_others)}))""",
        (v, v, *direct_others, v, *direct_others))} if direct_others else set()
    out = []
    for i in ids:
        conv = convs.get(i)
        if not conv:
            continue
        ms = members.get(i, [])
        others = [r for r in ms if r["user_id"] != v]
        last = lasts.get(i)
        base = {"id": i, "is_group": bool(conv["is_group"]), "last_message": _msg_view(last) if last else None,
                "unread": unread.get(i, 0), "other_last_read_id": max((r["last_read_id"] for r in others), default=0)}
        if conv["is_group"]:
            if last:
                base["last_sender"] = cards.get(last["sender_id"])
            mem = [cards[r["user_id"]] for r in ms if r["user_id"] in cards]
            out.append({**base, "title": conv["title"] or "Беседа", "user": None, "can_write": True,
                        "members": sorted(mem, key=lambda m: m["name"]), "created_by": conv["created_by"]})
            continue
        other = others[0]["user_id"] if others else None
        card = cards.get(other) if other else None
        if card:
            card = {**card, "last_seen_at": None if other in blocked or other in social.invisible_ids() else seen.get(other)}
        out.append({**base, "user": card or {"id": None, "name": "Удалённый пользователь", "username": "", "avatar": None, "online": False},
                    "title": card["name"] if card else "Удалённый пользователь",
                    "can_write": bool(other) and other not in blocked})
    return out


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


def deliver_message(conv_id: int, sender: int, text: str, kind: str = "text", media_info: dict | None = None,
                    reply_to: int | None = None) -> dict:
    """Сохраняет сообщение и рассылает его участникам в реальном времени."""
    now = db.now()
    if reply_to and not db.value("SELECT 1 FROM messages WHERE id=? AND conversation_id=?", (reply_to, conv_id)):
        reply_to = None
    with db.tx() as c:
        mid = c.execute("INSERT INTO messages (conversation_id, sender_id, text, kind, created_at, media, reply_to) VALUES (?,?,?,?,?,?,?)",
                        (conv_id, sender, text, kind, now,
                         json.dumps(media_info, ensure_ascii=False) if media_info else None, reply_to)).lastrowid
        c.execute("UPDATE conversations SET last_message_at=? WHERE id=?", (now, conv_id))
        c.execute("UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?", (mid, conv_id, sender))
    msg = _enrich([_msg_view(db.one("SELECT * FROM messages WHERE id=?", (mid,)))])[0]
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
    return JSONResponse({"items": _conv_views(ids, v)})


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
    items = _enrich([_msg_view(m) for m in reversed(rows[:PAGE])])
    senders = social.cards_by_ids({m["sender_id"] for m in items})
    return JSONResponse({"items": items, "has_more": len(rows) > PAGE,
                         "senders": {str(k): val for k, val in senders.items()}})


def _check_can_send(conv_id: int, v: int) -> None:
    _member(conv_id, v)
    conv = _conv(conv_id)
    if not conv["is_group"]:
        other = _other_id(conv_id, v)
        if not other:
            raise ApiError(403, "Собеседник удалил аккаунт")
        allowed, reason = _can_message(v, other)
        if not allowed:
            raise ApiError(403, reason)


@auth(require_verified=True)
async def send_message(request: Request):
    limit(request, "message")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _check_can_send(conv_id, v)
    data = await body(request)
    if data.get("sticker_id") is not None:
        from .stickers import sticker_for_message
        info = sticker_for_message(data["sticker_id"])
        return JSONResponse(deliver_message(conv_id, v, info["emoji"], "sticker", info, reply_to=_reply_id(data)), status_code=201)
    text = censor(clean_text(data.get("text"), config.MESSAGE_MAX_LEN))
    if not text:
        raise ApiError(400, "Пустое сообщение")
    return JSONResponse(deliver_message(conv_id, v, text, reply_to=_reply_id(data)), status_code=201)


def _reply_id(data) -> int | None:
    try:
        return int(data.get("reply_to")) if data.get("reply_to") else None
    except (TypeError, ValueError):
        return None


def _own_message(request: Request) -> dict:
    v = request.state.user["id"]
    m = db.one("SELECT * FROM messages WHERE id=?", (path_int(request),))
    if not m:
        raise ApiError(404, "Сообщение не найдено")
    _member(m["conversation_id"], v)
    return m


def _broadcast_update(m_id: int) -> dict:
    row = db.one("SELECT * FROM messages WHERE id=?", (m_id,))
    msg = _enrich([_msg_view(row)])[0]
    for uid in member_ids(row["conversation_id"]):
        hub.publish(uid, "message_update", msg)
    return msg


@auth()
async def edit_message(request: Request):
    limit(request, "message")
    v = request.state.user["id"]
    m = _own_message(request)
    if m["sender_id"] != v:
        raise ApiError(403, "Изменять можно только свои сообщения")
    if (m["kind"] or "text") not in ("text", "photo", "video", "audio"):
        raise ApiError(400, "Это сообщение нельзя изменить")
    if m["created_at"] < db.future(hours=-EDIT_WINDOW_HOURS):
        raise ApiError(400, "Изменить можно только в течение 48 часов")
    data = await body(request)
    text = censor(clean_text(data.get("text"), config.MESSAGE_MAX_LEN))
    if not text and (m["kind"] or "text") == "text":
        raise ApiError(400, "Пустое сообщение")
    db.run("UPDATE messages SET text=?, edited_at=? WHERE id=?", (text, db.now(), m["id"]))
    return JSONResponse(_broadcast_update(m["id"]))


@auth()
async def delete_message(request: Request):
    v = request.state.user["id"]
    m = _own_message(request)
    if m["sender_id"] != v:
        raise ApiError(403, "Удалять можно только свои сообщения")
    if m["kind"] == "deleted":
        return ok()
    if m.get("media") and m["kind"] != "sticker":
        try:
            info = json.loads(m["media"])
            media.delete_files(info.get("url"), info.get("poster_src"))
        except ValueError:
            pass
    db.run("UPDATE messages SET text='', media=NULL, kind='deleted', edited_at=? WHERE id=?", (db.now(), m["id"]))
    db.run("DELETE FROM message_reactions WHERE message_id=?", (m["id"],))
    return JSONResponse(_broadcast_update(m["id"]))


@auth()
async def react_message(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    m = _own_message(request)
    if m["kind"] in ("deleted", "system"):
        raise ApiError(400, "На это сообщение нельзя отреагировать")
    data = await body(request)
    emoji = str(data.get("emoji") or "")
    if emoji not in REACTION_EMOJI:
        raise ApiError(400, "Недопустимая реакция")
    current = db.value("SELECT emoji FROM message_reactions WHERE message_id=? AND user_id=?", (m["id"], v))
    if current == emoji:  # повторное нажатие снимает реакцию
        db.run("DELETE FROM message_reactions WHERE message_id=? AND user_id=?", (m["id"], v))
    else:
        db.run("DELETE FROM message_reactions WHERE message_id=? AND user_id=?", (m["id"], v))
        db.run("INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?,?,?)", (m["id"], v, emoji))
    return JSONResponse(_broadcast_update(m["id"]))


def _num(value, lo: float, hi: float) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, x)) if x == x else None


@auth(require_verified=True)
async def send_media(request: Request):
    """Фото, видео или музыка в переписке (одно вложение + подпись)."""
    limit(request, "upload")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _check_can_send(conv_id, v)
    form = await request.form(max_files=2, max_fields=10, max_part_size=1024 * 1024)
    saved_files = []
    try:
        kind = str(form.get("type") or "")
        f = form.get("file")
        if kind not in ("photo", "video", "audio", "voice") or not getattr(f, "filename", None):
            raise ApiError(400, "Прикрепите фото, видео или музыку")
        caption = censor(clean_text(str(form.get("caption") or ""), 1000))
        reply_to = _reply_id(form)
        if kind == "photo":
            saved = await media.save_upload(f, "message")
            saved_files.append(saved["path"])
            info = {"type": "photo", "url": saved["path"], "thumb": saved["thumb"], "w": saved["width"], "h": saved["height"]}
        else:
            saved = await media.save_media(f, "video" if kind == "video" else "audio")
            saved_files.append(saved["path"])
            info = {"type": kind, "url": saved["path"], "size": saved["size"], "mime": saved["mime"],
                    "duration": _num(form.get("duration"), 0, 36000)}
            if kind == "voice":
                try:
                    wave = json.loads(str(form.get("waveform") or "[]"))
                    info["waveform"] = [max(0, min(100, int(x))) for x in wave[:64]] if isinstance(wave, list) else []
                except (ValueError, TypeError):
                    info["waveform"] = []
            elif kind == "video":
                poster = form.get("poster")
                if getattr(poster, "filename", None):
                    ps = await media.save_upload(poster, "message")
                    saved_files.append(ps["path"])
                    info["poster"] = ps["thumb"]
                    info["poster_src"] = ps["path"]
                info["w"] = int(_num(form.get("width"), 1, 10000) or 0) or None
                info["h"] = int(_num(form.get("height"), 1, 10000) or 0) or None
            elif kind == "audio":
                title = clean_text(str(form.get("title") or f.filename or "Аудио"), 120)
                info["title"] = title.rsplit(".", 1)[0] if "." in title[-5:] else title
                info["artist"] = clean_text(str(form.get("artist") or ""), 80) or None
    except Exception:
        media.delete_files(*saved_files)
        raise
    finally:
        await form.close()
    return JSONResponse(deliver_message(conv_id, v, caption, kind, info, reply_to=reply_to), status_code=201)


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
SESSION_RECHECK = 60  # секунд: как часто открытый поток сверяется с сессией


def session_alive(sid: str) -> bool:
    """Сессия ещё действует: не завершена (выход, «выйти на всех устройствах»), не истекла, аккаунт не заблокирован."""
    return bool(db.value("""SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.id=? AND s.expires_at > ? AND u.is_banned = 0""", (sid, db.now())))


@auth()
async def stream(request: Request):
    v = request.state.user["id"]
    sid = request.state.session["id"]
    q, first = hub.subscribe(v)
    if first:
        hub.publish_many(social.friend_ids(v), "presence", {"user_id": v, "online": True})

    async def events():
        loop = asyncio.get_running_loop()
        checked = loop.time()
        try:
            yield {"event": "hello", "data": "{}"}
            while True:
                try:
                    event, payload = await asyncio.wait_for(q.get(), timeout=20)
                    yield {"event": event, "data": payload}
                except asyncio.TimeoutError:
                    yield {"comment": "ping"}
                # поток живёт часами — без этой проверки события продолжали бы приходить после выхода или блокировки
                if loop.time() - checked >= SESSION_RECHECK:
                    checked = loop.time()
                    if not session_alive(sid):
                        yield {"event": "session_end", "data": "{}"}
                        return
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
    Route("/api/conversations/{id:int}/media", send_media, methods=["POST"]),
    Route("/api/messages/{id:int}", edit_message, methods=["PATCH"]),
    Route("/api/messages/{id:int}", delete_message, methods=["DELETE"]),
    Route("/api/messages/{id:int}/react", react_message, methods=["POST"]),
    Route("/api/conversations/{id:int}/read", mark_read, methods=["POST"]),
    Route("/api/conversations/{id:int}/typing", typing, methods=["POST"]),
    Route("/api/stream", stream, methods=["GET"]),
]
