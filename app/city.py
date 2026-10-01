"""Город — расширение профиля (этап Э1).

Сетка 12×12. Районы растут кольцами от центра: Центр (клетки 4..7), Жилой квартал (2..9), Парковый (0..11).
Район открывается уровнем города (опыт) и населением. Население — отражение социальной жизни владельца,
его нельзя купить: друзья, подписчики, приглашённые, активные дни; предел — вместимость домов.
Монеты, потраченные на город, сгорают; за каждые 10 KC — 1 опыт."""
import json
from datetime import timedelta

from . import db, economy

GRID = 12
DISTRICTS = [
    # код, название, границы кольца (min..max), уровень, население
    ("center", "Центр", 4, 7, 1, 0),
    ("living", "Жилой квартал", 2, 9, 3, 50),
    ("park", "Парковый район", 0, 11, 8, 200),
]
# вид: название, район, цена KC, вместимость жителей, «красота», можно ли строить вручную
CATALOG = {
    "hall": ("Ратуша", "center", 0, 0, 5, False),
    "nexus": ("Nexus Core", "center", 0, 0, 5, False),
    "house": ("Дом", "center", 100, 20, 1, True),
    "road": ("Дорога", "center", 20, 0, 0, True),
    "lamp": ("Фонарь", "center", 50, 0, 1, True),
    "tree": ("Дерево", "center", 40, 0, 2, True),
    "cafe": ("Кафе", "center", 300, 0, 3, True),
    "apartment": ("Многоэтажка", "living", 600, 60, 1, True),
    "shop": ("Магазин", "living", 800, 0, 3, True),
    "school": ("Школа", "living", 1200, 0, 4, True),
    "park": ("Парк", "park", 300, 0, 4, True),
    "fountain": ("Фонтан", "park", 500, 0, 5, True),
    "pond": ("Пруд", "park", 700, 0, 6, True),
    "tower": ("Небоскрёб", "park", 5000, 200, 8, True),
}
MAX_LEVEL = 5
UPGRADE_MULT = 1.6


def district_of(x: int, y: int) -> str | None:
    if not (0 <= x < GRID and 0 <= y < GRID):
        return None
    for code, _n, lo, hi, _l, _p in DISTRICTS:
        if lo <= x <= hi and lo <= y <= hi:
            return code
    return None


def upgrade_cost(kind: str, level: int) -> int:
    """Стоимость перехода с level на level+1."""
    return int(CATALOG[kind][2] * UPGRADE_MULT ** level)


def ensure(uid: int) -> None:
    """Создаёт город при первом обращении: Ратуша и Nexus Core в центре."""
    if db.value("SELECT 1 FROM cities WHERE user_id=?", (uid,)):
        return
    with db.tx() as c:
        if c.execute("SELECT 1 FROM cities WHERE user_id=?", (uid,)).fetchone():
            return
        c.execute("INSERT INTO cities (user_id) VALUES (?)", (uid,))
        c.execute("INSERT INTO city_buildings (user_id, kind, x, y, level) VALUES (?,?,?,?,1)", (uid, "hall", 5, 5))
        c.execute("INSERT INTO city_buildings (user_id, kind, x, y, level) VALUES (?,?,?,?,1)", (uid, "nexus", 6, 6))


def _level(uid: int) -> int:
    return economy.level_for(economy.balances(uid)["XP"])["level"]


def capacity(uid: int) -> int:
    rows = db.all("SELECT kind, level FROM city_buildings WHERE user_id=?", (uid,))
    return sum(CATALOG[r["kind"]][3] * r["level"] for r in rows if r["kind"] in CATALOG)


