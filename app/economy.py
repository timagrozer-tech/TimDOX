"""Экономика Круга, этап Э0: кошелёк, журнал проводок, начисления с лимитами, задания, опыт.

Каждое движение монет — операция (ledger_tx) из проводок (ledger_entries), сумма проводок = 0.
Служебные счета: MINT (выпуск) и BURN (сжигание) — отрицательные id, баланс у них может быть любым.
Монеты меняет только этот модуль. Клиент сообщает события, суммы решает сервер."""
import hashlib
import json
from datetime import datetime, timedelta, timezone

from . import db

MINT, BURN = -1, -2
CURRENCIES = ("KC", "KR", "XP")
ACTIVITY_CAP = 200  # KC в сутки за всю активность без заданий
XP_PER_KC = 1       # за активность опыт 1:1 к монетам, за задания — свой

# источник: (KC за раз, сколько раз в сутки, опыт за раз)
SOURCES = {
    "login": (10, 1, 5),
    "streak7": (40, 1, 10),
    "post": (15, 3, 10),
    "comment": (3, 10, 2),
    "reactions_in": (1, 50, 0),
    "comments_in": (2, 15, 0),
    "visit_guest": (5, 5, 3),
    "visit_host": (2, 10, 1),
}

# задания: код → (текст, событие, сколько нужно)
QUEST_POOL = {
    1: [("react5", "Поставьте 5 реакций друзьям", "react", 5),
        ("msg3", "Напишите 3 сообщения", "message", 3),
        ("react8", "Отметьте 8 записей реакцией", "react", 8)],
    2: [("comment2", "Оставьте 2 комментария", "comment", 2),
        ("post1", "Опубликуйте запись", "post", 1),
        ("comment3", "Ответьте в 3 обсуждениях", "comment", 3)],
    3: [("story1", "Опубликуйте историю", "story", 1),
        ("post1b", "Поделитесь новой записью", "post", 1),
        ("comment5", "Оставьте 5 комментариев", "comment", 5),
        ("visit1", "Загляните в город друга", "visit", 1),
        ("build1", "Постройте или улучшите здание", "build", 1)],
}
QUEST_REWARD = {1: (20, 15), 2: (25, 20), 3: (35, 25)}  # (KC, XP)
ALL_DONE_BONUS = 20
WEEKLY_DAYS, WEEKLY_KC, WEEKLY_KR = 5, 250, 10


def today() -> str:
    return db.now()[:10]


def week_key(day: str | None = None) -> str:
    d = datetime.strptime(day or today(), "%Y-%m-%d")
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


# ---------------------------------------------------------------- журнал
def _post(c, kind: str, moves: list[tuple[int, str, int]], ref: str = "", idem: str | None = None, meta: dict | None = None) -> int | None:
    """Записывает операцию. moves = [(счёт, валюта, изменение)], сумма по каждой валюте = 0.
    idem — ключ однократности: повтор с тем же ключом ничего не делает и возвращает None."""
    for cur in {m[1] for m in moves}:
        assert sum(m[2] for m in moves if m[1] == cur) == 0, "несбалансированная операция"
    if idem and c.execute("SELECT 1 FROM ledger_tx WHERE idem=?", (idem,)).fetchone():
        return None
    tx = c.execute("INSERT INTO ledger_tx (kind, ref, idem, meta) VALUES (?,?,?,?)",
                   (kind, ref, idem, json.dumps(meta, ensure_ascii=False) if meta else None)).lastrowid
    for acc, cur, delta in moves:
        if not delta:
            continue
        c.execute("INSERT INTO ledger_entries (tx_id, account, currency, delta) VALUES (?,?,?,?)", (tx, acc, cur, delta))
        c.execute("""INSERT INTO wallets (account, currency, balance) VALUES (?,?,?)
                     ON CONFLICT (account, currency) DO UPDATE SET balance = wallets.balance + excluded.balance""", (acc, cur, delta))
        if acc > 0:
            bal = c.execute("SELECT balance FROM wallets WHERE account=? AND currency=?", (acc, cur)).fetchone()
            bal = bal["balance"] if isinstance(bal, dict) else bal[0]
            if bal < 0:
                raise ValueError("Недостаточно средств")
    return tx


