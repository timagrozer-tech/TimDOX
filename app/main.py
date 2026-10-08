"""Точка входа приложения QEVI."""
import asyncio
import os
import time
import logging
import re
from urllib.parse import quote
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse, FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import collection, config, db, economy, media, referrals, seo
from .api import wallet as wallet_api
from .api import city as city_api
from .api import shop_routes
from .api import assist, chatplus
from .api import market_routes
from . import tgbot, webpush
from .api import accounts, admin, auth_routes, calls, collection_routes, invites, reels, stickers, communities, events, messages, misc, music as music_api, people_extra, posts, stats, stories, users
from .security import load_extra_banned
from .world import api as world_api, engine as world_engine
from .web import ApiError, load_session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("krug")

_CDN = f" {config.SUPABASE_URL}" if config.MEDIA_STORAGE == "supabase" else ""
# обложки и потоки раздела «Музыка» приходят с серверов Audius и радиостанций — разрешаем любые https-источники картинок и звука
CSP = (f"default-src 'self'; img-src 'self' data: blob: https:{_CDN}; media-src 'self' blob: https:{_CDN}; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org; base-uri 'self'; form-action 'self'; object-src 'none'")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


# Версия сборки: когда на сервере выходит обновление, открытые вкладки перезагружаются при следующем переходе
APP_VERSION = (os.environ.get("RENDER_GIT_COMMIT") or str(int(time.time())))[:12].encode()


MAX_BODY = (max(config.MAX_VIDEO_MB, config.MAX_UPLOAD_MB * 10) + 5) * 1024 * 1024
MAX_JSON = config.MAX_JSON_KB * 1024


class BodyTooLarge(Exception):
    """Тело запроса превысило лимит прямо во время приёма (например, при передаче без Content-Length)."""


def _limited_receive(receive, cap: int):
    """Обёртка над receive: считает принятые байты и обрывает приём, как только их больше cap.
    Заголовок Content-Length клиент может не прислать или занизить — поэтому считаем сами."""
    seen = 0

    async def wrapped():
        nonlocal seen
        message = await receive()
        if message["type"] == "http.request":
            seen += len(message.get("body", b""))
            if seen > cap:
                raise BodyTooLarge()
        return message
    return wrapped


