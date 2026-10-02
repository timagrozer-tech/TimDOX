"""Рынок (этап Э3): люди продают друг другу рамки и титулы из магазина за KC.

Правила: продавать можно с 14-го дня, предмет должен пролежать у владельца 7 дней; на время продажи
он уходит с аккаунта в «депозит» лота; цена в коридоре 0,5–20 справочных; за выставление сгорает 1%
(не меньше 5 KC), с продажи — 7%. Связанные аккаунты не торгуют друг с другом. Достижения, репутация,
галочки и предметы «Коллекции» не продаются никогда."""
from datetime import datetime, timedelta, timezone

from . import db, economy, shop, social

LIST_FEE, SALE_FEE = 0.01, 0.07
MAX_ACTIVE = 20
HOLD_DAYS = 7
CORRIDOR = (0.5, 20)


class MarketError(ValueError):
    pass


def item_info(item_id: str) -> dict | None:
    if item_id in shop.FRAMES:
        n, price, desc = shop.FRAMES[item_id]
        return {"id": item_id, "kind": "frame", "name": n, "base": price, "desc": desc}
    if item_id in shop.TITLES:
        n, price = shop.TITLES[item_id]
        return {"id": item_id, "kind": "title", "name": n, "base": price, "desc": "Титул под именем в профиле", "style": shop.TITLE_STYLE.get(item_id)}
    if item_id in shop.AURAS:
        n, price, desc = shop.AURAS[item_id]
        return {"id": item_id, "kind": "aura", "name": n, "base": price, "desc": desc}
    if item_id in shop.NAMEFX:
        n, price, desc = shop.NAMEFX[item_id]
        return {"id": item_id, "kind": "namefx", "name": n, "base": price, "desc": desc}
    return None


def reference_price(item_id: str) -> int:
    """Медиана сделок за 30 дней; если сделок не было — цена в магазине."""
    since = db.future(days=-30)
    prices = sorted(r["price"] for r in db.all(
        "SELECT price FROM market_listings WHERE item_id=? AND status='sold' AND closed_at>=?", (item_id, since)))
    if not prices:
        return item_info(item_id)["base"]
    m = len(prices) // 2
    return prices[m] if len(prices) % 2 else (prices[m - 1] + prices[m]) // 2


def corridor(item_id: str) -> tuple[int, int]:
    ref = reference_price(item_id)
    return max(1, int(ref * CORRIDOR[0])), int(ref * CORRIDOR[1])


