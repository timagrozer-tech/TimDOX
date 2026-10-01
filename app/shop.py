"""Магазин оформления за KC (отдельно от «Коллекции», которая выдаётся только за достижения).

Рамки аватара, титулы под именем и подарки друзьям. Все монеты за покупки сгорают.
Ничего из магазина не влияет на охват, рейтинг или репутацию — только внешний вид."""
from . import db, economy, social

# id: (название, цена KC, описание)
FRAMES = {
    "shop_frame_mint": ("Мятная волна", 300, "Свежий бирюзово-мятный ободок"),
    "shop_frame_sunset": ("Закат", 600, "Тёплый градиент вечернего неба"),
    "shop_frame_ice": ("Лёд", 900, "Холодный голубой блеск"),
    "shop_frame_ember": ("Угли", 1500, "Тлеющий красно-оранжевый жар"),
    "shop_frame_aurora": ("Аврора", 3000, "Медленно переливается, как северное сияние"),
    "shop_frame_cosmos": ("Космос", 6000, "Вращающаяся туманность со звёздами"),
}
TITLES = {
    "title_dreamer": ("Мечтатель", 1000),
    "title_traveler": ("Путешественник", 1000),
    "title_coffee": ("Кофеман", 1200),
    "title_owl": ("Ночная сова", 1500),
    "title_architect": ("Архитектор", 2500),
    "title_stargazer": ("Звездочёт", 5000),
}
GIFTS = {
    "gift_rose": ("Роза", "🌹", 20),
    "gift_coffee": ("Кофе", "☕", 30),
    "gift_bear": ("Мишка", "🧸", 100),
    "gift_cake": ("Торт", "🎂", 150),
    "gift_rocket": ("Ракета", "🚀", 500),
    "gift_diamond": ("Бриллиант", "💎", 1000),
    "gift_crown": ("Корона", "👑", 3000),
}


class ShopError(ValueError):
    pass


def owned(uid: int) -> set[str]:
    return {r["item_id"] for r in db.all("SELECT item_id FROM shop_items WHERE user_id=?", (uid,))}


def catalog(uid: int) -> dict:
    have = owned(uid)
    title = db.value("SELECT shop_title FROM profiles WHERE user_id=?", (uid,))
    frame = social._frame_of(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    return {
        "frames": [{"id": k, "name": v[0], "price": v[1], "desc": v[2], "owned": k in have, "on": frame == k} for k, v in FRAMES.items()],
        "titles": [{"id": k, "name": v[0], "price": v[1], "owned": k in have, "on": title == k} for k, v in TITLES.items()],
        "gifts": [{"id": k, "name": v[0], "emoji": v[1], "price": v[2]} for k, v in GIFTS.items()],
        "kc": economy.balances(uid)["KC"],
    }


def buy(uid: int, item_id: str) -> None:
    price = FRAMES.get(item_id, (None, None))[1] or TITLES.get(item_id, (None, None))[1]
    if not price:
        raise ShopError("Такого предмета нет")
    if item_id in owned(uid):
        raise ShopError("Уже куплено")
    try:
        economy.spend(uid, price, "shop", ref=item_id, xp_back=False)
    except ValueError:
        raise ShopError(f"Нужно {price} KC")
    db.run("INSERT INTO shop_items (user_id, item_id, source) VALUES (?,?, 'buy')", (uid, item_id))


def set_title(uid: int, item_id: str | None) -> None:
    if item_id and (item_id not in TITLES or item_id not in owned(uid)):
        raise ShopError("Сначала купите этот титул")
    db.run("UPDATE profiles SET shop_title=? WHERE user_id=?", (item_id or None, uid))


def title_of(item_id: str | None) -> str | None:
    return TITLES[item_id][0] if item_id in TITLES else None


def gift(sender: int, recipient: int, item_id: str, note: str = "") -> dict:
    from .security import censor, clean_text
    if item_id not in GIFTS:
        raise ShopError("Такого подарка нет")
    if sender == recipient:
        raise ShopError("Себе подарок не подарить")
    if economy._count(sender, economy.today(), "_gifts")["n"] >= 20:
        raise ShopError("Не больше 20 подарков в день")
    name, emoji, price = GIFTS[item_id]
    try:
        economy.spend(sender, price, "gift", ref=item_id, xp_back=False)
    except ValueError:
        raise ShopError(f"Нужно {price} KC")
    economy._bump(sender, economy.today(), "_gifts", 1, price)
    note = censor(clean_text(note, 120))
    gid = db.run("INSERT INTO gifts (from_id, to_id, item_id, note) VALUES (?,?,?,?)", (sender, recipient, item_id, note)).lastrowid
    social.notify(recipient, sender, "gift", extra={"name": name, "emoji": emoji, "note": note})
    economy.on_event(sender, "gift")
    return {"id": gid}


def gifts_of(uid: int, limit: int = 24) -> list[dict]:
    rows = db.all("""SELECT g.id, g.item_id, g.note, g.created_at, p.username, p.name, p.avatar FROM gifts g
                     JOIN profiles p ON p.user_id = g.from_id WHERE g.to_id=? ORDER BY g.id DESC LIMIT ?""", (uid, limit))
    out = []
    for r in rows:
        if r["item_id"] in GIFTS:
            name, emoji, _ = GIFTS[r["item_id"]]
            out.append({"id": r["id"], "name": name, "emoji": emoji, "note": r["note"], "at": r["created_at"],
                        "from": {"username": r["username"], "name": r["name"], "avatar": r["avatar"]}})
    return out