def balances(uid: int) -> dict:
    rows = db.all("SELECT currency, balance FROM wallets WHERE account=?", (uid,))
    out = {c: 0 for c in CURRENCIES}
    out.update({r["currency"]: r["balance"] for r in rows})
    return out


def mint(uid: int, kc: int = 0, kind: str = "reward", ref: str = "", idem: str | None = None, xp: int = 0, kr: int = 0,
         meta: dict | None = None) -> int | None:
    moves = []
    for cur, n in (("KC", kc), ("XP", xp), ("KR", kr)):
        if n:
            moves += [(MINT, cur, -n), (uid, cur, n)]
    if not moves:
        return None
    with db.tx() as c:
        return _post(c, kind, moves, ref, idem, meta)


def reverse(idem: str, kind: str = "clawback") -> bool:
    """Отменяет начисление по его ключу (запись удалили в течение суток и т. п.). Списывает не больше, чем есть."""
    with db.tx() as c:
        tx = c.execute("SELECT id, ref FROM ledger_tx WHERE idem=?", (idem,)).fetchone()
        if not tx:
            return False
        tx = dict(tx) if not isinstance(tx, dict) else tx
        if c.execute("SELECT 1 FROM ledger_tx WHERE idem=?", ("rev:" + idem,)).fetchone():
            return False
        moves = []
        for e in c.execute("SELECT account, currency, delta FROM ledger_entries WHERE tx_id=?", (tx["id"],)).fetchall():
            e = dict(e) if not isinstance(e, dict) else e
            if e["account"] > 0 and e["currency"] != "XP":
                have = c.execute("SELECT balance FROM wallets WHERE account=? AND currency=?", (e["account"], e["currency"])).fetchone()
                have = (have["balance"] if isinstance(have, dict) else have[0]) if have else 0
                n = min(e["delta"], max(have, 0))
                if n > 0:
                    moves += [(e["account"], e["currency"], -n), (BURN, e["currency"], n)]
        if moves:
            _post(c, kind, moves, tx["ref"] or "", "rev:" + idem)
        else:
            _post(c, kind, [(BURN, "KC", 0), (MINT, "KC", 0)], tx["ref"] or "", "rev:" + idem)
        return True


# ---------------------------------------------------------------- лимиты
def _count(uid: int, day: str, source: str) -> dict:
    r = db.one("SELECT n, amount FROM econ_counters WHERE user_id=? AND day=? AND source=?", (uid, day, source))
    return r or {"n": 0, "amount": 0}


def _bump(uid: int, day: str, source: str, n: int, amount: int) -> None:
    db.run("""INSERT INTO econ_counters (user_id, day, source, n, amount) VALUES (?,?,?,?,?)
              ON CONFLICT (user_id, day, source) DO UPDATE SET n = econ_counters.n + excluded.n,
              amount = econ_counters.amount + excluded.amount""", (uid, day, source, n, amount))


def earn(uid: int, source: str, ref: str = "", times: int = 1) -> int:
    """Начисление за активность с суточным лимитом источника и общим потолком. Возвращает выданные KC."""
    kc_each, cap, xp_each = SOURCES[source]
    day = today()
    used = _count(uid, day, source)
    allowed = max(0, min(times, cap - used["n"]))
    if not allowed:
        return 0
    total = _count(uid, day, "_activity")["amount"]
    kc = min(kc_each * allowed, max(0, ACTIVITY_CAP - total))
    xp = xp_each * allowed
    if kc <= 0 and xp <= 0:
        return 0
    idem = f"{source}:{uid}:{ref or day}" if ref else None
    tx = mint(uid, kc, kind=source, ref=ref, idem=idem, xp=xp)
    if tx is None and idem:
        return 0
    _bump(uid, day, source, allowed, kc)
    _bump(uid, day, "_activity", 0, kc)
    return kc


