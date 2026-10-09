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


_req_queue: list = []
_req_lock = threading.Lock()
PG_URLS = os.environ.get("DATABASE_URL", "").split()  # прежняя база: журнал запросов и запасная копия


def _local_db() -> None:
    """База на самом хостинге (docs/adr/0001): SQLite в DATA_DIR. При первом запуске — копия из PostgreSQL."""
    from pathlib import Path
    if os.environ.get("YARKO_LOCAL_DB", "1") == "0":
        return
    target = Path(os.environ.get("DATA_DIR", "data")) / "yarko.db"
    urls = os.environ.get("DATABASE_URL", "").split()
    if not target.exists():
        if not urls:
            return
        from app.db import sqlite3 as _sq
        if _sq.sqlite_version_info < (3, 35, 0):  # слишком старая SQLite и нет pysqlite3 — остаёмся на PostgreSQL
            _req_queue.append(("SYS", "/__db-local-skip-old-sqlite", 500, 0, "", _sq.sqlite_version, os.getpid()))
            return
        import time as _t
        t0 = _t.time()
        try:
            from app import dbcopy
            dbcopy.ensure_local(target, urls, log=lambda m: print("Yarko: " + m, file=sys.stderr))
            _req_queue.append(("SYS", "/__db-local-ready", 200, int((_t.time() - t0) * 1000), "", "", os.getpid()))
        except Exception as e:  # noqa: BLE001 — копия не удалась: работаем с прежней базой, попробуем при следующем запуске
            print(f"Yarko: локальная база не создана, остаюсь на PostgreSQL: {e!r}", file=sys.stderr)
            _req_queue.append(("SYS", "/__db-local-failed", 500, int((_t.time() - t0) * 1000), "", repr(e)[:120], os.getpid()))
            return
        if not target.exists():
            return
    os.environ["DATABASE_URL"] = ""
    os.environ["DB_PATH"] = str(target)
    if "app.db" in sys.modules:  # модуль уже загружен копированием — переключаем его на локальный файл
        from app import config, db
        db.DATABASE_URLS, db.DATABASE_URL, db.IS_PG = [], "", False
        db._conn = None
        config.DB_PATH = target


_local_db()

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

def _turn_report() -> None:
    """Раз при запуске: доступны ли ретрансляторы звонков из сети хостинга (результат — в журнал запросов)"""
    import time as _t
    _t.sleep(20)
    try:
        from app import turncheck
        from app.api.calls import ice_servers
        for url, res in turncheck.check_all(ice_servers(0)):
            _req_queue.append(("SYS", "/__turn-check", 200 if res == "ok" else 500, 0, url[:120], res[:120], os.getpid()))
        import socket
        for host, port in (("turn.cloudflare.com", 3478), ("turn.cloudflare.com", 443), ("relay1.expressturn.com", 3478)):
            t0 = _t.time()
            try:
                socket.create_connection((host, port), timeout=6).close()
                res = "tcp ok"
            except OSError as e:
                res = f"tcp fail: {e}"
            _req_queue.append(("SYS", "/__turn-reach", 200 if res == "tcp ok" else 500, int((_t.time() - t0) * 1000),
                               f"{host}:{port}", res[:120], os.getpid()))
    except Exception as e:  # noqa: BLE001
        _req_queue.append(("SYS", "/__turn-check", 500, 0, "", repr(e)[:120], os.getpid()))


def _become_leader() -> None:
    from app import selfupdate
    selfupdate.start()
    threading.Thread(target=_turn_report, name="turn-check", daemon=True).start()


if LEADER:
    _become_leader()
else:
    def _wait_leadership():
        # прежний ведущий процесс мог завершиться (перезапуск, простой): тогда фоновые задачи и самообновление
        # берёт на себя этот процесс — иначе после перезапуска их могло не остаться ни у кого
        import time as _t
        while True:
            _t.sleep(30)
            if _leader():
                os.environ["KRUG_BACKGROUND"] = "1"
                from app import main as _main
                asyncio.run_coroutine_threadsafe(_main.start_background(), _loop)
                _become_leader()
                return
    threading.Thread(target=_wait_leadership, name="leader-wait", daemon=True).start()

_DONE = object()




def _log_request(method: str, path: str, status: int, t0: float, environ) -> None:
    """Короткий журнал запросов (сутки): видно, что дошло до сайта и как быстро, — без доступа к логам хостинга.
    Пишется пачками раз в 20 секунд в PostgreSQL (Supabase), если он задан, иначе в основную базу."""
    if os.environ.get("YARKO_REQ_LOG", "1") == "0" or (path == "/api/poll" and status == 200):
        return
    import time as _t
    ip = environ.get("REMOTE_ADDR", "")
    with _req_lock:
        if len(_req_queue) < 2000:
            _req_queue.append((method, path[:200], status, int((_t.time() - t0) * 1000), ".".join(ip.split(".")[:3]) + ".*",
                               environ.get("HTTP_USER_AGENT", "")[:120], os.getpid()))


def _flush_requests() -> None:
    import time as _t
    pg = None
    while True:
        _t.sleep(20)
        with _req_lock:
            batch = _req_queue[:]
            _req_queue.clear()
        if not batch:
            continue
        try:
            from app import db
            if PG_URLS:
                if pg is None:
                    pg = db.PgConnection(PG_URLS)
                for row in batch:
                    pg.execute("INSERT INTO req_log (method, path, status, ms, ip_prefix, ua, pid) VALUES (?,?,?,?,?,?,?)", row)
                if hash(_t.time()) % 30 == 0:
                    pg.execute("DELETE FROM req_log WHERE created_at < ?", (db.future(days=-1),))
            else:
                for row in batch:
                    db.run("INSERT INTO req_log (method, path, status, ms, ip_prefix, ua, pid) VALUES (?,?,?,?,?,?,?)", row)
        except Exception:  # noqa: BLE001 — журнал не должен мешать сайту
            pg = None


threading.Thread(target=_flush_requests, name="req-log", daemon=True).start()


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
