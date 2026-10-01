"""Несколько аккаунтов на одном устройстве (как в Telegram).

Активный сеанс — в обычной cookie krug_session. Остальные аккаунты устройства — в HttpOnly-cookie
krug_accounts: список токенов их сеансов. JavaScript токенов не видит; страница знает только номера слотов.
Каждый аккаунт — отдельный полноценный сеанс со своими настройками и уведомлениями.
"""
import json
import re

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, social
from ..security import token_hash
from ..web import ApiError, auth, body

ACCOUNTS_COOKIE = "krug_accounts"
MAX_ACCOUNTS = 5
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,100}$")


def read_tokens(request: Request) -> list[str]:
    try:
        raw = json.loads(request.cookies.get(ACCOUNTS_COOKIE) or "[]")
    except ValueError:
        return []
    return [t for t in raw if isinstance(t, str) and _TOKEN.match(t)][:MAX_ACCOUNTS]


def write_tokens(resp, tokens: list[str]) -> None:
    tokens = list(dict.fromkeys(tokens))[:MAX_ACCOUNTS - 1]
    if tokens:
        resp.set_cookie(ACCOUNTS_COOKIE, json.dumps(tokens, separators=(",", ":")), max_age=config.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")
    else:
        resp.delete_cookie(ACCOUNTS_COOKIE, path="/")


def _session_user(token: str) -> dict | None:
    return db.one("""SELECT s.id AS sid, u.id, p.username, p.name FROM sessions s JOIN users u ON u.id = s.user_id
                     JOIN profiles p ON p.user_id = u.id WHERE s.id=? AND s.expires_at > ? AND u.is_banned = 0""",
                  (token_hash(token), db.now()))


def alive_tokens(request: Request) -> list[tuple[str, dict]]:
    out = []
    for t in read_tokens(request):
        u = _session_user(t)
        if u:
            out.append((t, u))
    return out


def stash_current(request: Request, resp, new_user_id: int) -> None:
    """Перед входом в ещё один аккаунт откладываем текущий сеанс в список (если это другой человек)."""
    cur = request.cookies.get(config.SESSION_COOKIE) or ""
    keep = [t for t, u in alive_tokens(request) if u["id"] != new_user_id]
    cu = _session_user(cur) if _TOKEN.match(cur) else None
    if cu and cu["id"] != new_user_id:
        keep = [cur] + [t for t in keep if t != cur]
    if len(keep) >= MAX_ACCOUNTS:
        raise ApiError(400, f"На одном устройстве можно держать до {MAX_ACCOUNTS} аккаунтов — выйдите из одного из них")
    write_tokens(resp, keep)


@auth()
async def list_accounts(request: Request):
    me = request.state.user
    others = alive_tokens(request)
    ids = [me["id"]] + [u["id"] for _, u in others]
    cards = social.cards_by_ids(ids)
    def unread(uid):
        c = social.counters(uid)
        return (c.get("notifications") or 0) + (c.get("messages") or 0)
    items = [{"slot": 0, "active": True, "user": cards.get(me["id"]), "unread": 0}]
    items += [{"slot": i + 1, "active": False, "user": cards.get(u["id"]), "unread": unread(u["id"])} for i, (_, u) in enumerate(others)]
    return JSONResponse({"items": [i for i in items if i["user"]], "max": MAX_ACCOUNTS})


@auth()
async def switch(request: Request):
    data = await body(request)
    try:
        slot = int(data.get("slot"))
    except (TypeError, ValueError):
        raise ApiError(400, "Не выбран аккаунт")
    others = alive_tokens(request)
    if not 1 <= slot <= len(others):
        raise ApiError(404, "Аккаунт не найден — войдите в него заново")
    token, _ = others[slot - 1]
    cur = request.cookies.get(config.SESSION_COOKIE)
    rest = [t for t, _ in others if t != token]
    resp = JSONResponse({"ok": True})
    write_tokens(resp, ([cur] if cur else []) + rest)
    resp.set_cookie(config.SESSION_COOKIE, token, max_age=config.SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")
    return resp


@auth()
async def remove(request: Request):
    """Выйти из одного из неактивных аккаунтов этого устройства."""
    slot = int(request.path_params["slot"])
    others = alive_tokens(request)
    if not 1 <= slot <= len(others):
        raise ApiError(404, "Аккаунт не найден")
    token, _ = others[slot - 1]
    db.run("DELETE FROM sessions WHERE id=?", (token_hash(token),))
    resp = JSONResponse({"ok": True})
    write_tokens(resp, [t for t, _ in others if t != token])
    return resp


routes = [
    Route("/api/accounts", list_accounts, methods=["GET"]),
    Route("/api/accounts/switch", switch, methods=["POST"]),
    Route("/api/accounts/{slot:int}", remove, methods=["DELETE"]),
]
