"""Чат 2.0: темы и обои для каждого чата, капсулы времени, колесо решений и «тук-тук» (касания на расстоянии)."""
import json
import secrets
from datetime import datetime, timedelta, timezone

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db
from ..realtime import hub
from ..security import censor, clean_text
from ..web import ApiError, auth, body, limit, path_int
from .messages import _check_can_send, _member, _msg_view, _enrich, deliver_message, member_ids

# ---------------------------------------------------------------- темы
WALLS = {"none", "aurora", "cosmos", "ocean", "sunset", "mint", "paper", "neon", "hearts", "bubbles", "forest", "candy", "matrix", "snow"}
ACCENTS = {"default", "violet", "blue", "cyan", "green", "lime", "amber", "orange", "red", "pink", "mono"}
BUBBLES = {"round", "sharp", "glass", "cloud", "outline"}


def clean_theme(t) -> dict | None:
    if not isinstance(t, dict):
        return None
    out = {
        "wall": t.get("wall") if t.get("wall") in WALLS else "none",
        "accent": t.get("accent") if t.get("accent") in ACCENTS else "default",
        "bubble": t.get("bubble") if t.get("bubble") in BUBBLES else "round",
        "size": max(13, min(20, int(t.get("size") or 15))) if str(t.get("size") or "15").isdigit() else 15,
        "anim": bool(t.get("anim", True)),
    }
    return out


def theme_of(conv_id: int, v: int) -> dict:
    own = db.value("SELECT theme FROM conversation_members WHERE conversation_id=? AND user_id=?", (conv_id, v))
    shared = db.value("SELECT theme FROM conversations WHERE id=?", (conv_id,))
    parse = lambda s: json.loads(s) if s else None  # noqa: E731
    return {"theme": parse(own) or parse(shared), "shared": parse(shared), "own": bool(own)}


@auth()
async def set_theme(request: Request):
    """Тема чата: только для себя или для всех участников (тогда у всех меняется вживую)."""
    limit(request, "write")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    data = await body(request)
    theme = clean_theme(data.get("theme")) if data.get("theme") else None
    raw = json.dumps(theme) if theme else None
    if data.get("shared"):
        db.run("UPDATE conversations SET theme=? WHERE id=?", (raw, conv_id))
        db.run("UPDATE conversation_members SET theme=NULL WHERE conversation_id=? AND user_id=?", (conv_id, v))
        name = db.value("SELECT name FROM profiles WHERE user_id=?", (v,)) or "Собеседник"
        for uid in member_ids(conv_id):
            if uid != v:
                hub.publish(uid, "conv_theme", {"conversation_id": conv_id, "by": name, **theme_of(conv_id, uid)})
        if theme:
            deliver_message(conv_id, v, f"🎨 {name} поменял(а) оформление чата", "system")
    else:
        db.run("UPDATE conversation_members SET theme=? WHERE conversation_id=? AND user_id=?", (raw, conv_id, v))
    return JSONResponse(theme_of(conv_id, v))


# ---------------------------------------------------------------- капсула времени
def _parse_when(s: str) -> datetime:
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, "Неверная дата открытия")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if dt < now + timedelta(minutes=1):
        raise ApiError(400, "Капсула откроется хотя бы через минуту")
    if dt > now + timedelta(days=366 * 5):
        raise ApiError(400, "Не дальше чем на 5 лет вперёд")
    return dt.astimezone(timezone.utc)


@auth(require_verified=True)
async def capsule(request: Request):
    """Сообщение, которое никто (даже сервер в ответах API) не покажет до назначенного времени."""
    limit(request, "message")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _check_can_send(conv_id, v)
    data = await body(request)
    text = censor(clean_text(data.get("text"), 2000))
    if not text:
        raise ApiError(400, "Напишите, что будет в капсуле")
    when = _parse_when(data.get("unlock_at"))
    media = {"unlock_at": when.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "sealed_text": text,
             "hint": clean_text(data.get("hint") or "", 60)}
    return JSONResponse(deliver_message(conv_id, v, "⏳ Капсула времени", "capsule", media), status_code=201)


def capsule_view(view: dict) -> dict:
    """Пока не время — содержимое вырезано (текст в базе хранится отдельно и наружу не уходит)."""
    md = view.get("media") or {}
    unlock = md.get("unlock_at") or ""
    opened = unlock and unlock <= datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    view["media"] = {"unlock_at": unlock, "hint": md.get("hint") or "", "opened": bool(opened)}
    view["text"] = md.get("sealed_text", "") if opened else "⏳ Капсула времени"
    return view


# ---------------------------------------------------------------- колесо решений
@auth(require_verified=True)
async def wheel(request: Request):
    limit(request, "message")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _check_can_send(conv_id, v)
    data = await body(request)
    opts = [censor(clean_text(str(o), 40)).strip() for o in (data.get("options") or [])]
    opts = [o for o in dict.fromkeys(opts) if o][:8]
    if len(opts) < 2:
        raise ApiError(400, "Нужно хотя бы два варианта")
    question = censor(clean_text(data.get("question") or "", 80)).strip()
    winner = secrets.randbelow(len(opts))  # выбирает сервер — у всех участников один и тот же результат
    media = {"options": opts, "winner": winner, "question": question, "turns": 4 + secrets.randbelow(3)}
    return JSONResponse(deliver_message(conv_id, v, f"🎡 {question or 'Колесо решений'}: {opts[winner]}", "wheel", media), status_code=201)


# ---------------------------------------------------------------- тук-тук
NUDGES = {"knock": "👊 Тук-тук", "heart": "💓 Сердцебиение", "hug": "🤗 Обнимашки", "fire": "🔥 Огонь", "wave": "👋 Привет-привет"}


@auth(require_verified=True)
async def nudge(request: Request):
    limit(request, "nudge")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _check_can_send(conv_id, v)
    t = str((await body(request)).get("type") or "knock")
    if t not in NUDGES:
        raise ApiError(400, "Неизвестное касание")
    return JSONResponse(deliver_message(conv_id, v, NUDGES[t], "nudge", {"type": t}), status_code=201)


@auth()
async def one_message(request: Request):
    """Одно сообщение — например, когда капсула открылась прямо на глазах."""
    v = request.state.user["id"]
    m = db.one("SELECT * FROM messages WHERE id=?", (path_int(request),))
    if not m:
        raise ApiError(404, "Сообщение не найдено")
    _member(m["conversation_id"], v)
    return JSONResponse(_enrich([_msg_view(m)])[0])


routes = [
    Route("/api/conversations/{id:int}/theme", set_theme, methods=["PATCH"]),
    Route("/api/conversations/{id:int}/capsule", capsule, methods=["POST"]),
    Route("/api/conversations/{id:int}/wheel", wheel, methods=["POST"]),
    Route("/api/conversations/{id:int}/nudge", nudge, methods=["POST"]),
    Route("/api/messages/{id:int}", one_message, methods=["GET"]),
]
