"""Точка входа приложения «Круг»."""
import asyncio
import logging
import re
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import RedirectResponse, FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import collection, config, db, media
from .api import auth_routes, collection_routes, reels, stickers, communities, events, messages, misc, people_extra, posts, stories, users
from .security import load_extra_banned
from .web import ApiError, load_session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("krug")

_CDN = f" {config.SUPABASE_URL}" if config.MEDIA_STORAGE == "supabase" else ""
CSP = (f"default-src 'self'; img-src 'self' data: blob:{_CDN}; media-src 'self' blob:{_CDN}; "
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

        # после действий пользователя проверяем, не заработал ли он новый коллекционный предмет
        user = getattr(request.state, "user", None) if path.startswith("/api/") else None
        if user and (scope["method"] not in SAFE_METHODS or path == "/api/auth/me"):
            try:
                collection.check(user["id"])
            except Exception:  # награды не должны ломать основной запрос
                log.exception("Не удалось проверить коллекцию")

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


async def uploads(request: Request):
    """Раздача загруженных фото (из папки или из базы). Имена файлов случайные и не меняются — кэшируем надолго."""
    rel = request.path_params["path"]
    if ".." in rel or rel.startswith("/"):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    cdn = media.public_url(rel)
    if cdn:
        return RedirectResponse(cdn, status_code=301, headers={"Cache-Control": "public, max-age=31536000, immutable"})
    data = media.read_file(rel)
    if data is None:
        return Response(status_code=404)
    ctype = media.content_type_of(rel)
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes"}
    # видео и музыка: браузеры запрашивают куски (Range) — без этого не работает перемотка
    rng = request.headers.get("range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
    if m and (m.group(1) or m.group(2)):
        size = len(data)
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
        else:
            start, end = max(0, size - int(m.group(2))), size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return Response(data[start:end + 1], status_code=206, media_type=ctype, headers=headers)
    return Response(data, media_type=ctype, headers=headers)


async def service_worker(request: Request):
    """Сервис-воркер должен лежать в корне сайта, чтобы управлять всеми страницами."""
    return FileResponse(config.STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


async def manifest(request: Request):
    return FileResponse(config.STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "public, max-age=3600"})


async def health(request: Request):
    db.value("SELECT 1")
    return JSONResponse({"status": "ok"})


async def housekeeping():
    """Раз в 10 минут удаляет истёкшие истории и старые сессии."""
    while True:
        try:
            removed = stories.cleanup_expired()
            db.run("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))
            db.run("DELETE FROM profile_visits WHERE visited_at < ?", (db.future(days=-90),))
            db.run("DELETE FROM email_codes WHERE expires_at < ?", (db.now(),))
            if removed:
                log.info("Удалено истёкших историй: %s", removed)
        except Exception:
            log.exception("Ошибка фоновой очистки")
        await asyncio.sleep(600)


@asynccontextmanager
async def lifespan(app):
    db.connect()
    load_extra_banned(config.DATA_DIR / "banned_words.txt")
    from .starter_stickers import ensure_starter_pack
    await asyncio.to_thread(ensure_starter_pack)
    task = asyncio.create_task(housekeeping())
    log.info("«%s» запущен: %s", config.APP_NAME, config.APP_URL)
    yield
    task.cancel()


routes = [
    Route("/api/health", health),
    Route("/sw.js", service_worker),
    Route("/manifest.webmanifest", manifest),
    *auth_routes.routes, *posts.routes, *users.routes, *messages.routes, *misc.routes,
    *stories.routes, *communities.routes, *events.routes, *people_extra.routes, *collection_routes.routes, *reels.routes, *stickers.routes,
    Mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static"),
    Route("/uploads/{path:path}", uploads, methods=["GET", "HEAD"]),
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
