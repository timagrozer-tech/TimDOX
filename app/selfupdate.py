"""Самообновление на обычном хостинге (замена автодеплоя Render): раз в несколько минут смотрим последний коммит
ветки на GitHub, скачиваем новую версию рядом со старой, ставим зависимости, проверяем импорт и переключаемся.

Раскладка (создаёт deploy/reghost/install.sh):
  $YARKO_HOME/releases/<коммит>/   — версии кода
  $YARKO_HOME/current -> releases/<коммит>
  $YARKO_HOME/venv                  — окружение Python
  $YARKO_SITE                       — корень сайта (passenger_wsgi.py, static -> current/static)
"""
import io
import json
import logging
import os
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("krug.update")

REPO = os.environ.get("YARKO_REPO", "timagrozer-tech/TimDOX")
BRANCH = os.environ.get("YARKO_BRANCH", "krug-site")
EVERY = int(os.environ.get("YARKO_UPDATE_SECONDS", "180"))
KEEP = 3


def _home() -> Path | None:
    h = os.environ.get("YARKO_HOME")
    return Path(h) if h else None


def _get(url: str, accept: str = "application/json", timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Yarko-selfupdate", "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _is_sha(s: str) -> bool:
    return len(s) == 40 and all(c in "0123456789abcdef" for c in s)


def latest_sha() -> str:
    """Последний коммит ветки. Сначала — как git ls-remote (без лимитов API: у общего хостинга один IP на многих),
    при неудаче — через API GitHub."""
    try:
        refs = _get(f"https://github.com/{REPO}.git/info/refs?service=git-upload-pack",
                    "application/x-git-upload-pack-advertisement").decode("latin-1")
        for line in refs.split("\n"):
            if line.rstrip("\x00").endswith(f" refs/heads/{BRANCH}") or f" refs/heads/{BRANCH}\x00" in line:
                sha = line.split(" ", 1)[0][-40:]
                if _is_sha(sha):
                    return sha
    except Exception:  # noqa: BLE001
        pass
    sha = _get(f"https://api.github.com/repos/{REPO}/commits/{BRANCH}", "application/vnd.github.sha").decode().strip()
    if not _is_sha(sha):
        raise ValueError(f"странный ответ GitHub: {sha[:80]}")
    return sha


def current_sha(home: Path) -> str:
    f = home / "current" / ".commit"
    return f.read_text().strip() if f.exists() else ""


def install(home: Path, sha: str) -> Path:
    """Скачивает и готовит версию sha. Возвращает папку версии (ещё не включённой)."""
    releases = home / "releases"
    target = releases / sha
    if (target / ".ready").exists():
        return target
    tmp = releases / f".{sha}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    data = _get(f"https://codeload.github.com/{REPO}/tar.gz/{sha}", "application/octet-stream", timeout=300)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            parts = Path(m.name).parts
            if len(parts) < 2 or ".." in parts or m.issym() or m.islnk() or m.isdev():
                continue
            m.name = str(Path(*parts[1:]))  # убираем верхнюю папку TimDOX-<коммит>/
            tar.extract(m, tmp)
    (tmp / ".commit").write_text(sha)
    py = str(home / "venv" / "bin" / "python")
    old_req = home / "current" / "requirements.txt"
    new_req = tmp / "requirements.txt"
    if not old_req.exists() or old_req.read_bytes() != new_req.read_bytes():
        r = subprocess.run([py, "-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", str(new_req)],
                           capture_output=True, text=True, timeout=900)
        if r.returncode:
            raise RuntimeError("pip: " + (r.stderr or r.stdout)[-800:])
    # современная SQLite для локальной базы (docs/adr/0001), если системная старая; не получилось — не страшно
    chk = subprocess.run([py, "-c", "import sqlite3,sys; sys.exit(0 if sqlite3.sqlite_version_info >= (3, 35, 0) else 1)"],
                         capture_output=True, timeout=60)
    if chk.returncode:
        chk = subprocess.run([py, "-c", "import pysqlite3"], capture_output=True, timeout=60)
        if chk.returncode:
            subprocess.run([py, "-m", "pip", "install", "-q", "--disable-pip-version-check", "pysqlite3-binary"],
                           capture_output=True, text=True, timeout=600)
    # новая версия должна хотя бы импортироваться — иначе остаёмся на старой
    env = {**os.environ, "KRUG_BACKGROUND": "0", "PYTHONDONTWRITEBYTECODE": "1"}
    r = subprocess.run([py, "-c", "import app.main"], cwd=tmp, capture_output=True, text=True, timeout=180, env=env)
    if r.returncode:
        raise RuntimeError("проверка импорта: " + (r.stderr or r.stdout)[-800:])
    (tmp / ".ready").write_text(str(int(time.time())))
    shutil.rmtree(target, ignore_errors=True)
    os.replace(tmp, target)
    return target


def sync_static(site: Path, release: Path) -> None:
    """Копия папки static в корне сайта — её отдаёт сам веб-сервер хостинга (быстро, без Python).
    Подменяем целиком: новая папка рядом, затем два переименования."""
    new, old = site / ".static.new", site / ".static.old"
    shutil.rmtree(new, ignore_errors=True)
    shutil.copytree(release / "static", new)
    cur = site / "static"
    if cur.is_symlink():
        cur.unlink()
    if cur.exists():
        shutil.rmtree(old, ignore_errors=True)
        os.replace(cur, old)
    os.replace(new, cur)
    shutil.rmtree(old, ignore_errors=True)


def activate(home: Path, target: Path) -> None:
    link = home / "current"
    tmp_link = home / ".current.tmp"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    tmp_link.symlink_to(target.relative_to(home))
    os.replace(tmp_link, link)
    site = os.environ.get("YARKO_SITE")
    if site:
        sync_static(Path(site), target)
        tpl = target / "deploy" / "reghost" / "htaccess"
        if tpl.exists():  # настройки веб-сервера тоже обновляются вместе с кодом
            tmp = Path(site) / ".htaccess.new"
            shutil.copyfile(tpl, tmp)
            os.replace(tmp, Path(site) / ".htaccess")
        (Path(site) / ".restart-app").touch()        # так перезапуск просит Рег.ру
        (Path(site) / "tmp").mkdir(exist_ok=True)
        (Path(site) / "tmp" / "restart.txt").touch()  # и так — стандартный Passenger
    keep = {target.name}
    old = sorted((p for p in (home / "releases").iterdir() if p.is_dir() and not p.name.startswith(".")),
                 key=lambda p: p.stat().st_mtime, reverse=True)
    for p in old:
        if p.name in keep:
            continue
        if len(keep) < KEEP:
            keep.add(p.name)
            continue
        shutil.rmtree(p, ignore_errors=True)


def check_once() -> str:
    home = _home()
    if not home:
        return "нет YARKO_HOME"
    sha = latest_sha()
    if sha == current_sha(home):
        return "актуально"
    target = install(home, sha)
    activate(home, target)
    (home / "update.log").open("a").write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} → {sha}\n")
    return f"обновлено до {sha[:8]}"


def _loop() -> None:
    time.sleep(30)
    fails = 0
    while True:
        try:
            result = check_once()
            if result.startswith("обновлено"):
                log.info("Самообновление: %s", result)
            fails = 0
        except Exception as e:  # noqa: BLE001
            fails += 1
            if fails in (1, 5, 20):
                log.warning("Самообновление не удалось: %s", e)
            home = _home()
            if home:
                try:
                    (home / "update.log").open("a").write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} ошибка: {e}\n")
                except OSError:
                    pass
        time.sleep(EVERY)


def start() -> None:
    if _home() and os.environ.get("YARKO_SELFUPDATE", "1") != "0":
        threading.Thread(target=_loop, name="selfupdate", daemon=True).start()


def status() -> dict:
    home = _home()
    return {"commit": current_sha(home) if home else "", "home": bool(home)}


if __name__ == "__main__":  # ручной запуск: python -m app.selfupdate
    print(json.dumps({"result": check_once()}, ensure_ascii=False))
