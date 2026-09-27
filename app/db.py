"""Доступ к базе данных: SQLite (по умолчанию, для разработки) или PostgreSQL (DATABASE_URL).

Запросы в коде пишутся в одном стиле — плейсхолдеры `?` или `:имя`, функции least()/greatest()/ulower(),
`INSERT OR IGNORE`, `x IS ?`. Для PostgreSQL они автоматически переводятся в его диалект.
"""
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config

# Можно указать несколько адресов через пробел — будет использован первый доступный
DATABASE_URLS = os.environ.get("DATABASE_URL", "").split()
DATABASE_URL = DATABASE_URLS[0] if DATABASE_URLS else ""
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

_conn = None


# ============================================================================
# SQLite
# ============================================================================
def _dict_factory(cursor, row):
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def _least(*a):
    vals = [x for x in a if x is not None]
    return min(vals) if vals else None


def _greatest(*a):
    vals = [x for x in a if x is not None]
    return max(vals) if vals else None


def _connect_sqlite(path) -> sqlite3.Connection:
    c = sqlite3.connect(str(path or config.DB_PATH), check_same_thread=False, isolation_level=None)
    c.row_factory = _dict_factory
    # встроенный lower() в SQLite понимает только латиницу — регистрируем юникодный вариант
    c.create_function("ulower", 1, lambda s: s.lower() if isinstance(s, str) else s, deterministic=True)
    c.create_function("least", -1, _least, deterministic=True)
    c.create_function("greatest", -1, _greatest, deterministic=True)
    c.execute("PRAGMA journal_mode = WAL")
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA busy_timeout = 5000")
    c.executescript((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
    _migrate_sqlite(c)
    return c


# Новые столбцы для SQLite-баз, созданных до Этапа 2: (таблица, столбец, определение)
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
    ("profiles", "appearance", "TEXT"),
    ("profiles", "background", "TEXT"),
    ("profiles", "equipped", "TEXT"),
    ("messages", "media", "TEXT"),
]
POST_MIGRATION_SQL = """
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_school ON profiles(school_year);
"""


def _migrate_sqlite(c: sqlite3.Connection) -> None:
    for table, column, ddl in MIGRATIONS:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    c.executescript(POST_MIGRATION_SQL)


# ============================================================================
# PostgreSQL
# ============================================================================
_NAMED = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")
_IGNORE = re.compile(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO", re.I)


def translate(sql: str, params) -> tuple[str, list]:
    """Переводит запрос из общего диалекта в PostgreSQL; возвращает SQL с $1..$n и список параметров."""
    ignore = bool(_IGNORE.match(sql))
    if ignore:
        sql = _IGNORE.sub("INSERT INTO", sql, count=1)
    sql = sql.replace("ulower(", "lower(").replace(" COLLATE NOCASE", "")
    sql = re.sub(r"\bIS\s+(\?|:[A-Za-z_]\w*)", r"IS NOT DISTINCT FROM \1", sql)
    args = []
    if isinstance(params, dict):
        def named(m):
            args.append(params[m.group(1)])
            return f"${len(args)}"
        sql = _NAMED.sub(named, sql)
    else:
        seq = list(params or ())
        parts = sql.split("?")
        out = []
        for i, part in enumerate(parts):
            out.append(part)
            if i < len(parts) - 1:
                args.append(seq[i])
                out.append(f"${len(args)}")
        sql = "".join(out)
    stripped = sql.rstrip().rstrip(";")
    is_insert = re.match(r"^\s*INSERT\s", stripped, re.I) is not None
    if ignore:
        stripped += " ON CONFLICT DO NOTHING"
    if is_insert and not re.search(r"\bRETURNING\b", stripped, re.I):
        stripped += " RETURNING *"
    return stripped, args


class _Result:
    """Минимальный аналог курсора: fetchall/fetchone, rowcount, lastrowid."""

    def __init__(self, rows, rowcount):
        self.rows = rows
        self.rowcount = rowcount
        self.lastrowid = rows[0].get("id") if rows and isinstance(rows[0], dict) else None

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class _PgPsycopg:
    """Рабочий драйвер: psycopg 3."""

    def __init__(self, url):
        import psycopg
        from psycopg.rows import dict_row
        self.conn = psycopg.connect(url, autocommit=True, row_factory=dict_row, prepare_threshold=None,
                                    connect_timeout=15)

    def execute(self, sql, args):
        # psycopg ждёт %s вместо $n; символ % в тексте запроса нужно экранировать
        q = re.sub(r"\$(\d+)", "%s", sql.replace("%", "%%")) if args else sql
        with self.conn.cursor() as cur:
            cur.execute(q, args or None)
            rows = cur.fetchall() if cur.description else []
            return _Result(rows, cur.rowcount)

    def close(self):
        self.conn.close()


class _PgLibpq:
    """Запасной драйвер без зависимостей: libpq через ctypes (для тестов, если psycopg не установлен)."""

    INT_OIDS = {20, 21, 23, 26}
    FLOAT_OIDS = {700, 701, 1700}

    def __init__(self, url):
        import ctypes
        import ctypes.util
        self.ct = ctypes
        lib = ctypes.CDLL(ctypes.util.find_library("pq") or "libpq.so.5")
        vp, cp, ci = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int
        lib.PQconnectdb.restype = vp
        lib.PQconnectdb.argtypes = [cp]
        lib.PQstatus.argtypes = [vp]
        lib.PQerrorMessage.restype = cp
        lib.PQerrorMessage.argtypes = [vp]
        lib.PQexecParams.restype = vp
        lib.PQexecParams.argtypes = [vp, cp, ci, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(cp),
                                     ctypes.POINTER(ci), ctypes.POINTER(ci), ci]
        lib.PQexec.restype = vp
        lib.PQexec.argtypes = [vp, cp]
        for fn in ("PQresultStatus", "PQntuples", "PQnfields", "PQclear"):
            getattr(lib, fn).argtypes = [vp]
        lib.PQresultErrorMessage.restype = cp
        lib.PQresultErrorMessage.argtypes = [vp]
        lib.PQfname.restype = cp
        lib.PQfname.argtypes = [vp, ci]
        lib.PQftype.restype = ctypes.c_uint
        lib.PQftype.argtypes = [vp, ci]
        lib.PQgetvalue.restype = vp
        lib.PQgetvalue.argtypes = [vp, ci, ci]
        lib.PQgetlength.argtypes = [vp, ci, ci]
        lib.PQgetisnull.argtypes = [vp, ci, ci]
        lib.PQcmdTuples.restype = cp
        lib.PQcmdTuples.argtypes = [vp]
        lib.PQfinish.argtypes = [vp]
        self.lib = lib
        self.pg = lib.PQconnectdb(url.encode())
        if lib.PQstatus(self.pg) != 0:
            raise RuntimeError(lib.PQerrorMessage(self.pg).decode(errors="replace"))

    def _check(self, res):
        status = self.lib.PQresultStatus(res)
        if status not in (1, 2):  # COMMAND_OK, TUPLES_OK
            msg = self.lib.PQresultErrorMessage(res).decode(errors="replace").strip()
            self.lib.PQclear(res)
            raise RuntimeError(msg)
        return status

    def execute(self, sql, args):
        ct, lib = self.ct, self.lib
        if not args and ";" in sql:  # скрипт из нескольких команд
            self._check(res := lib.PQexec(self.pg, sql.encode()))
            lib.PQclear(res)
            return _Result([], 0)
        n = len(args)
        types = (ct.c_uint * max(n, 1))()
        values = (ct.c_char_p * max(n, 1))()
        lengths = (ct.c_int * max(n, 1))()
        formats = (ct.c_int * max(n, 1))()
        for i, a in enumerate(args):
            if a is None:
                values[i] = None
                continue
            if isinstance(a, bool):
                types[i], v = 16, (b"t" if a else b"f")
            elif isinstance(a, int):
                types[i], v = 20, str(a).encode()
            elif isinstance(a, float):
                types[i], v = 701, repr(a).encode()
            elif isinstance(a, (bytes, bytearray, memoryview)):
                types[i], v, formats[i] = 17, bytes(a), 1
            else:
                types[i], v = 0, str(a).encode()
            values[i] = v
            lengths[i] = len(v)
        res = lib.PQexecParams(self.pg, sql.encode(), n, types, values, lengths, formats, 0)
        status = self._check(res)
        try:
            rows = []
            if status == 2:
                nf = lib.PQnfields(res)
                names = [lib.PQfname(res, j).decode() for j in range(nf)]
                oids = [lib.PQftype(res, j) for j in range(nf)]
                for r in range(lib.PQntuples(res)):
                    row = {}
                    for j in range(nf):
                        if lib.PQgetisnull(res, r, j):
                            row[names[j]] = None
                            continue
                        raw = ct.string_at(lib.PQgetvalue(res, r, j), lib.PQgetlength(res, r, j))
                        oid = oids[j]
                        if oid in self.INT_OIDS:
                            row[names[j]] = int(raw)
                        elif oid in self.FLOAT_OIDS:
                            row[names[j]] = float(raw)
                        elif oid == 16:
                            row[names[j]] = raw == b"t"
                        elif oid == 17:
                            row[names[j]] = bytes.fromhex(raw[2:].decode())
                        else:
                            row[names[j]] = raw.decode()
                    rows.append(row)
            count = lib.PQcmdTuples(res).decode()
            return _Result(rows, int(count) if count else len(rows))
        finally:
            lib.PQclear(res)

    def close(self):
        self.lib.PQfinish(self.pg)


class PgConnection:
    """Обёртка с интерфейсом, похожим на sqlite3.Connection."""

    def __init__(self, urls):
        self.urls = urls if isinstance(urls, list) else [urls]
        self.in_tx = False
        self._open()

    def _open(self):
        errors = []
        for url in self.urls:
            try:
                try:
                    self.drv = _PgPsycopg(url)
                except ImportError:
                    self.drv = _PgLibpq(url)
                if url != self.urls[0]:
                    self.urls = [url] + [u for u in self.urls if u != url]
                return
            except Exception as e:  # пробуем следующий адрес
                host = url.split("@")[-1].split("/")[0]
                errors.append(f"{host}: {e}")
        raise RuntimeError("Не удалось подключиться к базе: " + " | ".join(errors))

    def execute(self, sql, params=()):
        s = sql.strip().upper()
        if s in ("BEGIN", "BEGIN IMMEDIATE"):
            self.in_tx = True
            return self.drv.execute("BEGIN", [])
        if s in ("COMMIT", "ROLLBACK"):
            self.in_tx = False
            return self.drv.execute(s, [])
        q, args = translate(sql, params)
        try:
            return self.drv.execute(q, args)
        except Exception as e:  # соединение могло оборваться (пулер, простой) — переподключаемся один раз
            if self.in_tx or not _is_connection_error(e):
                raise
            self._open()
            return self.drv.execute(q, args)

    def executescript(self, script):
        self.drv.execute(script, [])

    def close(self):
        self.drv.close()


def _is_connection_error(e: Exception) -> bool:
    text = f"{type(e).__name__} {e}".lower()
    return any(w in text for w in ("operationalerror", "server closed", "terminat", "connection", "ssl syscall"))


def _connect_pg():
    c = PgConnection(DATABASE_URLS)
    if os.environ.get("DB_AUTO_SCHEMA", "1") == "1":
        c.executescript((Path(__file__).parent / "schema_pg.sql").read_text(encoding="utf-8"))
    return c


# ============================================================================
# Общий интерфейс
# ============================================================================
def connect(path: Path | str | None = None):
    """Открывает (или переоткрывает) соединение и применяет схему."""
    global _conn
    if _conn is not None:
        _conn.close()
    _conn = _connect_pg() if IS_PG else _connect_sqlite(path)
    return _conn


def conn():
    if _conn is None:
        connect()
    return _conn


def all(sql: str, params: tuple | dict = ()) -> list[dict]:  # noqa: A001
    return conn().execute(sql, params).fetchall()


def one(sql: str, params: tuple | dict = ()) -> dict | None:
    return conn().execute(sql, params).fetchone()


def value(sql: str, params: tuple | dict = ()):
    row = conn().execute(sql, params).fetchone()
    return None if row is None else next(iter(row.values()))


def run(sql: str, params: tuple | dict = ()):
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
