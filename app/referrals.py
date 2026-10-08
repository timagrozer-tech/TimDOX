"""Реферальная экосистема: ссылки и коды приглашений, учёт переходов, засчитанные приглашения,
галочки-достижения (3 → базовая, 10 → серебряная, 50 → золотая, 100 → легендарная) и социальное дерево.

Приглашение засчитывается не сразу, а когда новичок стал живым участником: поставил аватар
и заходил в Yarko в 3 разных дня (и подтвердил почту, если отправка писем настроена). Так ферма
пустых аккаунтов ничего не даёт. Из одной сети засчитываются максимум 3 приглашения одного человека.
"""
import hashlib
import secrets
import time

from . import config, db, mailer, social

TIERS = ((100, "legend"), (50, "gold"), (10, "silver"), (3, "base"))
TIER_NAMES = {"base": "Базовая галочка", "silver": "Серебряная галочка", "gold": "Золотая галочка", "legend": "Легендарная галочка"}
NEXT = {None: (3, "base"), "base": (10, "silver"), "silver": (50, "gold"), "gold": (100, "legend"), "legend": None}
ACTIVE_DAYS_NEEDED = 3
PENDING_DAYS = 30
PER_NETWORK = 3
MAX_CODES = 10
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def tier_for(qualified: int) -> str | None:
    return next((t for need, t in TIERS if qualified >= need), None)


def new_code() -> str:
    for _ in range(20):
        code = "".join(secrets.choice(_ALPHABET) for _ in range(8))
        if not db.value("SELECT 1 FROM invite_codes WHERE code=?", (code,)):
            return code
    raise RuntimeError("не удалось подобрать код")


def main_code(user_id: int) -> str:
    """Основной код человека (создаётся при первом обращении)."""
    code = db.value("""SELECT code FROM invite_codes WHERE user_id=? AND disabled_at IS NULL AND label IS NULL
                       ORDER BY created_at LIMIT 1""", (user_id,))
    if code:
        return code
    code = new_code()
    db.run("INSERT INTO invite_codes (code, user_id) VALUES (?,?)", (code, user_id))
    return code


def code_owner(code: str) -> dict | None:
    code = (code or "").strip().lower()[:16]
    if not code:
        return None
    return db.one("""SELECT c.code, c.user_id, p.username, p.name, p.avatar FROM invite_codes c
                     JOIN profiles p ON p.user_id = c.user_id JOIN users u ON u.id = c.user_id
                     WHERE c.code=? AND c.disabled_at IS NULL AND u.is_banned = 0""", (code,))


def record_click(code: str, ip: str, ua: str, source: str | None) -> bool:
    if not code_owner(code):
        return False
    day = db.now()[:10]
    visitor = hashlib.sha256(f"{ip}|{ua}|{day}|{_salt()}".encode()).hexdigest()[:16]
    db.run("INSERT OR IGNORE INTO invite_clicks (code, day, visitor, source) VALUES (?,?,?,?)",
           (code, day, visitor, (source or "")[:40] or None))
    return True


_salt_cache: str | None = None


def _salt() -> str:
    global _salt_cache
    if _salt_cache is None:
        row = db.value("SELECT value FROM app_secrets WHERE name='click_salt'")
        if not row:
            db.run("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('click_salt', ?)", (secrets.token_hex(16),))
            row = db.value("SELECT value FROM app_secrets WHERE name='click_salt'")
        _salt_cache = row
    return _salt_cache


def attach(invitee_id: int, code: str, net: str | None) -> int | None:
    """Новый пользователь пришёл по коду: запоминаем, кто пригласил. Возвращает id пригласившего."""
    owner = code_owner(code)
    if not owner or owner["user_id"] == invitee_id:
        return None
    db.run("INSERT OR IGNORE INTO referrals (invitee_id, inviter_id, code, net) VALUES (?,?,?,?)",
           (invitee_id, owner["user_id"], owner["code"], net))
    social.notify(owner["user_id"], invitee_id, "invite_joined")
    return owner["user_id"]


# ---------------------------------------------------------------- активность
_seen_today: set[tuple[int, str]] = set()


