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
    # анимированные (осень 2026)
    "shop_frame_ocean": ("Океан", 700, "Перекатывающиеся волны бирюзы и синевы"),
    "shop_frame_candy": ("Леденец", 900, "Сладкая спираль, которая медленно крутится"),
    "shop_frame_heart": ("Сердцебиение", 1800, "Розовое кольцо бьётся, как сердце"),
    "shop_frame_radar": ("Радар", 2200, "Зелёный луч обегает аватар по кругу"),
    "shop_frame_holo": ("Голограмма", 2500, "Радужный перелив, как у голографической наклейки"),
    "shop_frame_matrix": ("Матрица", 3000, "Бегущий зелёный код вокруг аватара"),
    "shop_frame_flame": ("Пламя", 3500, "Живой огонь: мерцает и светится"),
    "shop_frame_electro": ("Электро", 4000, "Разряды тока носятся по кольцу"),
    "shop_frame_glitch": ("Глитч", 5000, "Цифровые сбои: красно-синие сдвиги"),
    "shop_frame_goldflow": ("Жидкое золото", 8000, "Блик бежит по золотому кольцу"),
    "shop_frame_blackhole": ("Чёрная дыра", 12000, "Раскалённый диск закручивается вокруг тьмы"),
    "shop_frame_prism": ("Призма", 15000, "Самая яркая: радуга, свечение и пульс"),
}

# Ауры — анимированные частицы вокруг аватара в профиле
AURAS = {
    "aura_bubbles": ("Пузыри", 800, "Мыльные пузыри поднимаются вверх"),
    "aura_snow": ("Снегопад", 1000, "Тихо падают снежинки"),
    "aura_hearts": ("Сердечки", 1200, "Сердца всплывают и тают"),
    "aura_notes": ("Музыка", 1500, "Ноты кружат вокруг — для меломанов"),
    "aura_sparkles": ("Искры", 1800, "Звёздочки вспыхивают то тут, то там"),
    "aura_fire": ("Огненный венец", 4000, "Пламенный венец над головой"),
    "aura_planets": ("Планеты", 5000, "Три планеты на своих орбитах"),
    "aura_lightning": ("Молнии", 6000, "Сверкающие разряды и вспышки"),
    "aura_crown": ("Корона", 9000, "Парящая корона и золотые искры"),
    "aura_galaxy": ("Галактика", 12000, "Спиральная галактика вращается вокруг вас"),
}

# Эффекты имени в профиле
NAMEFX = {
    "name_flow": ("Перелив", 1500, "Цвета вашей темы плавно текут по имени"),
    "name_ice": ("Лёд", 2000, "Холодный блеск и искорки"),
    "name_neon": ("Неон", 2500, "Неоновая вывеска с лёгким мерцанием"),
    "name_rainbow": ("Радуга", 3000, "Все цвета радуги бегут по буквам"),
    "name_fire": ("Огонь", 4000, "Имя горит и светится"),
    "name_glitch": ("Глитч", 6000, "Киберсбой: буквы двоятся красным и синим"),
    "name_gold": ("Золото", 7000, "Блестящее золото с бегущим бликом"),
    "name_galaxy": ("Космос", 9000, "Звёздное небо внутри букв"),
}

NEW_ITEMS = {k for k in list(FRAMES)[6:]} | set(AURAS) | set(NAMEFX) | {
    "title_legend", "title_cyber", "title_star", "title_fire", "title_memes", "title_agent", "title_pixel", "title_guardian"}

RARITY = (("legendary", "Легендарный", 8000), ("epic", "Эпический", 3000), ("rare", "Редкий", 1000), ("common", "Обычный", 0))


def rarity(price: int) -> tuple[str, str]:
    for key, label, floor in RARITY:
        if price >= floor:
            return key, label
    return "common", "Обычный"
TITLES = {
    "title_dreamer": ("Мечтатель", 1000),
    "title_traveler": ("Путешественник", 1000),
    "title_coffee": ("Кофеман", 1200),
    "title_owl": ("Ночная сова", 1500),
    "title_architect": ("Архитектор", 2500),
    "title_stargazer": ("Звездочёт", 5000),
    "title_pixel": ("Пиксель-мастер", 1800),
    "title_memes": ("Король мемов", 2000),
    "title_agent": ("Тайный агент", 2500),
    "title_fire": ("Хранитель огня", 3500),
    "title_cyber": ("Киберпанк", 4000),
    "title_guardian": ("Страж Круга", 5500),
    "title_star": ("Звезда Круга", 6000),
    "title_legend": ("Легенда", 10000),
}
# анимированный стиль плашки титула
TITLE_STYLE = {"title_stargazer": "stars", "title_architect": "blueprint", "title_pixel": "pixel", "title_memes": "bounce",
               "title_agent": "agent", "title_fire": "fire", "title_cyber": "cyber", "title_guardian": "shield",
               "title_star": "rainbow", "title_legend": "gold"}
GIFTS = {
    "gift_rose": ("Роза", "🌹", 20),
    "gift_coffee": ("Кофе", "☕", 30),
    "gift_bear": ("Мишка", "🧸", 100),
    "gift_cake": ("Торт", "🎂", 150),
    "gift_rocket": ("Ракета", "🚀", 500),
    "gift_diamond": ("Бриллиант", "💎", 1000),
    "gift_crown": ("Корона", "👑", 3000),
    "gift_tulip": ("Тюльпаны", "🌷", 25),
    "gift_cookie": ("Печенька", "🍪", 15),
    "gift_cat": ("Котик", "🐱", 80),
    "gift_balloon": ("Шарик", "🎈", 40),
    "gift_star": ("Звезда", "🌟", 250),
    "gift_unicorn": ("Единорог", "🦄", 700),
    "gift_trophy": ("Кубок", "🏆", 1500),
    "gift_planet": ("Планета", "🪐", 5000),
}