class SecurityMiddleware:
    """Загружает сессию, проверяет CSRF и Origin, ограничивает размер запроса, добавляет заголовки безопасности."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        path = scope["path"]
        if path.startswith("/api/"):
            # JSON-запросам хватает сотен килобайт; большие тела бывают только у загрузок файлов
            ctype = request.headers.get("content-type", "")
            cap = MAX_BODY if ctype.startswith("multipart/") else MAX_JSON
            try:
                length = int(request.headers.get("content-length") or 0)
            except ValueError:
                length = 0
            if length > cap:  # отклоняем сразу, до того как сервер начнёт принимать тело
                return await self._reject(scope, receive, send, "Файл слишком большой" if cap == MAX_BODY else "Слишком большой запрос", status=413)
            if scope["method"] not in SAFE_METHODS:
                receive = _limited_receive(receive, cap)
            load_session(request)
            media.current_user.set(request.state.user)
            if request.state.user:
                try:
                    referrals.mark_active(request.state.user["id"])  # дни активности — для засчёта приглашений
                except Exception:
                    log.exception("Не удалось отметить активность")
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
                    (b"permissions-policy", b"camera=(self), microphone=(self), geolocation=()"),
                ]
                if config.COOKIE_SECURE:  # сайт работает только по HTTPS — браузер запомнит это на год
                    headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                if not path.startswith("/api/"):
                    headers.append((b"content-security-policy", CSP.encode()))
                    headers.append((b"cross-origin-opener-policy", b"same-origin"))
                if path.startswith("/api/"):
                    headers.append((b"cache-control", b"no-store"))
                    headers.append((b"x-app-version", APP_VERSION))
                elif path.startswith("/static/") and path.endswith((".js", ".css")):
                    # модули подгружаются без ?v= — пусть браузер всегда сверяется с сервером (ETag), иначе после обновления
                    # на телефоне может остаться старый интерфейс
                    headers.append((b"cache-control", b"no-cache"))
            await send(message)

        await self.app(scope, receive, send_wrapper)

        # после действий пользователя проверяем, не заработал ли он новый коллекционный предмет
        user = getattr(request.state, "user", None) if path.startswith("/api/") else None
        if user and (scope["method"] not in SAFE_METHODS or path == "/api/auth/me"):
            new_items = []
            try:
                new_items = collection.check(user["id"])
            except Exception:  # награды не должны ломать основной запрос
                log.exception("Не удалось проверить коллекцию")
            try:
                world_engine.on_request(user["id"], scope["method"], path, new_items)
            except Exception:
                log.exception("Мир QEVI: ошибка отклика")

    @staticmethod
    async def _reject(scope, receive, send, message, status=403):
        resp = JSONResponse({"error": message, "code": "csrf" if status == 403 else "too_large"}, status_code=status)
        await resp(scope, receive, send)


async def api_error(request: Request, exc: ApiError):
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


async def body_too_large(request: Request, exc: BodyTooLarge):
    return JSONResponse({"error": "Слишком большой запрос", "code": "too_large"}, status_code=413)


class SelectiveGZip:
    """Сжимает текстовые ответы: JSON API, страницу приложения, JS и CSS (в 4–8 раз меньше трафика).
    Не трогает поток событий (сжатие копило бы события в буфере), фото, видео и музыку — они уже сжаты,
    а для видео сжатие сломало бы перемотку (Range)."""

    TEXT_EXT = (".js", ".css", ".svg", ".json", ".webmanifest", ".html", ".txt")

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=6)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            p = scope["path"]
            last = p.rsplit("/", 1)[-1]
            if (p.startswith("/api/") and p != "/api/stream") or p.endswith(self.TEXT_EXT) or \
                    (not p.startswith(("/uploads/", "/static/", "/api/")) and "." not in last):
                return await self.gzip(scope, receive, send)
        return await self.app(scope, receive, send)


async def http_error(request: Request, exc: HTTPException):
    if request.url.path.startswith("/api/"):
        text = {404: "Не найдено", 405: "Метод не поддерживается"}.get(exc.status_code, exc.detail)
        return JSONResponse({"error": text}, status_code=exc.status_code)
    if exc.status_code == 404:
        return HTMLResponse(seo.render(request.url.path), headers={"Cache-Control": "no-cache"})
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


async def server_error(request: Request, exc: Exception):
    if request.url.path.startswith("/api/"):
        if isinstance(exc, (ValueError, TypeError)):  # например, текст вместо числа в запросе
            log.warning("Некорректные данные: %s %s: %s", request.method, request.url.path, exc)
            return JSONResponse({"error": "Некорректные данные в запросе"}, status_code=400)
        if type(exc).__name__ in ("IntegrityError", "UniqueViolation"):  # двойное нажатие и похожие гонки
            return JSONResponse({"error": "Это действие уже выполнено"}, status_code=409)
    log.exception("Необработанная ошибка: %s %s", request.method, request.url.path)
    return JSONResponse({"error": "Внутренняя ошибка сервера. Попробуйте ещё раз."}, status_code=500)


async def spa(request: Request):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    return HTMLResponse(seo.render(request.url.path), headers={"Cache-Control": "no-cache"})


async def uploads(request: Request):
    """Раздача загруженных фото (из папки или из базы). Имена файлов случайные и не меняются — кэшируем надолго."""
    rel = request.path_params["path"]
    if ".." in rel or rel.startswith("/"):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    # файлы из сообщений (.bin) — только скачиванием, с исходным именем из ?dl=
    dl = re.sub(r'[\x00-\x1f"\\/]', "_", request.query_params.get("dl", ""))[:150].strip()
    attach = rel.endswith(".bin") or bool(dl)
    cdn = media.public_url(rel)
    if cdn:
        if attach:
            cdn += ("&" if "?" in cdn else "?") + "download=" + quote(dl or rel.rsplit("/", 1)[-1])
        return RedirectResponse(cdn, status_code=301 if not attach else 302, headers={"Cache-Control": "public, max-age=31536000, immutable"})
    ctype = media.content_type_of(rel)
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes", "ETag": f'"{rel}"'}
    if attach:
        ctype = "application/octet-stream"
        name = dl or rel.rsplit("/", 1)[-1]
        ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "file"
        headers["Content-Disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
        headers["ETag"] = f'"{rel}:{quote(name)}"' 
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    # видео и музыка: браузеры запрашивают куски (Range) — без этого не работает перемотка
    rng = request.headers.get("range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
    if m and (m.group(1) or m.group(2)) and config.MEDIA_STORAGE == "db":
        # из базы читаем только нужный кусок
        size = media.file_size(rel)
        if size is None:
            return Response(status_code=404)
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1, start + 4 * 1024 * 1024 - 1)
        else:
            start, end = max(0, size - int(m.group(2))), size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        part = media.read_range(rel, start, end)
        if part is None:
            return Response(status_code=404)
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return Response(part, status_code=206, media_type=ctype, headers=headers)
    data = media.read_file(rel)
    if data is None:
        return Response(status_code=404)
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
            referrals.qualify_pending()
            economy.settle_incoming()
            db.run("DELETE FROM econ_counters WHERE day < ?", (db.future(days=-14)[:10],))
            db.run("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))
            db.run("DELETE FROM profile_visits WHERE visited_at < ?", (db.future(days=-90),))
            db.run("DELETE FROM email_codes WHERE expires_at < ?", (db.now(),))
            db.run("DELETE FROM upload_usage WHERE day < ?", (db.future(days=-3)[:10],))
            db.run("DELETE FROM login_events WHERE created_at < ?", (db.future(days=-90),))
            db.run("DELETE FROM mfa_tickets WHERE expires_at < ?", (db.now(),))
            if removed:
                log.info("Удалено истёкших историй: %s", removed)
        except Exception:
            log.exception("Ошибка фоновой очистки")
        await asyncio.sleep(600)


async def updates_loop():
    """Официальный ИИ-профиль: после выкладки публикует новые обновления (по одному, с паузой)."""
    from . import updates
    await asyncio.sleep(25)
    while True:
        await asyncio.to_thread(updates.run_once)
        await asyncio.sleep(300)


@asynccontextmanager
async def lifespan(app):
    db.connect()
    load_extra_banned(config.DATA_DIR / "banned_words.txt")
    from .starter_stickers import ensure_starter_pack
    await asyncio.to_thread(ensure_starter_pack)
    task = asyncio.create_task(housekeeping())
    world_task = asyncio.create_task(world_engine.loop()) if world_engine.ENABLED else None
    updates_task = asyncio.create_task(updates_loop()) if os.environ.get("KRUG_UPDATES_LOOP", "1") != "0" else None
    from . import stickers2
    asyncio.get_running_loop().run_in_executor(None, tgbot.setup)
    tag_task = asyncio.create_task(stickers2.tagging_loop()) if os.environ.get("KRUG_UPDATES_LOOP", "1") != "0" else None
    log.info("«%s» запущен: %s", config.APP_NAME, config.APP_URL)
    yield
    task.cancel()
    if tag_task:
        tag_task.cancel()
    if updates_task:
        updates_task.cancel()
    if world_task:
        world_task.cancel()


routes = [
    Route("/api/health", health),
    Route("/sw.js", service_worker),
    Route("/manifest.webmanifest", manifest),
    *wallet_api.routes, *city_api.routes, *shop_routes.routes, *market_routes.routes, *invites.routes, *accounts.routes, *calls.routes, *admin.routes, *world_api.routes, *auth_routes.routes, *posts.routes, *users.routes, *messages.routes, *misc.routes,
    *stories.routes, *communities.routes, *events.routes, *people_extra.routes, *stats.routes, *music_api.routes, *collection_routes.routes, *reels.routes, *stickers.routes, *tgbot.routes, *webpush.routes, *assist.routes, *chatplus.routes,
    Mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static"),
    Route("/uploads/{path:path}", uploads, methods=["GET", "HEAD"]),
    Route("/{path:path}", spa, methods=["GET"]),
]

app = Starlette(
    debug=False,
    routes=routes,
    middleware=[],
    exception_handlers={ApiError: api_error, BodyTooLarge: body_too_large, HTTPException: http_error, Exception: server_error},
    lifespan=lifespan,
)
app = SelectiveGZip(SecurityMiddleware(app))
