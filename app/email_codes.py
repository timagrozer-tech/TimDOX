"""Шестизначные коды из писем: подтверждение почты и смена e-mail."""
import hmac
import secrets

from . import db
from .security import token_hash
from .web import ApiError

TTL_MINUTES = 60
MAX_ATTEMPTS = 5


def _hash(uid: int, purpose: str, code: str) -> str:
    return token_hash(f"{uid}:{purpose}:{code}")


def issue(uid: int, purpose: str, new_email: str | None = None) -> str:
    """Создаёт новый код (старые коды того же назначения аннулируются)."""
    db.run("DELETE FROM email_codes WHERE user_id=? AND purpose=?", (uid, purpose))
    code = f"{secrets.randbelow(10 ** 6):06d}"
    db.run("INSERT INTO email_codes (user_id, purpose, code_hash, new_email, expires_at) VALUES (?,?,?,?,?)",
           (uid, purpose, _hash(uid, purpose, code), new_email, db.future(minutes=TTL_MINUTES)))
    return code


def consume(uid: int, purpose: str, code: str) -> dict:
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    row = db.one("SELECT * FROM email_codes WHERE user_id=? AND purpose=? ORDER BY id DESC LIMIT 1", (uid, purpose))
    if not row or row["expires_at"] < db.now():
        raise ApiError(400, "Код устарел — запросите новый")
    if row["attempts"] >= MAX_ATTEMPTS:
        raise ApiError(400, "Слишком много попыток — запросите новый код")
    if len(code) != 6 or not hmac.compare_digest(row["code_hash"], _hash(uid, purpose, code)):
        db.run("UPDATE email_codes SET attempts=attempts+1 WHERE id=?", (row["id"],))
        left = MAX_ATTEMPTS - row["attempts"] - 1
        raise ApiError(400, f"Неверный код. Осталось попыток: {left}" if left > 0 else "Неверный код — запросите новый")
    db.run("DELETE FROM email_codes WHERE user_id=? AND purpose=?", (uid, purpose))
    return row


def pending(uid: int, purpose: str) -> dict | None:
    return db.one("SELECT new_email, expires_at FROM email_codes WHERE user_id=? AND purpose=? AND expires_at>? ORDER BY id DESC LIMIT 1",
                  (uid, purpose, db.now()))