def population(uid: int) -> dict:
    from .social import friend_ids
    friends = len(friend_ids(uid))
    followers = db.value("SELECT count(*) FROM follows WHERE followee_id=?", (uid,)) or 0
    invited = db.value("SELECT invites_qualified FROM profiles WHERE user_id=?", (uid,)) or 0
    since = (economy.datetime.now(economy.timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
    active = db.value("SELECT count(*) FROM user_active_days WHERE user_id=? AND day >= ?", (uid, since)) or 0
    want = 10 * friends + 3 * min(followers, 1000) + 50 * invited + 10 * min(active, 30)
    cap = capacity(uid)
    return {"value": min(want, cap), "want": want, "capacity": cap,
            "parts": {"friends": friends, "followers": followers, "invited": invited, "active_days": active}}


def districts(uid: int, level: int, pop: int) -> list[dict]:
    out = []
    for code, name, lo, hi, need_lvl, need_pop in DISTRICTS:
        out.append({"code": code, "name": name, "from": lo, "to": hi, "level": need_lvl, "population": need_pop,
                    "open": level >= need_lvl and pop >= need_pop})
    return out


def lights(uid: int) -> float:
    """Окна горят по активности за неделю: записи и комментарии."""
    since = db.future(days=-7)
    n = (db.value("SELECT count(*) FROM posts WHERE author_id=? AND created_at>=?", (uid, since)) or 0) * 3
    n += db.value("SELECT count(*) FROM comments WHERE author_id=? AND created_at>=?", (uid, since)) or 0
    return round(min(1.0, n / 30), 2)


def treasury(uid: int, level: int) -> dict:
    """Казна: (3 + уровень) KC в день, копится до 3 дней, забирается вручную, не больше 50 в день."""
    last = db.value("SELECT treasury_at FROM cities WHERE user_id=?", (uid,))
    per_day = min(50, 3 + level)
    now = economy.datetime.now(economy.timezone.utc)
    if not last:
        days = 1.0
    else:
        t = economy.datetime.strptime(last[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=economy.timezone.utc)
        days = min(3.0, (now - t).total_seconds() / 86400)
    return {"per_day": per_day, "ready": int(per_day * days), "max": per_day * 3}


def view(uid: int, viewer: int) -> dict:
    ensure(uid)
    lvl_info = economy.level_for(economy.balances(uid)["XP"])
    pop = population(uid)
    rows = db.all("SELECT id, kind, x, y, level FROM city_buildings WHERE user_id=? ORDER BY x + y, id", (uid,))
    city = db.one("SELECT name FROM cities WHERE user_id=?", (uid,)) or {}
    beauty = sum(CATALOG[r["kind"]][4] * r["level"] for r in rows if r["kind"] in CATALOG)
    since = db.future(days=-7)
    guests = db.all("""SELECT v.guest_id, v.action, max(v.created_at) AS at, p.username, p.name, p.avatar FROM city_visits v
                       JOIN profiles p ON p.user_id = v.guest_id WHERE v.host_id=? AND v.created_at>=?
                       GROUP BY v.guest_id, v.action, p.username, p.name, p.avatar ORDER BY at DESC LIMIT 12""", (uid, since))
    data = {
        "name": city.get("name") or "",
        "level": lvl_info, "population": pop, "beauty": beauty, "lights": lights(uid),
        "districts": districts(uid, lvl_info["level"], pop["value"]),
        "buildings": rows, "grid": GRID, "guests": guests,
        "rating": pop["value"] + beauty * 10 + lvl_info["level"] * 20,
    }
    if uid == viewer:
        data["treasury"] = treasury(uid, lvl_info["level"])
        data["catalog"] = [{"kind": k, "name": v[0], "district": v[1], "price": v[2], "capacity": v[3], "beauty": v[4]}
                           for k, v in CATALOG.items() if v[5]]
        data["kc"] = economy.balances(uid)["KC"]
    else:
        day = economy.today()
        data["visited_today"] = bool(db.value("SELECT 1 FROM city_visits WHERE host_id=? AND guest_id=? AND day=?", (uid, viewer, day)))
    return data


# ---------------------------------------------------------------- действия владельца
class CityError(ValueError):
    pass


def _cell_check(uid: int, x: int, y: int, ignore_id: int | None = None) -> str:
    d = district_of(x, y)
    if not d:
        raise CityError("Клетка за пределами города")
    lvl = _level(uid)
    pop = population(uid)["value"]
    opened = {x["code"] for x in districts(uid, lvl, pop) if x["open"]}
    if d not in opened:
        dist = next(x for x in DISTRICTS if x[0] == d)
        raise CityError(f"«{dist[1]}» откроется на {dist[4]} уровне и при населении {dist[5]}")
    busy = db.value("SELECT id FROM city_buildings WHERE user_id=? AND x=? AND y=?", (uid, x, y))
    if busy and busy != ignore_id:
        raise CityError("Клетка занята")
    return d


def build(uid: int, kind: str, x: int, y: int) -> dict:
    ensure(uid)
    if kind not in CATALOG or not CATALOG[kind][5]:
        raise CityError("Такое здание построить нельзя")
    d = _cell_check(uid, x, y)
    order = [c[0] for c in DISTRICTS]
    if order.index(d) < order.index(CATALOG[kind][1]):
        raise CityError(f"{CATALOG[kind][0]} строится в районе «{next(c[1] for c in DISTRICTS if c[0] == CATALOG[kind][1])}» и дальше")
    if db.value("SELECT count(*) FROM city_buildings WHERE user_id=?", (uid,)) >= GRID * GRID:
        raise CityError("Свободных клеток нет")
    try:
        economy.spend(uid, CATALOG[kind][2], "build", ref=kind)
    except ValueError:
        raise CityError(f"Нужно {CATALOG[kind][2]} KC")
    bid = db.run("INSERT INTO city_buildings (user_id, kind, x, y, level) VALUES (?,?,?,?,1)", (uid, kind, x, y)).lastrowid
    economy.on_event(uid, "build")
    return {"id": bid}


def upgrade(uid: int, bid: int) -> dict:
    b = db.one("SELECT * FROM city_buildings WHERE id=? AND user_id=?", (bid, uid))
    if not b or not CATALOG.get(b["kind"], (0, 0, 0, 0, 0, False))[5]:
        raise CityError("Это здание не улучшается")
    if b["level"] >= MAX_LEVEL:
        raise CityError("Максимальный уровень")
    cost = upgrade_cost(b["kind"], b["level"])
    try:
        economy.spend(uid, cost, "upgrade", ref=f"{b['kind']}#{bid}")
    except ValueError:
        raise CityError(f"Нужно {cost} KC")
    db.run("UPDATE city_buildings SET level = level + 1 WHERE id=? AND user_id=?", (bid, uid))
    economy.on_event(uid, "build")
    return {"level": b["level"] + 1}


def move(uid: int, bid: int, x: int, y: int) -> None:
    b = db.one("SELECT * FROM city_buildings WHERE id=? AND user_id=?", (bid, uid))
    if not b:
        raise CityError("Здание не найдено")
    _cell_check(uid, x, y, ignore_id=bid)
    order = [c[0] for c in DISTRICTS]
    if order.index(district_of(x, y)) < order.index(CATALOG[b["kind"]][1]):
        raise CityError("Этому зданию нужен свой район")
    db.run("UPDATE city_buildings SET x=?, y=? WHERE id=? AND user_id=?", (x, y, bid, uid))


def demolish(uid: int, bid: int) -> None:
    b = db.one("SELECT kind FROM city_buildings WHERE id=? AND user_id=?", (bid, uid))
    if not b or not CATALOG.get(b["kind"], (0, 0, 0, 0, 0, False))[5]:
        raise CityError("Это здание снести нельзя")
    db.run("DELETE FROM city_buildings WHERE id=? AND user_id=?", (bid, uid))


def collect(uid: int) -> int:
    ensure(uid)
    t = treasury(uid, _level(uid))
    if t["ready"] < 1:
        raise CityError("Казна пуста — загляните позже")
    got = economy.earn_amount(uid, "treasury", t["ready"], 50, ref=db.now()[:16])
    db.run("UPDATE cities SET treasury_at=? WHERE user_id=?", (db.now(), uid))
    return got


def rename(uid: int, name: str) -> str:
    from .security import censor, clean_text
    ensure(uid)
    name = censor(clean_text(name, 40))
    db.run("UPDATE cities SET name=? WHERE user_id=?", (name, uid))
    return name


def visit(host: int, guest: int, action: str) -> dict:
    """Гость оставляет открытку или поливает парк: гостю 5 KC (до 5 визитов в день), хозяину 2 KC."""
    from .social import friend_ids
    if host == guest:
        raise CityError("Это ваш город")
    if guest not in set(friend_ids(host)):
        raise CityError("Заходить в гости можно к друзьям")
    if action not in ("postcard", "water", "fireworks"):
        raise CityError("Неизвестное действие")
    ensure(host)
    day = economy.today()
    if db.value("SELECT 1 FROM city_visits WHERE host_id=? AND guest_id=? AND day=?", (host, guest, day)):
        raise CityError("Сегодня вы уже были в этом городе")
    db.run("INSERT INTO city_visits (host_id, guest_id, day, action) VALUES (?,?,?,?)", (host, guest, day, action))
    got = economy.earn(guest, "visit_guest", ref=f"{host}:{day}")
    economy.earn(host, "visit_host", ref=f"{guest}:{day}")
    economy.on_event(guest, "visit")
    return {"got": got}
