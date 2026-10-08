"""Голосовые и видеозвонки: сигналинг WebRTC через поток событий (SSE) и короткие POST-запросы.

Медиа идёт напрямую между участниками (P2P, сетка до 4 человек). Сервер только передаёт
offer / answer / ICE-кандидаты и служебные сигналы (микрофон, камера, реакции, запись) участникам звонка.
Для сетей, где P2P не проходит, на сервере можно задать TURN (переменные TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL).
"""
import json
import os
import secrets

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..realtime import hub
from ..web import ApiError, auth, body, limit, ok

MAX_PARTICIPANTS = 4
SIGNAL_TYPES = {"offer", "answer", "ice", "state", "reaction", "recording", "hangup"}


def ice_servers() -> list[dict]:
    # несколько независимых STUN: если один недоступен из сети собеседника, сработает другой
    servers = [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"]}]
    turn = os.environ.get("TURN_URLS", "").split()
    if turn:
        servers.append({"urls": turn, "username": os.environ.get("TURN_USERNAME", ""),
                        "credential": os.environ.get("TURN_CREDENTIAL", "")})
    return servers


def _members(conv_id: int) -> list[int]:
    return [r["user_id"] for r in db.all("SELECT user_id FROM conversation_members WHERE conversation_id=?", (conv_id,))]


def _participants(call_id: str) -> list[int]:
    return [r["user_id"] for r in db.all("SELECT user_id FROM call_participants WHERE call_id=? AND left_at IS NULL", (call_id,))]


def _call(call_id: str, v: int) -> dict:
    c = db.one("SELECT * FROM calls WHERE id=?", (call_id,))
    if not c or v not in _members(c["conversation_id"]):
        raise ApiError(404, "Звонок не найден")
    return c


def _view(c: dict) -> dict:
    parts = _participants(c["id"])
    cards = social.cards_by_ids(parts + [c["started_by"]])
    return {"id": c["id"], "conversation_id": c["conversation_id"], "video": bool(c["video"]), "started_at": c["started_at"],
            "ended_at": c["ended_at"], "caller": cards.get(c["started_by"]), "participants": [cards[p] for p in parts if p in cards]}


def _end(c: dict, reason: str = "ended") -> None:
    if c["ended_at"]:
        return
    db.run("UPDATE calls SET ended_at=? WHERE id=? AND ended_at IS NULL", (db.now(), c["id"]))
    db.run("UPDATE call_participants SET left_at=? WHERE call_id=? AND left_at IS NULL", (db.now(), c["id"]))
    hub.publish_many(_members(c["conversation_id"]), "call_end", {"call_id": c["id"], "reason": reason})


@auth()
async def start(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    try:
        conv_id = int(data.get("conversation_id"))
    except (TypeError, ValueError):
        raise ApiError(400, "Не указан диалог")
    members = _members(conv_id)
    if v not in members:
        raise ApiError(404, "Диалог не найден")
    if len(members) > MAX_PARTICIPANTS:
        raise ApiError(400, f"Групповые звонки пока до {MAX_PARTICIPANTS} человек")
    others = [m for m in members if m != v]
    if any(social.blocked_between(v, o) for o in others):
        raise ApiError(403, "Позвонить нельзя")
    active = db.one("SELECT * FROM calls WHERE conversation_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", (conv_id,))
    if active and active["started_at"] < db.future(hours=-6):  # «висящий» звонок от упавшего клиента
        _end(active, "stale")
        active = None
    if active:
        return JSONResponse({"call": _view(active), "ice_servers": ice_servers(), "existing": True})
    cid = secrets.token_urlsafe(12)
    video = bool(data.get("video"))
    db.run("INSERT INTO calls (id, conversation_id, started_by, video) VALUES (?,?,?,?)", (cid, conv_id, v, 1 if video else 0))
    db.run("INSERT INTO call_participants (call_id, user_id) VALUES (?,?)", (cid, v))
    c = db.one("SELECT * FROM calls WHERE id=?", (cid,))
    view = _view(c)
    hub.publish_many(others, "call_invite", view)
    return JSONResponse({"call": view, "ice_servers": ice_servers()}, status_code=201)


@auth()
async def join(request: Request):
    v = request.state.user["id"]
    c = _call(request.path_params["id"], v)
    if c["ended_at"]:
        raise ApiError(410, "Звонок уже завершён")
    parts = _participants(c["id"])
    if v not in parts:
        if len(parts) >= MAX_PARTICIPANTS:
            raise ApiError(400, "В звонке уже максимум участников")
        db.run("INSERT INTO call_participants (call_id, user_id) VALUES (?,?)", (c["id"], v))
        me = social.cards_by_ids([v]).get(v)
        hub.publish_many(parts, "call_join", {"call_id": c["id"], "user": me})
    return JSONResponse({"call": _view(c), "ice_servers": ice_servers(), "peers": [p for p in parts if p != v]})


@auth()
async def signal(request: Request):
    limit(request, "call_signal")
    v = request.state.user["id"]
    c = _call(request.path_params["id"], v)
    data = await body(request)
    kind = data.get("type")
    if kind not in SIGNAL_TYPES:
        raise ApiError(400, "Неизвестный сигнал")
    payload = data.get("data")
    if len(json.dumps(payload or "")) > 64_000:
        raise ApiError(413, "Слишком большой сигнал")
    parts = _participants(c["id"])
    if v not in parts:
        raise ApiError(403, "Вы не в звонке")
    to = data.get("to")
    targets = [int(to)] if to is not None else [p for p in parts if p != v]
    targets = [t for t in targets if t in parts and t != v]
    hub.publish_many(targets, "call_signal", {"call_id": c["id"], "from": v, "type": kind, "data": payload})
    return ok()


@auth()
async def leave(request: Request):
    v = request.state.user["id"]
    c = _call(request.path_params["id"], v)
    db.run("UPDATE call_participants SET left_at=? WHERE call_id=? AND user_id=? AND left_at IS NULL", (db.now(), c["id"], v))
    rest = _participants(c["id"])
    hub.publish_many(rest, "call_leave", {"call_id": c["id"], "user_id": v})
    if len(rest) <= 1 and not (len(rest) == 1 and len(_members(c["conversation_id"])) > 2):
        _end(c)
    return ok()


@auth()
async def decline(request: Request):
    v = request.state.user["id"]
    c = _call(request.path_params["id"], v)
    hub.publish_many(_participants(c["id"]), "call_decline", {"call_id": c["id"], "user_id": v})
    if len(_members(c["conversation_id"])) == 2:
        _end(c, "declined")
    return ok()


@auth()
async def ice(request: Request):
    """Серверы соединения для страницы «Проверка звонков»"""
    return JSONResponse({"ice_servers": ice_servers(), "turn": bool(os.environ.get("TURN_URLS"))})


@auth()
async def history(request: Request):
    v = request.state.user["id"]
    rows = db.all("""SELECT c.* FROM calls c JOIN conversation_members m ON m.conversation_id = c.conversation_id AND m.user_id = ?
                     ORDER BY c.started_at DESC LIMIT 50""", (v,))
    out = []
    for c in rows:
        joined = db.value("SELECT 1 FROM call_participants WHERE call_id=? AND user_id=?", (c["id"], v))
        out.append({**_view(c), "missed": not joined and c["started_by"] != v})
    return JSONResponse({"items": out})


routes = [
    Route("/api/calls", start, methods=["POST"]),
    Route("/api/calls/history", history, methods=["GET"]),
    Route("/api/calls/ice", ice, methods=["GET"]),
    Route("/api/calls/{id}/join", join, methods=["POST"]),
    Route("/api/calls/{id}/signal", signal, methods=["POST"]),
    Route("/api/calls/{id}/leave", leave, methods=["POST"]),
    Route("/api/calls/{id}/decline", decline, methods=["POST"]),
]
