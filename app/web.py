"""Общие инструменты HTTP-слоя: ошибки, JSON, текущий пользователь, CSRF."""
import json
from functools import wraps

from starlette.requests import Request
from starlette.responses import JSONResponse

from . import config, db
from .security import LIMITS, rate_limiter, token_hash


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        self.status = status
        self.message = message
        self.code = code


def ok(data=None, status: int = 200) -> JSONResponse:
    return JSONResponse({"ok": True} if data is None else data, status_code=status)


async def body(request: Request) -> dict:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        try:
            data = await request.json()
        except json.JSONDecodeError:
            raise ApiError(400, "Некорректный JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Ожидался объект JSON")
        return data
    return {}


def client_ip(request: Request) -> str:
    """Настоящий адрес посетителя. Первый адрес в X-Forwarded-For присылает сам клиент и может его подделать,
    поэтому ему не доверяем: на Render адрес берётся из заголовков Cloudflare, которые тот перезаписывает
    на каждом запросе, а в остальных случаях — из последних TRUSTED_PROXY_HOPS адресов цепочки."""
    h = request.headers
    if config.ON_RENDER:
        ip = (h.get("cf-connecting-ip") or h.get("true-client-ip") or "").strip()
        if ip:
            return ip
        chain = [p.strip() for p in (h.get("x-forwarded-for") or "").split(",") if p.strip()]
        if len(chain) >= 3:  # клиент, узел Cloudflare, внутренний адрес Render
            return chain[-3]
    elif config.TRUSTED_PROXY_HOPS:
        chain = [p.strip() for p in (h.get("x-forwarded-for") or "").split(",") if p.strip()]
        if len(chain) >= config.TRUSTED_PROXY_HOPS:
            return chain[-config.TRUSTED_PROXY_HOPS]
    return request.client.host if request.client else "unknown"


def limit(request: Request, bucket: str, key_extra: str = "") -> None:
    n, window = LIMITS[bucket]
    user = getattr(request.state, "user", None)
    who = f"u{user['id']}" if user else client_ip(request)
    if not rate_limiter.hit(f"{bucket}:{who}:{key_extra}", n, window):
        raise ApiError(429, "Слишком много запросов. Попробуйте через минуту.")


def load_session(request: Request) -> None:
    """Заполняет request.state.user и request.state.session по cookie."""
    request.state.user = None
    request.state.session = None
    token = request.cookies.get(config.SESSION_COOKIE)
    if not token:
        return
    row = db.one(
        """SELECT s.id AS sid, s.csrf_token, s.expires_at, u.id, u.email, u.email_verified_at,
                  u.is_admin, u.is_banned, p.username, p.name, p.avatar, p.theme, p.default_visibility, p.appearance, p.background
           FROM sessions s JOIN users u ON u.id = s.user_id JOIN profiles p ON p.user_id = u.id
           WHERE s.id = ?""",
        (token_hash(token),),
    )
    if not row or row["expires_at"] < db.now() or row["is_banned"]:
        return
    request.state.session = {"id": row["sid"], "csrf": row["csrf_token"]}
    request.state.user = row


def auth(require_verified: bool = False):
    """Декоратор: требует вход. require_verified — требует подтверждённую почту (если включено)."""
    def deco(fn):
        @wraps(fn)
        async def wrapper(request: Request, *a, **kw):
            user = request.state.user
            if not user:
                raise ApiError(401, "Нужно войти в аккаунт", "unauthorized")
            if require_verified and config.REQUIRE_EMAIL_CONFIRM and not user["email_verified_at"]:
                raise ApiError(403, "Подтвердите e-mail, чтобы продолжить", "email_not_verified")
            return await fn(request, *a, **kw)
        return wrapper
    return deco


def int_param(request: Request, name: str, default: int | None = None) -> int | None:
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ApiError(400, f"Параметр {name} должен быть числом")


def path_int(request: Request, name: str = "id") -> int:
    try:
        return int(request.path_params[name])
    except (KeyError, ValueError):
        raise ApiError(404, "Не найдено")
