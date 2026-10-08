"""Запуск Yarko на обычном хостинге с Passenger (Рег.ру и похожие): WSGI-обёртка вокруг ASGI-приложения.

Passenger запускает несколько процессов, каждый обслуживает один запрос за раз. Поэтому:
- в каждом процессе приложение работает в своём фоновом цикле asyncio, а WSGI-запросы передаются в него;
- реальное время — опросом через базу (REALTIME=db), постоянных соединений нет;
- фоновые задачи (уборка, публикации, бот) запускает только один процесс — тот, кто первым захватил замок;
- этот же процесс раз в несколько минут проверяет обновления на GitHub (app/selfupdate.py).
"""
import asyncio
import os
import queue
import sys
import threading

os.environ.setdefault("REALTIME", "db")
os.environ["YARKO_RUNTIME"] = "passenger"


def _leader() -> bool:
    """Замок на файле: держит его ровно один процесс, пока жив"""
    import fcntl
    from pathlib import Path
    path = Path(os.environ.get("DATA_DIR", "data")) / "leader.lock"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(path, "a+")  # noqa: SIM115 — файл держим открытым до конца процесса
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    globals()["_lock_file"] = fh
    return True


LEADER = _leader()
os.environ["KRUG_BACKGROUND"] = "1" if LEADER else "0"

from app.main import app as asgi_app  # noqa: E402 — после настройки окружения

_loop = asyncio.new_event_loop()
threading.Thread(target=_loop.run_forever, name="asgi-loop", daemon=True).start()


def _run(coro, timeout=None):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout)


async def _startup():
    """Запуск lifespan приложения (подключение к базе, фоновые задачи); остановка не нужна — процесс просто завершится"""
    inbox: asyncio.Queue = asyncio.Queue()
    started = _loop.create_future()

    async def receive():
        return await inbox.get()

    async def send(msg):
        if msg["type"] in ("lifespan.startup.complete", "lifespan.startup.failed") and not started.done():
            started.set_result(msg)

    _loop.create_task(asgi_app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, receive, send))
    await inbox.put({"type": "lifespan.startup"})
    msg = await started
    if msg["type"] == "lifespan.startup.failed":
        raise RuntimeError(msg.get("message") or "lifespan failed")


_run(_startup(), timeout=180)

if LEADER:
    from app import selfupdate
    selfupdate.start()

_DONE = object()


def _log_request(method: str, path: str, status: int, t0: float, environ) -> None:
    """Короткий журнал запросов в базе (сутки): видно, что дошло до сайта на хостинге, — без доступа к его логам"""
    if os.environ.get("YARKO_REQ_LOG", "1") == "0" or (path == "/api/poll" and status == 200):
        return
    try:
        import time as _t
        from app import db
        ip = environ.get("REMOTE_ADDR", "")
        db.run("INSERT INTO req_log (method, path, status, ms, ip_prefix, ua, pid) VALUES (?,?,?,?,?,?,?)",
               (method, path[:200], status, int((_t.time() - t0) * 1000), ".".join(ip.split(".")[:3]) + ".*",
                environ.get("HTTP_USER_AGENT", "")[:120], os.getpid()))
        if hash(t0) % 200 == 0:
            db.run("DELETE FROM req_log WHERE created_at < ?", (db.future(days=-1),))
    except Exception:  # noqa: BLE001 — журнал не должен ломать ответ
        pass


def application(environ, start_response):
    import time as _t
    t0 = _t.time()
    # тело запроса читаем целиком (загрузки до нескольких десятков МБ — это нормально для Passenger)
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    body = environ["wsgi.input"].read(length) if length > 0 else b""

    headers = []
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            headers.append((k[5:].replace("_", "-").lower().encode("latin-1"), str(v).encode("latin-1")))
    if environ.get("CONTENT_TYPE"):
        headers.append((b"content-type", environ["CONTENT_TYPE"].encode("latin-1")))
    if environ.get("CONTENT_LENGTH"):
        headers.append((b"content-length", environ["CONTENT_LENGTH"].encode("latin-1")))
    https = environ.get("HTTPS", "").lower() in ("on", "1") or environ.get("HTTP_X_FORWARDED_PROTO") == "https" \
        or environ.get("wsgi.url_scheme") == "https" or environ.get("REQUEST_SCHEME") == "https"
    path = environ.get("PATH_INFO", "") or "/"
    try:  # WSGI отдаёт путь в latin-1 — возвращаем исходные байты UTF-8 (кириллица в адресах)
        path = path.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": environ.get("REQUEST_METHOD", "GET").upper(),
        "scheme": "https" if https else "http",
        "path": path, "raw_path": environ.get("PATH_INFO", "/").encode("latin-1", "ignore"),
        "query_string": environ.get("QUERY_STRING", "").encode("latin-1", "ignore"),
        "root_path": "", "headers": headers,
        "client": (environ.get("REMOTE_ADDR", ""), int(environ.get("REMOTE_PORT") or 0)),
        "server": (environ.get("SERVER_NAME", ""), int(environ.get("SERVER_PORT") or 0)),
        "state": {},
    }

    out: queue.Queue = queue.Queue()
    disconnected = threading.Event()
    disconnect_fut = []

    async def receive():
        if not disconnect_fut:
            disconnect_fut.append(_loop.create_future())
            return {"type": "http.request", "body": body, "more_body": False}
        await disconnect_fut[0]
        return {"type": "http.disconnect"}

    async def send(msg):
        if disconnected.is_set():
            raise OSError("client disconnected")
        out.put(msg)

    async def call():
        try:
            await asgi_app(scope, receive, send)
        except Exception as e:  # noqa: BLE001
            out.put({"type": "error", "error": e})
        finally:
            out.put(_DONE)

    future = asyncio.run_coroutine_threadsafe(call(), _loop)

    def finish():
        disconnected.set()

        def _set():
            if disconnect_fut and not disconnect_fut[0].done():
                disconnect_fut[0].set_result(None)
            elif not disconnect_fut:
                disconnect_fut.append(_loop.create_future())
                disconnect_fut[0].set_result(None)
        _loop.call_soon_threadsafe(_set)

    first = out.get()
    if first is _DONE or first.get("type") != "http.response.start":
        err = first.get("error") if isinstance(first, dict) else None
        if err:
            print(f"Yarko: ошибка запроса {scope['method']} {path}: {err!r}", file=sys.stderr)
        finish()
        start_response("500 Internal Server Error", [("Content-Type", "text/plain; charset=utf-8")])
        return [b"Internal Server Error"]
    status = first["status"]
    from http import HTTPStatus
    try:
        reason = HTTPStatus(status).phrase
    except ValueError:
        reason = "Unknown"
    resp_headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in first.get("headers", [])]
    start_response(f"{status} {reason}", resp_headers)

    def body_iter():
        try:
            while True:
                msg = out.get()
                if msg is _DONE:
                    return
                if msg.get("type") == "http.response.body":
                    chunk = msg.get("body", b"")
                    if chunk:
                        yield chunk
                    if not msg.get("more_body"):
                        return
                elif msg.get("type") == "error":
                    print(f"Yarko: ошибка ответа {scope['method']} {path}: {msg['error']!r}", file=sys.stderr)
                    return
        finally:
            finish()  # клиент ушёл или ответ отдан: приложение получит http.disconnect (фоновые задачи ответа доработают)
            _log_request(scope["method"], path, status, t0, environ)

    return body_iter()
