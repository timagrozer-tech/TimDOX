# Yarko: запуск через Passenger (создано установщиком deploy/reghost/install.sh)
import os, sys, time, threading
HOME = "__YARKO_HOME__"
VENV = HOME + "/venv"


def trace(msg):
    try:
        with open(HOME + "/passenger-trace.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S") + " pid=%s %s\n" % (os.getpid(), msg))
    except OSError:
        pass


trace("start python=%s %s argv=%s" % (sys.executable, sys.version.split()[0], sys.argv[:2]))
# Окружение с библиотеками: если у Passenger та же версия Python, что у окружения, подключаем его прямо здесь
# (без перезапуска процесса), иначе перезапускаемся интерпретатором окружения.
_want = ""
try:
    for _l in open(VENV + "/pyvenv.cfg", encoding="utf-8"):
        if _l.split("=")[0].strip() in ("version", "version_info"):
            _want = ".".join(_l.split("=", 1)[1].strip().split(".")[:2])
except OSError:
    pass
if _want and "%d.%d" % sys.version_info[:2] == _want:
    import site
    site.addsitedir("%s/lib/python%s/site-packages" % (VENV, _want))
    trace("окружение подключено без перезапуска")
elif sys.executable != VENV + "/bin/python":
    trace("перезапуск через окружение (у Passenger Python %d.%d, нужен %s)" % (sys.version_info[0], sys.version_info[1], _want))
    os.execl(VENV + "/bin/python", VENV + "/bin/python", *sys.argv)
APP = os.path.realpath(HOME + "/current")
for line in open(HOME + "/yarko.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v)
os.environ["YARKO_COMMIT"] = open(APP + "/.commit").read().strip()[:12]
sys.path.insert(0, APP)
os.chdir(APP)

# Приложение загружаем при первом запросе: Passenger запускает процесс мгновенно и не обрывает его по таймауту,
# а ошибка загрузки видна прямо на странице и в журнале.
_app, _err, _lock = None, None, threading.Lock()


def application(environ, start_response):
    global _app, _err
    if _app is None and _err is None:
        with _lock:
            if _app is None and _err is None:
                t = time.time()
                try:
                    from app.wsgi import application as real
                    _app = real
                    trace("приложение загружено за %.1f с" % (time.time() - t))
                except BaseException:
                    import traceback
                    _err = traceback.format_exc()
                    trace("ОШИБКА загрузки:\n" + _err)
                    with open(HOME + "/startup-error.log", "a", encoding="utf-8") as f:
                        f.write(_err + "\n")
    if _app is not None:
        return _app(environ, start_response)
    start_response("500 Internal Server Error", [("Content-Type", "text/plain; charset=utf-8")])
    return [("Yarko: ошибка запуска\n" + _err).encode("utf-8")]


trace("passenger_wsgi готов")