# ---------------------------------------------------------------- вход и серия
def checkin(uid: int) -> dict:
    """Ежедневный вход: 10 KC, на 7-й день серии ещё 40. Один пропуск в неделю прощается."""
    day = today()
    st = db.one("SELECT streak, last_day, grace_week FROM econ_state WHERE user_id=?", (uid,))
    if st and st["last_day"] == day:
        return {"granted": 0, "streak": st["streak"]}
    streak = 1
    grace = st["grace_week"] if st else None
    if st and st["last_day"]:
        gap = (datetime.strptime(day, "%Y-%m-%d") - datetime.strptime(st["last_day"], "%Y-%m-%d")).days
        if gap == 1:
            streak = st["streak"] + 1
        elif gap == 2 and grace != week_key(day):
            streak = st["streak"] + 1
            grace = week_key(day)
    db.run("""INSERT INTO econ_state (user_id, streak, last_day, grace_week) VALUES (?,?,?,?)
              ON CONFLICT (user_id) DO UPDATE SET streak=excluded.streak, last_day=excluded.last_day, grace_week=excluded.grace_week""",
           (uid, streak, day, grace))
    got = earn(uid, "login", ref=f"d{day}")
    if streak % 7 == 0:
        got += earn(uid, "streak7", ref=f"s{day}")
    return {"granted": got, "streak": streak}


# ---------------------------------------------------------------- задания
def _pick(uid: int, day: str, tier: int, skip: str | None = None) -> tuple:
    pool = [q for q in QUEST_POOL[tier] if q[0] != skip]
    h = int(hashlib.sha256(f"{uid}:{day}:{tier}:{skip or ''}".encode()).hexdigest(), 16)
    return pool[h % len(pool)]


def quests(uid: int) -> list[dict]:
    day = today()
    rows = db.all("SELECT * FROM user_quests WHERE user_id=? AND day=? ORDER BY slot", (uid, day))
    if len(rows) < 3:
        have = {r["slot"] for r in rows}
        for tier in (1, 2, 3):
            if tier in have:
                continue
            code, _title, event, target = _pick(uid, day, tier)
            db.run("""INSERT INTO user_quests (user_id, day, slot, code, event, target) VALUES (?,?,?,?,?,?)
                      ON CONFLICT (user_id, day, slot) DO NOTHING""", (uid, day, tier, code, event, target))
        rows = db.all("SELECT * FROM user_quests WHERE user_id=? AND day=? ORDER BY slot", (uid, day))
    titles = {q[0]: q[1] for t in QUEST_POOL.values() for q in t}
    out = []
    for r in rows:
        kc, xp = QUEST_REWARD[r["slot"]]
        out.append({"slot": r["slot"], "code": r["code"], "title": titles.get(r["code"], r["code"]), "event": r["event"],
                    "target": r["target"], "progress": min(r["progress"], r["target"]), "done": r["progress"] >= r["target"],
                    "claimed": bool(r["claimed"]), "reward": {"kc": kc, "xp": xp}, "swapped": bool(r["swapped"])})
    return out


def track(uid: int, event: str, n: int = 1) -> None:
    """Событие из соцсети продвигает задания дня. Ничего не начисляет само — награда по кнопке «Забрать»."""
    try:
        quests(uid)
        db.run("UPDATE user_quests SET progress = progress + ? WHERE user_id=? AND day=? AND event=? AND claimed=0",
               (n, uid, today(), event))
    except Exception:  # задания не должны ломать основное действие
        import logging
        logging.getLogger("krug").exception("Не удалось обновить задания")


