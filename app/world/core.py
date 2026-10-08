"""Общие помощники Мира QEVI: персонажи, состояние мира, очередь заданий, время."""
import json
import random
from datetime import datetime, timedelta, timezone

from .. import db
from .seed import CHANNELS, ORGS, PERSONAS, persona_meta

MSK = timezone(timedelta(hours=3))
_cache: dict = {}


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def now_msk() -> datetime:
    return datetime.now(MSK)


def parse_ts(s: str) -> datetime:
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- состояние
def get(key: str, default=None):
    v = db.value("SELECT value FROM ai_state WHERE key=?", (key,))
    if v is None:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return v


def put(key: str, value) -> None:
    db.run("DELETE FROM ai_state WHERE key=?", (key,))
    db.run("INSERT INTO ai_state (key, value) VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))


def once(key: str) -> bool:
    """True только при первом вызове с этим ключом — для ежедневных и еженедельных работ."""
    if db.value("SELECT 1 FROM ai_state WHERE key=?", (key,)):
        return False
    db.run("INSERT INTO ai_state (key, value) VALUES (?, '1')", (key,))
    return True


# ---------------------------------------------------------------- персонажи и организации
def personas() -> dict[str, dict]:
    """slug → {user_id, org_id, org, name, ...meta}. Кэш на процесс (состав персонажей меняется только при деплое)."""
    if "personas" not in _cache:
        rows = db.all("""SELECT a.user_id, a.slug, a.org_id, o.slug AS org, p.name FROM ai_personas a
                         JOIN profiles p ON p.user_id=a.user_id LEFT JOIN ai_orgs o ON o.id=a.org_id""")
        out = {}
        for r in rows:
            meta = persona_meta(r["slug"]) or {}
            out[r["slug"]] = {**meta, **r}
        _cache["personas"] = out
        _cache["ids"] = {r["user_id"]: r["slug"] for r in rows}
    return _cache["personas"]


def persona_by_id(uid: int) -> dict | None:
    personas()
    slug = _cache["ids"].get(uid)
    return _cache["personas"].get(slug) if slug else None


def is_persona(uid: int) -> bool:
    personas()
    return uid in _cache["ids"]


def ids() -> set[int]:
    personas()
    return set(_cache["ids"])


def orgs() -> dict[str, dict]:
    if "orgs" not in _cache:
        _cache["orgs"] = {r["slug"]: r for r in db.all("SELECT * FROM ai_orgs")}
    return _cache["orgs"]


def org_by_id(oid: int) -> dict | None:
    return next((o for o in orgs().values() if o["id"] == oid), None)


def org_personas(org: str) -> list[dict]:
    return [p for p in personas().values() if p.get("org") == org]


def channel_owner(cslug: str) -> dict | None:
    return next((p for p in personas().values() if cslug in (p.get("channels") or [])), None)


def community_id(cslug: str) -> int | None:
    key = f"cid:{cslug}"
    if key not in _cache:
        _cache[key] = db.value("SELECT id FROM communities WHERE slug=?", (cslug,))
    return _cache[key]


def reset_cache() -> None:
    _cache.clear()


# ---------------------------------------------------------------- очередь
def schedule(persona_id: int, kind: str, payload: dict, run_at: str, source: str = "template") -> None:
    db.run("INSERT INTO ai_queue (persona_id, kind, payload, run_at, source) VALUES (?,?,?,?,?)",
           (persona_id, kind, json.dumps(payload, ensure_ascii=False), run_at, source))


def at_hour(day: datetime, hour: int) -> str:
    """Момент в указанный час по Москве + случайные минуты, чтобы персонажи не публиковались строем."""
    dt = day.astimezone(MSK).replace(hour=hour % 24, minute=random.randint(0, 50), second=random.randint(0, 59), microsecond=0)
    return iso(dt)


def soon(minutes_from: float, minutes_to: float) -> str:
    return iso(datetime.now(timezone.utc) + timedelta(minutes=random.uniform(minutes_from, minutes_to)))


def week_key(dt: datetime | None = None) -> str:
    y, w, _ = (dt or now_msk()).isocalendar()
    return f"{y}-{w:02d}"


__all__ = ["CHANNELS", "ORGS", "PERSONAS"]