def sellable(uid: int) -> list[dict]:
    """Свои предметы, которые можно выставить: купленные (или полученные) не меньше 7 дней назад."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=HOLD_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    out = []
    for r in db.all("SELECT item_id, acquired_at FROM shop_items WHERE user_id=?", (uid,)):
        info = item_info(r["item_id"])
        if not info:
            continue
        lo, hi = corridor(r["item_id"])
        ready = r["acquired_at"] <= cutoff
        out.append({**info, "ready": ready, "ready_at": r["acquired_at"], "ref": reference_price(r["item_id"]), "min": lo, "max": hi})
    return out


def create(uid: int, item_id: str, price: int) -> int:
    info = item_info(item_id)
    if not info:
        raise MarketError("Этот предмет не продаётся")
    if economy._age_days(uid) < 14 and not economy.is_admin(uid):
        raise MarketError("Продавать на рынке можно с 14-го дня после регистрации")
    row = db.one("SELECT acquired_at FROM shop_items WHERE user_id=? AND item_id=?", (uid, item_id))
    if not row:
        raise MarketError("У вас нет этого предмета")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=HOLD_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    if row["acquired_at"] > cutoff:
        raise MarketError(f"Предмет можно продать через {HOLD_DAYS} дней после получения")
    if db.value("SELECT count(*) FROM market_listings WHERE seller_id=? AND status='active'", (uid,)) >= MAX_ACTIVE:
        raise MarketError(f"Не больше {MAX_ACTIVE} лотов одновременно")
    lo, hi = corridor(item_id)
    if not (lo <= price <= hi):
        raise MarketError(f"Цена должна быть от {lo} до {hi} KC")
    fee = max(5, round(price * LIST_FEE))
    try:
        economy.spend(uid, fee, "market_fee", ref=item_id, xp_back=False)
    except ValueError:
        raise MarketError(f"Нужно {fee} KC на сбор за выставление")
    with db.tx() as c:
        c.execute("DELETE FROM shop_items WHERE user_id=? AND item_id=?", (uid, item_id))
        lid = c.execute("INSERT INTO market_listings (seller_id, item_id, price) VALUES (?,?,?)", (uid, item_id, price)).lastrowid
    # снимаем с профиля, если было надето
    if info["kind"] == "title" and db.value("SELECT shop_title FROM profiles WHERE user_id=?", (uid,)) == item_id:
        db.run("UPDATE profiles SET shop_title=NULL WHERE user_id=?", (uid,))
    if info["kind"] in ("frame", "aura", "namefx"):
        from .collection import parse_equipped
        import json
        eq = parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
        if eq.get(info["kind"]) == item_id:
            eq.pop(info["kind"])
            db.run("UPDATE profiles SET equipped=? WHERE user_id=?", (json.dumps(eq) if eq else None, uid))
    return lid


def cancel(uid: int, lid: int) -> None:
    with db.tx() as c:
        row = c.execute("SELECT * FROM market_listings WHERE id=? AND seller_id=? AND status='active'", (lid, uid)).fetchone()
        if not row:
            raise MarketError("Лот не найден")
        c.execute("UPDATE market_listings SET status='cancelled', closed_at=? WHERE id=?", (db.now(), lid))
        c.execute("INSERT INTO shop_items (user_id, item_id, source, acquired_at) VALUES (?,?, 'market_return', ?)",
                  (uid, row["item_id"], row["created_at"]))


def buy(uid: int, lid: int) -> dict:
    row = db.one("SELECT * FROM market_listings WHERE id=? AND status='active'", (lid,))
    if not row:
        raise MarketError("Лот уже продан или снят")
    seller = row["seller_id"]
    if seller == uid:
        raise MarketError("Это ваш лот")
    if economy.linked(uid, seller):
        raise MarketError("Нельзя покупать у своих же аккаунтов")
    if db.value("SELECT 1 FROM shop_items WHERE user_id=? AND item_id=?", (uid, row["item_id"])):
        raise MarketError("У вас уже есть этот предмет")
    price = row["price"]
    fee = max(1, round(price * SALE_FEE))
    try:
        with db.tx() as c:
            # лот закрывается в той же транзакции, что и оплата: двух покупателей у одного лота не бывает
            cur = c.execute("UPDATE market_listings SET status='sold', buyer_id=?, closed_at=? WHERE id=? AND status='active'",
                            (uid, db.now(), lid))
            if not cur.rowcount:
                raise MarketError("Лот уже продан")
            economy._post(c, "market", [(uid, "KC", -price), (seller, "KC", price - fee), (economy.BURN, "KC", fee)],
                          ref=f"lot{lid}", meta={"item": row["item_id"]})
            c.execute("INSERT INTO shop_items (user_id, item_id, source) VALUES (?,?, 'market')", (uid, row["item_id"]))
    except MarketError:
        raise
    except ValueError:
        raise MarketError(f"Нужно {price} KC")
    info = item_info(row["item_id"])
    social.notify(seller, uid, "market_sold", extra={"name": info["name"], "amount": price - fee})
    return {"price": price, "fee": fee}


def listings(viewer: int, kind: str | None = None, sort: str = "new", limit: int = 60) -> list[dict]:
    rows = db.all("""SELECT l.id, l.item_id, l.price, l.created_at, l.seller_id, p.username, p.name, p.avatar
                     FROM market_listings l JOIN profiles p ON p.user_id = l.seller_id
                     WHERE l.status='active' ORDER BY l.id DESC LIMIT 400""")
    out = []
    for r in rows:
        info = item_info(r["item_id"])
        if not info or (kind and info["kind"] != kind):
            continue
        out.append({"id": r["id"], "item": info, "price": r["price"], "at": r["created_at"], "mine": r["seller_id"] == viewer,
                    "ref": reference_price(r["item_id"]),
                    "seller": {"username": r["username"], "name": r["name"], "avatar": r["avatar"]}})
    if sort == "cheap":
        out.sort(key=lambda x: x["price"])
    elif sort == "deal":
        out.sort(key=lambda x: x["price"] / max(1, x["ref"]))
    return out[:limit]


def mine(uid: int) -> list[dict]:
    rows = db.all("SELECT * FROM market_listings WHERE seller_id=? ORDER BY id DESC LIMIT 50", (uid,))
    return [{"id": r["id"], "item": item_info(r["item_id"]), "price": r["price"], "status": r["status"], "at": r["created_at"],
             "closed_at": r["closed_at"]} for r in rows if item_info(r["item_id"])]