def swap(uid: int, slot: int) -> list[dict]:
    day = today()
    r = db.one("SELECT * FROM user_quests WHERE user_id=? AND day=? AND slot=?", (uid, day, slot))
    if not r or r["claimed"] or r["progress"] >= r["target"]:
        raise ValueError("Это задание нельзя заменить")
    if db.value("SELECT count(*) FROM user_quests WHERE user_id=? AND day=? AND swapped=1", (uid, day)):
        raise ValueError("Заменить можно одно задание в день")
    code, _t, event, target = _pick(uid, day, slot, skip=r["code"])
    db.run("UPDATE user_quests SET code=?, event=?, target=?, progress=0, swapped=1 WHERE user_id=? AND day=? AND slot=?",
           (code, event, target, uid, day, slot))
    return quests(uid)


def claim(uid: int, slot: int) -> dict:
    day = today()
    r = db.one("SELECT * FROM user_quests WHERE user_id=? AND day=? AND slot=?", (uid, day, slot))
    if not r or r["progress"] < r["target"]:
        raise ValueError("Задание ещё не выполнено")
    if r["claimed"]:
        raise ValueError("Награда уже получена")
    kc, xp = QUEST_REWARD[slot]
    if mint(uid, kc, kind="quest", ref=r["code"], idem=f"quest:{uid}:{day}:{slot}", xp=xp) is None:
        raise ValueError("Награда уже получена")
    db.run("UPDATE user_quests SET claimed=1 WHERE user_id=? AND day=? AND slot=?", (uid, day, slot))
    got = {"kc": kc, "xp": xp, "bonus": 0}
    if db.value("SELECT count(*) FROM user_quests WHERE user_id=? AND day=? AND claimed=1", (uid, day)) >= 3:
        if mint(uid, ALL_DONE_BONUS, kind="quest_all", idem=f"questall:{uid}:{day}", xp=10) is not None:
            got["bonus"] = ALL_DONE_BONUS
            wk = week_key(day)
            db.run("""INSERT INTO econ_weekly (user_id, week, days) VALUES (?,?,1)
                      ON CONFLICT (user_id, week) DO UPDATE SET days = econ_weekly.days + 1""", (uid, wk))
    return got


def weekly(uid: int) -> dict:
    wk = week_key()
    r = db.one("SELECT days, claimed FROM econ_weekly WHERE user_id=? AND week=?", (uid, wk)) or {"days": 0, "claimed": 0}
    return {"week": wk, "days": min(r["days"], WEEKLY_DAYS), "target": WEEKLY_DAYS, "claimed": bool(r["claimed"]),
            "reward": {"kc": WEEKLY_KC, "kr": WEEKLY_KR}}


def claim_weekly(uid: int) -> dict:
    w = weekly(uid)
    if w["claimed"]:
        raise ValueError("Награда недели уже получена")
    if w["days"] < WEEKLY_DAYS:
        raise ValueError(f"Нужно {WEEKLY_DAYS} дней со всеми заданиями")
    if mint(uid, WEEKLY_KC, kind="weekly", idem=f"weekly:{uid}:{w['week']}", kr=WEEKLY_KR, xp=50) is None:
        raise ValueError("Награда недели уже получена")
    db.run("UPDATE econ_weekly SET claimed=1 WHERE user_id=? AND week=?", (uid, w["week"]))
    return {"kc": WEEKLY_KC, "kr": WEEKLY_KR}


