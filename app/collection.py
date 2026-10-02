"""Коллекционные профили: редкие рамки, анимации, эффекты и питомцы.

Предметы нельзя купить — они выдаются только за активность. Условия считаются по реальным
данным (записи, реакции, комментарии, друзья, сообщения, стаж и т. д.); выданный предмет
остаётся у пользователя навсегда, даже если потом он что-то удалит.
"""
import json
import time
from datetime import datetime, timezone

from . import db
from .realtime import hub

RARITIES = {
    "common": "Обычный",
    "rare": "Редкий",
    "epic": "Эпический",
    "legendary": "Легендарный",
}
SLOTS = {"frame": "Рамки", "animation": "Анимации", "effect": "Эффекты", "pet": "Питомцы"}

STAT_LABELS = {
    "posts": ("запись", "записи", "записей", "Опубликуйте {n} {w}"),
    "likes": ("реакцию", "реакции", "реакций", "Получите {n} {w} на свои записи"),
    "comments": ("комментарий", "комментария", "комментариев", "Напишите {n} {w}"),
    "friends": ("друга", "друзей", "друзей", "Добавьте {n} {w}"),
    "messages": ("сообщение", "сообщения", "сообщений", "Отправьте {n} {w}"),
    "days": ("день", "дня", "дней", "Будьте в Круге {n} {w}"),
    "communities": ("сообщество", "сообщества", "сообществ", "Вступите в {n} {w}"),
    "events": ("мероприятие", "мероприятия", "мероприятий", "Отметьтесь «Пойду» на {n} {w}"),
}

# id, слот, название, редкость, статистика, порог, описание
ITEMS = [
    # ----- рамки
    ("frame_bronze", "frame", "Бронзовое кольцо", "common", "posts", 1, "Тёплое металлическое кольцо вокруг аватара"),
    ("frame_silver", "frame", "Серебряная орбита", "rare", "posts", 10, "Холодный блеск и искра на орбите"),
    ("frame_flora", "frame", "Цветочный венок", "rare", "comments", 20, "Венок из маленьких цветов"),
    ("frame_neon", "frame", "Неоновый контур", "epic", "friends", 10, "Пульсирующий неоновый свет"),
    ("frame_gold", "frame", "Золотой круг", "epic", "likes", 50, "Благородное золото с переливом"),
    ("frame_rainbow", "frame", "Радужная орбита", "legendary", "likes", 200, "Вращающаяся радуга — для самых любимых авторов"),
    # ----- анимации аватара
    ("anim_pulse", "animation", "Пульс", "common", "friends", 1, "Мягкие волны расходятся от аватара"),
    ("anim_glow", "animation", "Сияние", "rare", "days", 7, "Аватар мягко светится"),
    ("anim_orbit", "animation", "Спутники", "rare", "messages", 25, "Вокруг аватара кружат спутники"),
    ("anim_float", "animation", "Невесомость", "epic", "days", 30, "Аватар парит в воздухе"),
    ("anim_aurora", "animation", "Северное сияние", "epic", "communities", 3, "Переливающийся ореол"),
    ("anim_vortex", "animation", "Вихрь", "legendary", "comments", 100, "Огненный вихрь вокруг аватара"),
    # ----- эффекты страницы
    ("fx_stars", "effect", "Звездопад", "common", "comments", 1, "На обложку падают звёзды"),
    ("fx_hearts", "effect", "Сердечки", "rare", "likes", 25, "Над страницей всплывают сердечки"),
    ("fx_snow", "effect", "Снегопад", "rare", "messages", 100, "Тихий снег на вашей странице"),
    ("fx_sakura", "effect", "Лепестки сакуры", "epic", "communities", 5, "Кружащиеся лепестки"),
    ("fx_confetti", "effect", "Конфетти", "epic", "events", 3, "Праздник каждый день"),
    ("fx_fireflies", "effect", "Светлячки", "legendary", "posts", 100, "Мерцающие огоньки в темноте"),
    # ----- питомцы
    ("pet_cat", "pet", "Котёнок Мурзик", "rare", "friends", 5, "Мурлычет, когда его гладят"),
    ("pet_dog", "pet", "Щенок Бублик", "rare", "messages", 50, "Всегда рад гостям"),
    ("pet_fox", "pet", "Лисёнок Рыжик", "epic", "posts", 30, "Хитрый и любопытный"),
    ("pet_owl", "pet", "Сова Мудрейшая", "epic", "days", 60, "Знает всё обо всём"),
    ("pet_panda", "pet", "Панда Бамбук", "epic", "comments", 50, "Любит поболтать"),
    ("pet_dragon", "pet", "Дракончик Искра", "legendary", "likes", 500, "Легенда Круга"),
]
ITEM_BY_ID = {i[0]: i for i in ITEMS}

