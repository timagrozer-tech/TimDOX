"""Точка входа приложения «Круг»."""
import logging
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config, db
from .api import auth_routes, messages, misc, posts, users
from .security import load_extra_banned
from .web import ApiError, load_session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("krug")

CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class SecurityMiddleware:
    """Загружает сессию, проверяет CSRF и Origin, добавляет заголовки безопасности."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        path = scope["path"]
        if path.startswith("/api/"):
            load_session(request)
            if scope["method"] not in SAFE_METHODS:
                origin = request.headers.get("origin")
                host = request.headers.get("host", "")
                if origin and origin.split("://", 1)[-1] != host and origin != config.APP_URL:
                    return await self._reject(scope, receive, send, "Запрос с чужого сайта отклонён")
                session = request.state.session
                if session and request.headers.get("x-csrf-token") != session["csrf"]:
                    return await self._reject(scope, receive, send, "Сессия устарела, обновите страницу")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers += [
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"x-frame-options", b"DENY"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                ]
                if not path.startswith("/api/"):
                    headers.append((b"content-security-policy", CSP.encode()))
                if path.startswith("/api/"):
                    headers.append((b"cache-control", b"no-store"))
            await send(message)

        await self.app(scope, receive, send_wrapper)

    @staticmethod
    async def _reject(scope, receive, send, message):
        resp = JSONResponse({"error": message, "code": "csrf"}, status_code=403)
        await resp(scope, receive, send)


async def api_error(request: Request, exc: ApiError):
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


async def http_error(request: Request, exc: HTTPException):
    if request.url.path.startswith("/api/"):
        text = {404: "Не найдено", 405: "Метод не поддерживается"}.get(exc.status_code, exc.detail)
        return JSONResponse({"error": text}, status_code=exc.status_code)
    if exc.status_code == 404:
        return FileResponse(config.STATIC_DIR / "index.html", status_code=200)
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


async def server_error(request: Request, exc: Exception):
    log.exception("Необработанная ошибка: %s %s", request.method, request.url.path)
    return JSONResponse({"error": "Внутренняя ошибка сервера. Попробуйте ещё раз."}, status_code=500)


async def spa(request: Request):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    return FileResponse(config.STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


async def health(request: Request):
    db.value("SELECT 1")
    return JSONResponse({"status": "ok"})


@asynccontextmanager
async def lifespan(app):
    db.connect()
    load_extra_banned(config.DATA_DIR / "banned_words.txt")
    log.info("«%s» запущен: %s", config.APP_NAME, config.APP_URL)
    yield


routes = [
    Route("/api/health", health),
    *auth_routes.routes, *posts.routes, *users.routes, *messages.routes, *misc.routes,
    Mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static"),
    Mount("/uploads", StaticFiles(directory=config.UPLOAD_DIR, check_dir=False), name="uploads"),
    Route("/{path:path}", spa, methods=["GET"]),
]

app = Starlette(
    debug=False,
    routes=routes,
    middleware=[],
    exception_handlers={ApiError: api_error, HTTPException: http_error, Exception: server_error},
    lifespan=lifespan,
)
app = SecurityMiddleware(app)