# ---------------------------------------------------------------- полученные реакции и комментарии (пакетом)
def settle_incoming(day: str | None = None) -> int:
    """Раз в 10 минут: 1 KC за каждого уникального человека, отреагировавшего на записи автора сегодня,
    2 KC — за каждого уникального комментатора. Считаются только аккаунты старше 7 дней и не заблокированные."""
    day = day or today()
    start = day + "T00:00:00"
    old = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
    paid = 0
    for source, sql in (
        ("reactions_in", """SELECT p.author_id AS uid, count(DISTINCT r.user_id) AS n FROM reactions r
                            JOIN posts p ON p.id = r.post_id JOIN users u ON u.id = r.user_id
                            WHERE r.created_at >= ? AND r.user_id <> p.author_id AND u.created_at <= ? AND u.is_banned = 0
                            GROUP BY p.author_id"""),
        ("comments_in", """SELECT p.author_id AS uid, count(DISTINCT c.author_id) AS n FROM comments c
                           JOIN posts p ON p.id = c.post_id JOIN users u ON u.id = c.author_id
                           WHERE c.created_at >= ? AND c.author_id <> p.author_id AND u.created_at <= ? AND u.is_banned = 0
                           GROUP BY p.author_id"""),
    ):
        for r in db.all(sql, (start, old)):
            done = _count(r["uid"], day, source)["n"]
            new = r["n"] - done
            if new > 0:
                paid += earn(r["uid"], source, ref=f"{day}:{r['n']}", times=new)
    return paid


# ---------------------------------------------------------------- уровень
def level_for(xp: int) -> dict:
    """Уровень n требует 100·n^1,6 опыта суммарно (уровень 10 ≈ 4 000, 30 ≈ 23 000, 50 ≈ 52 000)."""
    need = lambda n: int(100 * n ** 1.6) if n > 1 else 0
    lvl = 1
    while lvl < 50 and xp >= need(lvl + 1):
        lvl += 1
    cur, nxt = need(lvl), need(min(lvl + 1, 50))
    return {"level": lvl, "xp": xp, "from": cur, "to": nxt, "max": lvl >= 50}


def history(uid: int, before: int | None = None, n: int = 30) -> list[dict]:
    q = """SELECT t.id, t.kind, t.ref, t.created_at, e.currency, e.delta FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
           WHERE e.account = ? AND e.currency <> 'XP'""" + (" AND t.id < ?" if before else "") + " ORDER BY t.id DESC LIMIT ?"
    return db.all(q, (uid, before, n) if before else (uid, n))


def audit() -> dict:
    """Сверка: сумма всех проводок по каждой валюте = 0, балансы = сумме проводок."""
    sums = {r["currency"]: int(r["s"] or 0) for r in db.all("SELECT currency, sum(delta) AS s FROM ledger_entries GROUP BY currency")}
    bad = db.all("""SELECT w.account, w.currency, w.balance, coalesce(x.s, 0) AS s FROM wallets w
                    LEFT JOIN (SELECT account, currency, sum(delta) AS s FROM ledger_entries GROUP BY account, currency) x
                    ON x.account = w.account AND x.currency = w.currency WHERE w.balance <> coalesce(x.s, 0) LIMIT 20""")
    bad = [{k: (int(v) if k in ("s", "balance", "account") else v) for k, v in r.items()} for r in bad]
    return {"sums": sums, "mismatch": bad, "ok": all(v == 0 for v in sums.values()) and not bad}


def stats() -> dict:
    """Масса монет на руках, выпуск и сжигание за 30 дней — для админки."""
    since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    supply = db.value("SELECT coalesce(sum(balance),0) FROM wallets WHERE account > 0 AND currency='KC'") or 0
    minted = -(db.value("""SELECT coalesce(sum(e.delta),0) FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
                           WHERE e.account=? AND e.currency='KC' AND t.created_at >= ?""", (MINT, since)) or 0)
    burned = db.value("""SELECT coalesce(sum(e.delta),0) FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
                         WHERE e.account=? AND e.currency='KC' AND t.created_at >= ?""", (BURN, since)) or 0
    holders = db.value("SELECT count(*) FROM wallets WHERE account > 0 AND currency='KC' AND balance > 0") or 0
    supply, minted, burned, holders = int(supply), int(minted), int(burned), int(holders)
    return {"supply": supply, "minted_30d": minted, "burned_30d": burned, "holders": holders,
            "burn_ratio": round(burned / minted, 2) if minted else None}


# ---------------------------------------------------------------- события соцсети → начисления и задания
def _safe(fn):
    def wrap(*a, **kw):
        try:
            return fn(*a, **kw)
        except Exception:
            import logging
            logging.getLogger("krug").exception("Экономика: ошибка в %s", fn.__name__)
            return 0
    return wrap