_last_check: dict[int, float] = {}


def _plural(n: int, one: str, few: str, many: str) -> str:
    a, b = abs(n) % 100, abs(n) % 10
    if 10 < a < 20:
        return many
    if 1 < b < 5:
        return few
    return one if b == 1 else many


def condition_text(stat: str, need: int) -> str:
    one, few, many, tpl = STAT_LABELS[stat]
    return tpl.format(n=need, w=_plural(need, one, few, many))


def stats(uid: int) -> dict:
    created = db.value("SELECT created_at FROM users WHERE id=?", (uid,)) or db.now()
    try:
        dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        days = max(0, (datetime.now(timezone.utc) - dt).days)
    except ValueError:
        days = 0
    return {
        "posts": db.value("SELECT count(*) FROM posts WHERE author_id=? AND is_repost=0", (uid,)) or 0,
        "likes": db.value("SELECT count(*) FROM reactions r JOIN posts p ON p.id=r.post_id WHERE p.author_id=? AND r.user_id!=?",
                          (uid, uid)) or 0,
        "comments": db.value("SELECT count(*) FROM comments WHERE author_id=?", (uid,)) or 0,
        "friends": db.value("SELECT count(*) FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)",
                            (uid, uid)) or 0,
        "messages": db.value("SELECT count(*) FROM messages WHERE sender_id=? AND kind!='system'", (uid,)) or 0,
        "days": days,
        "communities": db.value("SELECT count(*) FROM community_members WHERE user_id=? AND status='member'", (uid,)) or 0,
        "events": db.value("SELECT count(*) FROM event_members WHERE user_id=? AND status='going'", (uid,)) or 0,
    }


def owned(uid: int) -> dict[str, str]:
    return {r["item_id"]: r["earned_at"] for r in db.all("SELECT item_id, earned_at FROM user_items WHERE user_id=?", (uid,))}


def check(uid: int, force: bool = False) -> list[str]:
    """Выдаёт заработанные предметы. Возвращает id новых. Без force — не чаще раза в 20 секунд."""
    now = time.monotonic()
    if not force and now - _last_check.get(uid, float("-inf")) < 20:
        return []
    _last_check[uid] = now
    have = owned(uid)
    if len(have) == len(ITEMS):
        return []
    st = stats(uid)
    new = [i[0] for i in ITEMS if i[0] not in have and st[i[4]] >= i[5]]
    for item_id in new:
        db.run("INSERT OR IGNORE INTO user_items (user_id, item_id) VALUES (?,?)", (uid, item_id))
        cur = db.run("INSERT INTO notifications (user_id, actor_id, type, extra) VALUES (?,?,?,?)",
                     (uid, uid, "item", json.dumps({"item": item_id, "name": ITEM_BY_ID[item_id][2], "slot": ITEM_BY_ID[item_id][1],
                                                     "rarity": ITEM_BY_ID[item_id][3]}, ensure_ascii=False)))
        from .social import notification_view, push_counters
        row = db.one("SELECT * FROM notifications WHERE id=?", (cur.lastrowid,))
        hub.publish(uid, "notification", notification_view(row))
        push_counters(uid)
    if new:
        hub.publish(uid, "items", {"new": new})
    return new


def parse_equipped(value) -> dict:
    if not value:
        return {}
    try:
        data = json.loads(value)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    from .shop import AURAS, FRAMES, NAMEFX
    return {k: v for k, v in data.items()
            if (k in SLOTS and ((v in ITEM_BY_ID and ITEM_BY_ID[v][1] == k) or (k == "frame" and v in FRAMES)))
            or (k == "aura" and v in AURAS) or (k == "namefx" and v in NAMEFX)}


def item_view(item, have: dict | None = None, st: dict | None = None) -> dict:
    item_id, slot, name, rarity, stat, need, desc = item
    view = {"id": item_id, "slot": slot, "name": name, "rarity": rarity, "rarity_label": RARITIES[rarity],
            "description": desc, "condition": condition_text(stat, need)}
    if have is not None:
        view["owned"] = item_id in have
        view["earned_at"] = have.get(item_id)
    if st is not None:
        view["progress"] = min(st[stat], need)
        view["need"] = need
    return view
