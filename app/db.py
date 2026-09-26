"""Доступ к базе данных. Используется SQLite в режиме WAL; все запросы параметризованы."""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config

_conn: sqlite3.Connection | None = None


def _dict_factory(cursor, row):
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Открывает (или переоткрывает) соединение и применяет схему."""
    global _conn
    if _conn is not None:
        _conn.close()
    _conn = sqlite3.connect(str(path or config.DB_PATH), check_same_thread=False, isolation_level=None)
    _conn.row_factory = _dict_factory
    # встроенный lower() в SQLite понимает только латиницу — регистрируем юникодный вариант
    _conn.create_function("ulower", 1, lambda s: s.lower() if isinstance(s, str) else s, deterministic=True)
    _conn.execute("PRAGMA journal_mode = WAL")
    _conn.execute("PRAGMA foreign_keys = ON")
    _conn.execute("PRAGMA busy_timeout = 5000")
    schema = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
    _conn.executescript(schema)
    return _conn


def conn() -> sqlite3.Connection:
    if _conn is None:
        connect()
    return _conn  # type: ignore[return-value]


def all(sql: str, params: tuple | dict = ()) -> list[dict]:  # noqa: A001
    return conn().execute(sql, params).fetchall()


def one(sql: str, params: tuple | dict = ()) -> dict | None:
    return conn().execute(sql, params).fetchone()


def value(sql: str, params: tuple | dict = ()):
    row = conn().execute(sql, params).fetchone()
    return None if row is None else next(iter(row.values()))


def run(sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
    return conn().execute(sql, params)


@contextmanager
def tx():
    c = conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
    except Exception:
        c.execute("ROLLBACK")
        raise
    else:
        c.execute("COMMIT")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def future(**kwargs) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kwargs)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def placeholders(items) -> str:
    return ",".join("?" for _ in items) or "NULL"