@_safe
def on_post(uid: int, pid: int, text: str, has_media: bool) -> int:
    track(uid, "post")
    if len((text or "").strip()) < 40 and not has_media:
        return 0
    since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    if text and db.value("SELECT 1 FROM posts WHERE author_id=? AND text=? AND id<>? AND created_at>=? LIMIT 1", (uid, text, pid, since)):
        return 0  # повтор старой записи наград не даёт
    return earn(uid, "post", ref=f"post{pid}")


@_safe
def on_post_deleted(uid: int, pid: int, created_at: str) -> None:
    if created_at and created_at >= db.future(hours=-24):
        reverse(f"post:{uid}:post{pid}")


@_safe
def on_comment(uid: int, cid: int, text: str, post_author: int) -> int:
    track(uid, "comment")
    if post_author == uid or len((text or "").strip()) < 15:
        return 0
    return earn(uid, "comment", ref=f"c{cid}")


@_safe
def on_comment_deleted(uid: int, cid: int, created_at: str) -> None:
    if created_at and created_at >= db.future(hours=-24):
        reverse(f"comment:{uid}:c{cid}")


@_safe
def on_event(uid: int, event: str) -> None:
    track(uid, event)


# ---------------------------------------------------------------- траты
def spend(uid: int, kc: int, kind: str, ref: str = "", xp_back: bool = True) -> int:
    """Списывает KC и сжигает их. За вложения в город — опыт (1 за каждые 10 KC). ValueError — не хватает монет."""
    if kc <= 0:
        raise ValueError("Некорректная сумма")
    moves = [(uid, "KC", -kc), (BURN, "KC", kc)]
    xp = kc // 10 if xp_back else 0
    if xp:
        moves += [(MINT, "XP", -xp), (uid, "XP", xp)]
    with db.tx() as c:
        return _post(c, kind, moves, ref)


