"""«Звуковое рукопожатие»: телефоны передают друг другу короткий код звуком (static/js/sound/modem.js).

Код — 32 бита: номер пользователя (22 бита) + 10 бит подписи, которая меняется каждые 5 минут. Подслушанный
когда-то код быстро «протухает», а перебором чужие коды не найти (ограничение частоты запросов).
Профиль показывается по обычным правилам: блокировки и закрытые страницы учитываются.
"""
import hashlib
import hmac
import os
import time

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, social
from ..web import ApiError, auth, limit

WINDOW = 300
UID_BITS = 22


def _key() -> bytes:
    base = os.environ.get("DATABASE_URL") or str(getattr(config, "DB_PATH", "")) or "yarko"
    return hashlib.sha256(("yarko-sound:" + base).encode()).digest()


def _mac(uid: int, window: int) -> int:
    d = hmac.new(_key(), f"{uid}:{window}".encode(), hashlib.sha256).digest()
    return int.from_bytes(d[:2], "big") & 0x3FF


def code_for(uid: int, now: float | None = None) -> int:
    w = int((now or time.time()) // WINDOW)
    return ((uid & ((1 << UID_BITS) - 1)) << 10) | _mac(uid, w)


def uid_of(code: int, now: float | None = None) -> int | None:
    if not 0 <= code < 2 ** 32:
        return None
    uid, mac = code >> 10, code & 0x3FF
    w = int((now or time.time()) // WINDOW)
    # текущее и прошлое окно — чтобы код не «сгорал» на границе пяти минут
    return uid if any(hmac.compare_digest(str(_mac(uid, w - k)), str(mac)) for k in (0, 1)) else None


@auth()
async def my_code(request: Request):
    v = request.state.user["id"]
    if v >= 1 << UID_BITS:
        raise ApiError(400, "Звуковой код пока недоступен для этого аккаунта")
    return JSONResponse({"code": code_for(v), "ttl": WINDOW - int(time.time()) % WINDOW})


@auth()
async def resolve(request: Request):
    limit(request, "soundlink")
    v = request.state.user["id"]
    try:
        code = int(request.path_params["code"])
    except (TypeError, ValueError):
        raise ApiError(404, "Код не распознан")
    uid = uid_of(code)
    if uid is None or not db.value("SELECT 1 FROM users WHERE id=? AND is_banned=0", (uid,)):
        raise ApiError(404, "Код не распознан или устарел — попросите повторить")
    if uid != v and social.blocked_between(v, uid):
        raise ApiError(404, "Код не распознан или устарел — попросите повторить")
    card = social.cards_by_ids([uid]).get(uid)
    row = db.one("SELECT city, bio FROM profiles WHERE user_id=?", (uid,)) or {}
    mutual = 0
    if uid != v:
        mine = set(social.friend_ids(v))
        mutual = len(mine & set(social.friend_ids(uid)))
    return JSONResponse({"user": {**card, "city": row.get("city") or "", "bio": (row.get("bio") or "")[:140]},
                         "relation": social.relation(v, uid), "mutual": mutual, "self": uid == v})


routes = [
    Route("/api/soundlink/me", my_code, methods=["GET"]),
    Route("/api/soundlink/{code:int}", resolve, methods=["GET"]),
]
