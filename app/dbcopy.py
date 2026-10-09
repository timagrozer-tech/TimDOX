"""Переезд базы на хостинг: копия всех таблиц из PostgreSQL (Supabase) в локальный SQLite (см. docs/adr/0001).

Копируются общие для обеих схем столбцы; служебные таблицы реального времени и журнал запросов — нет.
Копия пишется во временный файл, число строк сверяется, и только потом файл переименовывается в рабочий.
"""
import os
import time
from pathlib import Path

SKIP = {"rt_events", "rt_online", "req_log"}
PAGE = 500


def _rows(src, sql: str) -> list[dict]:
    return src.execute(sql).fetchall()


def copy_to_sqlite(src, target: Path, log=print) -> dict:
    """src — соединение с исходной базой (интерфейс как у db.PgConnection: execute(sql).fetchall() → list[dict])."""
    from . import db
    target = Path(target)
    tmp = target.with_name(target.name + ".tmp")
    for p in (tmp, Path(str(tmp) + "-wal"), Path(str(tmp) + "-shm")):
        p.unlink(missing_ok=True)
    dst = db._connect_sqlite(tmp)
    dst.execute("PRAGMA foreign_keys = OFF")
    try:
        src_cols: dict[str, set] = {}
        for r in _rows(src, "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()"):
            src_cols.setdefault(r["table_name"], set()).add(r["column_name"])
    except Exception:  # noqa: BLE001 — источник без information_schema (SQLite в тестах)
        src_cols = {}
        for r in _rows(src, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            src_cols[r["name"]] = {c["name"] for c in _rows(src, f"PRAGMA table_info({r['name']})")}
    tables = [r["name"] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
    stats, t0 = {}, time.time()
    dst.execute("BEGIN")
    for t in tables:
        if t in SKIP or t not in src_cols:
            continue
        dcols = [c["name"] for c in dst.execute(f"PRAGMA table_info({t})").fetchall()]
        cols = [c for c in dcols if c in src_cols[t]]
        if not cols:
            continue
        dst.execute(f"DELETE FROM {t}")  # схема могла вставить строки по умолчанию
        qcols = ", ".join(f'"{c}"' for c in cols)
        ins = f"INSERT INTO {t} ({qcols}) VALUES ({', '.join('?' for _ in cols)})"
        n, off = 0, 0
        # страницами — только по первичному ключу (иначе порядок неоднозначен); таблицы без ключа маленькие — целиком
        pk = [c["name"] for c in sorted(dst.execute(f"PRAGMA table_info({t})").fetchall(), key=lambda c: c["pk"]) if c["pk"] and c["name"] in cols]
        page = (40 if t == "media_files" else PAGE) if pk else 10 ** 9  # файлы — небольшими порциями (память хостинга)
        while True:
            q = f"SELECT {qcols} FROM {t}" + (f" ORDER BY {', '.join(pk)} LIMIT {page} OFFSET {off}" if pk else "")
            batch = _rows(src, q)
            if not batch:
                break
            vals = []
            for row in batch:
                v = []
                for c in cols:
                    x = row.get(c)
                    if isinstance(x, bool):
                        x = int(x)
                    elif isinstance(x, memoryview):
                        x = bytes(x)
                    v.append(x)
                vals.append(v)
            dst.executemany(ins, vals)
            n += len(batch)
            off += page
            if len(batch) < page:
                break
        stats[t] = n
    dst.execute("COMMIT")
    # защита от пустой копии (например, не та схема в источнике): пользователи должны перенестись
    src_users = _rows(src, "SELECT count(*) AS n FROM users")[0]["n"]
    if not stats.get("users") or stats["users"] != src_users:
        dst.close()
        raise RuntimeError(f"копия неполная: пользователей {stats.get('users', 0)} из {src_users}")
    # сверка: в копии ровно столько строк, сколько прочитали
    for t, n in stats.items():
        got = dst.execute(f"SELECT count(*) AS n FROM {t}").fetchone()["n"]
        if got != n:
            raise RuntimeError(f"копия таблицы {t}: {got} строк вместо {n}")
    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    dst.close()
    os.replace(tmp, target)
    for p in (Path(str(tmp) + "-wal"), Path(str(tmp) + "-shm")):
        p.unlink(missing_ok=True)
    log(f"База скопирована в {target}: таблиц {len(stats)}, строк {sum(stats.values())}, {time.time() - t0:.1f} с")
    return stats


def ensure_local(target: Path, urls: list[str], log=print) -> bool:
    """Хостинг: если локальной базы ещё нет — скопировать из PostgreSQL. Один процесс копирует, остальные ждут."""
    import fcntl
    target = Path(target)
    if target.exists():
        return True
    if not urls:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target.with_name("db-migrate.lock"), "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # ждём, пока другой процесс докопирует
        if target.exists():
            return True
        from . import db
        src = db.PgConnection(urls)
        try:
            copy_to_sqlite(src, target, log)
        finally:
            src.close()
    return True


def backup(target: Path, keep: int = 3) -> Path | None:
    """Ежедневная копия SQLite рядом с базой (sqlite backup API — безопасно при работающем сайте)"""
    target = Path(target)
    if not target.exists():
        return None
    folder = target.parent / "backups"
    folder.mkdir(exist_ok=True)
    out = folder / f"yarko-{time.strftime('%Y%m%d')}.db"
    if out.exists():
        return out
    from .db import sqlite3
    src = sqlite3.connect(str(target))
    dst = sqlite3.connect(str(out) + ".tmp")
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    os.replace(str(out) + ".tmp", out)
    for old in sorted(folder.glob("yarko-*.db"))[:-keep]:
        old.unlink(missing_ok=True)
    return out