def earn_amount(uid: int, source: str, amount: int, cap: int, ref: str = "") -> int:
    """Начисление переменной суммы с суточным потолком источника (казна города и т. п.)."""
    day = today()
    used = _count(uid, day, source)["amount"]
    total = _count(uid, day, "_activity")["amount"]
    kc = max(0, min(amount, cap - used, ACTIVITY_CAP - total))
    if kc <= 0:
        return 0
    if mint(uid, kc, kind=source, ref=ref, idem=f"{source}:{uid}:{ref}" if ref else None, xp=kc // 2) is None:
        return 0
    _bump(uid, day, source, 1, kc)
    _bump(uid, day, "_activity", 0, kc)
    return kc


# ---------------------------------------------------------------- люди: поддержка авторов и переводы
SUPPORT_AMOUNTS = (10, 50, 100, 500)
SUPPORT_FEE = 0.10
TRANSFER_FEE = 0.05
RECEIVE_DAY_CAP = 10000


class EconError(ValueError):
    pass


def _age_days(uid: int) -> float:
    created = db.value("SELECT created_at FROM users WHERE id=?", (uid,)) or db.now()
    t = datetime.strptime(created[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 86400


def linked(a: int, b: int) -> bool:
    """Связанные аккаунты: входили из одной сети за последние 30 дней. Им нельзя поддерживать и переводить друг другу."""
    x, y = sorted((a, b))
    if db.value("SELECT 1 FROM account_links WHERE a=? AND b=?", (x, y)):
        return True
    # тот же браузер на том же устройстве: совпадают сеть и строка браузера
    since = db.future(days=-30)
    return bool(db.value("""SELECT 1 FROM sessions s1 JOIN sessions s2 ON s1.ip_prefix = s2.ip_prefix AND s1.user_agent = s2.user_agent
                            WHERE s1.user_id=? AND s2.user_id=? AND s1.ip_prefix IS NOT NULL AND s1.ip_prefix <> ''
                            AND s1.user_agent <> '' AND s1.created_at >= ? AND s2.created_at >= ? LIMIT 1""", (a, b, since, since)))


def _received_today(uid: int) -> int:
    return _count(uid, today(), "_received")["amount"]


def transfer(sender: int, recipient: int, amount: int, kind: str, fee_pct: float, ref: str = "", meta: dict | None = None) -> dict:
    """Перевод между людьми: комиссия сгорает, получатель получает остальное."""
    if sender == recipient:
        raise EconError("Себе перевести нельзя")
    if amount <= 0:
        raise EconError("Некорректная сумма")
    if _received_today(recipient) + amount > RECEIVE_DAY_CAP:
        raise EconError("Получатель сегодня уже получил максимум — попробуйте завтра")
    fee = max(1, round(amount * fee_pct)) if fee_pct else 0
    moves = [(sender, "KC", -amount), (recipient, "KC", amount - fee)]
    if fee:
        moves.append((BURN, "KC", fee))
    try:
        with db.tx() as c:
            tx = _post(c, kind, moves, ref, meta=meta)
    except ValueError:
        raise EconError("Не хватает монет")
    _bump(sender, today(), "_sent:" + kind, 1, amount)
    _bump(recipient, today(), "_received", 1, amount - fee)
    return {"tx": tx, "amount": amount, "fee": fee, "net": amount - fee}


def support_limit(uid: int, ai: bool = False) -> int:
    if ai:
        return 300
    return 200 if _age_days(uid) < 14 else 1000


def support_post(uid: int, post: dict, amount: int, ai: bool = False) -> dict:
    """«Поддержать автора»: 10/50/100/500 KC, 10% сгорает. Лимит отправителя в сутки, без связанных аккаунтов."""
    if amount not in SUPPORT_AMOUNTS:
        raise EconError("Выберите 10, 50, 100 или 500 KC")
    author = post["author_id"]
    if author == uid:
        raise EconError("Свою запись поддержать нельзя")
    if not ai and linked(uid, author):
        raise EconError("Нельзя поддерживать свои же аккаунты — вы входите в них с одного устройства")
    sent = _count(uid, today(), "_sent:support")["amount"]
    cap = support_limit(uid, ai)
    if sent + amount > cap:
        raise EconError(f"Сегодня можно отправить ещё {max(0, cap - sent)} KC поддержки")
    res = transfer(uid, author, amount, "support", SUPPORT_FEE, ref=f"post{post['id']}", meta={"post": post["id"]})
    db.run("INSERT INTO post_supports (post_id, user_id, amount) VALUES (?,?,?)", (post["id"], uid, amount))
    from . import social
    social.notify(author, uid, "support", post_id=post["id"], extra={"amount": res["net"]})
    track(uid, "support")
    return res


def transfer_limit(uid: int) -> int:
    age = _age_days(uid)
    if age < 14:
        return 0
    from . import twofa
    return 5000 if (age >= 30 and twofa.enabled(uid)) else 1000


def supports_for(post_ids: list[int], viewer: int) -> dict[int, dict]:
    if not post_ids:
        return {}
    ph = db.placeholders(post_ids)
    rows = db.all(f"""SELECT post_id, count(DISTINCT user_id) AS people, sum(amount) AS total,
                      max(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine
                      FROM post_supports WHERE post_id IN ({ph}) GROUP BY post_id""", (viewer, *post_ids))
    return {r["post_id"]: {"people": int(r["people"]), "total": int(r["total"] or 0), "mine": bool(r["mine"])} for r in rows}


# ---------------------------------------------------------------- ИИ-персонажи как участники экономики
AI_STIPEND = 300  # KC в неделю на персонажа — из выпуска, этим ограничен весь «ИИ-оборот»


def ai_stipend(persona_id: int) -> None:
    mint(persona_id, AI_STIPEND, kind="ai_stipend", idem=f"ai_stipend:{persona_id}:{week_key()}")