def mark_active(user_id: int) -> None:
    """Отмечает день активности (один раз в сутки на человека, без записи в базу на каждый запрос)."""
    day = db.now()[:10]
    key = (user_id, day)
    if key in _seen_today:
        return
    if len(_seen_today) > 200_000:
        _seen_today.clear()
    _seen_today.add(key)
    db.run("INSERT OR IGNORE INTO user_active_days (user_id, day) VALUES (?,?)", (user_id, day))


# ---------------------------------------------------------------- засчёт и награды
def qualify_pending() -> int:
    """Проверяет ожидающие приглашения; возвращает число засчитанных."""
    need_mail = mailer.configured()
    rows = db.all(f"""
        SELECT r.invitee_id, r.inviter_id, r.net, r.created_at, u.is_banned, u.email_verified_at, p.avatar,
               (SELECT count(*) FROM user_active_days d WHERE d.user_id = r.invitee_id) AS days
        FROM referrals r JOIN users u ON u.id = r.invitee_id JOIN profiles p ON p.user_id = r.invitee_id
        WHERE r.status = 'pending' LIMIT 2000""")
    done = 0
    for r in rows:
        if r["is_banned"]:
            _reject(r["invitee_id"], "banned")
            continue
        ready = r["avatar"] and r["days"] >= ACTIVE_DAYS_NEEDED and (r["email_verified_at"] or not need_mail)
        if not ready:
            if r["created_at"] < db.future(days=-PENDING_DAYS):
                _reject(r["invitee_id"], "inactive")
            continue
        if r["net"] and (db.value("""SELECT count(*) FROM referrals WHERE inviter_id=? AND net=? AND status='qualified'""",
                                  (r["inviter_id"], r["net"])) or 0) >= PER_NETWORK:
            _reject(r["invitee_id"], "same_network")
            continue
        db.run("UPDATE referrals SET status='qualified', qualified_at=? WHERE invitee_id=? AND status='pending'",
               (db.now(), r["invitee_id"]))
        _recount(r["inviter_id"], r["invitee_id"])
        done += 1
    return done


def _reject(invitee_id: int, reason: str) -> None:
    db.run("UPDATE referrals SET status='rejected', reject_reason=? WHERE invitee_id=? AND status='pending'", (reason, invitee_id))


def _recount(inviter_id: int, actor_id: int) -> None:
    n = db.value("SELECT count(*) FROM referrals WHERE inviter_id=? AND status='qualified'", (inviter_id,)) or 0
    old = db.value("SELECT invite_tier FROM profiles WHERE user_id=?", (inviter_id,))
    tier = tier_for(n)
    db.run("UPDATE profiles SET invites_qualified=?, invite_tier=? WHERE user_id=?", (n, tier, inviter_id))
    social.notify(inviter_id, actor_id, "invite_qualified", extra={"count": n})
    if tier and tier != old:
        db.run("INSERT OR IGNORE INTO referral_rewards (user_id, kind, tier) VALUES (?,?,?)", (inviter_id, "badge", tier))
        social.notify(inviter_id, actor_id, "invite_tier", extra={"tier": tier, "name": TIER_NAMES[tier], "count": n})
        reset_tier_cache()


# ---------------------------------------------------------------- кэш галочек для карточек
_tiers: dict[int, str] = {}
_tiers_at = float("-inf")


def tier_map() -> dict[int, str]:
    global _tiers, _tiers_at
    if time.monotonic() - _tiers_at > 60:
        try:
            _tiers = {r["user_id"]: r["invite_tier"] for r in db.all("SELECT user_id, invite_tier FROM profiles WHERE invite_tier IS NOT NULL")}
        except Exception:
            _tiers = {}
        _tiers_at = time.monotonic()
    return _tiers


def reset_tier_cache() -> None:
    global _tiers_at
    _tiers_at = float("-inf")


def progress(user_id: int) -> dict:
    n = db.value("SELECT invites_qualified FROM profiles WHERE user_id=?", (user_id,)) or 0
    tier = tier_for(n)
    nxt = NEXT[tier]
    return {"qualified": n, "tier": tier, "tier_name": TIER_NAMES.get(tier),
            "next": None if not nxt else {"tier": nxt[1], "name": TIER_NAMES[nxt[1]], "need": nxt[0], "left": max(0, nxt[0] - n),
                                          "percent": min(100, round(100 * n / nxt[0]))}}


def link(code: str) -> str:
    return f"{config.APP_URL}/i/{code}"
