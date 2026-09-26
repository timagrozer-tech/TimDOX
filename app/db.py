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
    _migrate(_conn)
    return _conn


# Новые столбцы для баз, созданных до Этапа 2: (таблица, столбец, определение)
MIGRATIONS = [
    ("posts", "community_id", "INTEGER REFERENCES communities(id) ON DELETE CASCADE"),
    ("posts", "as_community", "INTEGER NOT NULL DEFAULT 0"),
    ("posts", "circle_id", "INTEGER REFERENCES circles(id) ON DELETE SET NULL"),
    ("profiles", "school", "TEXT NOT NULL DEFAULT ''"),
    ("profiles", "school_year", "INTEGER"),
    ("profiles", "university", "TEXT NOT NULL DEFAULT ''"),
    ("profiles", "university_year", "INTEGER"),
    ("profiles", "invisible", "INTEGER NOT NULL DEFAULT 0"),
    ("profiles", "guests_seen_at", "TEXT"),
    ("conversations", "title", "TEXT"),
    ("conversations", "created_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"),
    ("messages", "kind", "TEXT NOT NULL DEFAULT 'text'"),
]
POST_MIGRATION_SQL = """
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_school ON profiles(school_year);
"""


def _migrate(c: sqlite3.Connection) -> None:
    for table, column, ddl in MIGRATIONS:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    c.executescript(POST_MIGRATION_SQL)


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