# Стикеры: оформление панели, анимация её открытия и витрина коллекции в профиле — только внешний вид
SP_THEMES = {
    "sp_theme_paper": ("Бумага", 400, "Тёплая светлая бумага с мягкой тенью"),
    "sp_theme_midnight": ("Полночь", 500, "Глубокий синий с едва заметными звёздами"),
    "sp_theme_aurora": ("Аврора", 700, "Зелёно-фиолетовое сияние за стеклом"),
    "sp_theme_sakura": ("Сакура", 800, "Розовые лепестки и светлое стекло"),
    "sp_theme_neon": ("Неон", 1200, "Тёмное стекло с неоновой подсветкой"),
    "sp_theme_holo": ("Голограмма", 2500, "Радужный перелив, как у голографической наклейки"),
}
SP_OPEN = {
    "sp_open_bloom": ("Распускание", 500, "Панель раскрывается, как цветок"),
    "sp_open_cards": ("Веер", 800, "Стикеры разлетаются веером"),
    "sp_open_warp": ("Варп", 1200, "Прыжок из гиперпространства"),
    "sp_open_spark": ("Искры", 1500, "Открывается с россыпью искр"),
}
SHOWCASES = {
    "showcase_glass": ("Стеклянная витрина", 1200, "Витрина стикеров в профиле за матовым стеклом"),
    "showcase_gold": ("Золотая витрина", 3000, "Золотая рамка и блики для вашей коллекции"),
    "showcase_holo": ("Голографическая витрина", 5000, "Переливается радугой при наведении"),
    "showcase_cosmos": ("Космическая витрина", 8000, "Коллекция парит среди звёзд"),
}
NEW_ITEMS |= set(SP_THEMES) | set(SP_OPEN) | set(SHOWCASES)


class ShopError(ValueError):
    pass


def owned(uid: int) -> set[str]:
    return {r["item_id"] for r in db.all("SELECT item_id FROM shop_items WHERE user_id=?", (uid,))}


def catalog(uid: int) -> dict:
    have = owned(uid)
    title = db.value("SELECT shop_title FROM profiles WHERE user_id=?", (uid,))
    frame = social._frame_of(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    from .collection import parse_equipped
    eq = parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))

    def card(k, name, price, desc, on, **extra):
        r, rl = rarity(price)
        return {"id": k, "name": name, "price": price, "desc": desc, "owned": k in have, "on": on, "rarity": r,
                "rarity_label": rl, "new": k in NEW_ITEMS, **extra}
    return {
        "frames": [card(k, v[0], v[1], v[2], frame == k) for k, v in FRAMES.items()],
        "auras": [card(k, v[0], v[1], v[2], eq.get("aura") == k) for k, v in AURAS.items()],
        "names": [card(k, v[0], v[1], v[2], eq.get("namefx") == k) for k, v in NAMEFX.items()],
        "titles": [card(k, v[0], v[1], "Под именем в профиле", title == k, style=TITLE_STYLE.get(k)) for k, v in TITLES.items()],
        "sp_themes": [card(k, v[0], v[1], v[2], eq.get("sp_theme") == k) for k, v in SP_THEMES.items()],
        "sp_open": [card(k, v[0], v[1], v[2], eq.get("sp_open") == k) for k, v in SP_OPEN.items()],
        "showcases": [card(k, v[0], v[1], v[2], eq.get("showcase") == k) for k, v in SHOWCASES.items()],
        "gifts": [{"id": k, "name": v[0], "emoji": v[1], "price": v[2], "rarity": rarity(v[2])[0]} for k, v in GIFTS.items()],
        "kc": economy.balances(uid)["KC"],
    }


def price_of(item_id: str) -> int | None:
    for table in (FRAMES, TITLES, AURAS, NAMEFX, SP_THEMES, SP_OPEN, SHOWCASES):
        if item_id in table:
            return table[item_id][1]
    return None


SLOT_TABLE = {"aura": AURAS, "namefx": NAMEFX, "sp_theme": SP_THEMES, "sp_open": SP_OPEN, "showcase": SHOWCASES}


def equip(uid: int, slot: str, item_id: str | None) -> dict:
    """Надеть ауру или эффект имени из магазина (рамки — через /api/collection/equip, титулы — set_title)."""
    import json
    from .collection import parse_equipped
    if slot not in SLOT_TABLE:
        raise ShopError("Неизвестный слот")
    eq = parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    if item_id:
        if item_id not in SLOT_TABLE[slot]:
            raise ShopError("Такого предмета нет")
        if item_id not in owned(uid):
            raise ShopError("Сначала купите этот предмет")
        eq[slot] = item_id
    else:
        eq.pop(slot, None)
    db.run("UPDATE profiles SET equipped=? WHERE user_id=?", (json.dumps(eq) if eq else None, uid))
    return eq


def buy(uid: int, item_id: str) -> None:
    price = price_of(item_id)
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


def title_style(item_id: str | None) -> str | None:
    return TITLE_STYLE.get(item_id) if item_id in TITLES else None


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
