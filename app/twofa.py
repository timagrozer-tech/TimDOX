"""Двухфакторная защита: одноразовые коды из приложения-аутентификатора (TOTP, RFC 6238) и резервные коды.

Секрет TOTP хранится зашифрованным. Ключ берётся из переменной окружения KRUG_SECRET_KEY,
а если её нет — генерируется один раз и хранится в таблице app_secrets (защищает от утечки
отдельной таблицы или её копии; для полной защиты задайте KRUG_SECRET_KEY на сервере).
"""
import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
from urllib.parse import quote

from . import config, db

STEP = 30
BACKUP_COUNT = 10
_key_cache: bytes | None = None


def _key() -> bytes:
    global _key_cache
    if _key_cache:
        return _key_cache
    env = os.environ.get("KRUG_SECRET_KEY", "").strip()
    if env:
        _key_cache = hashlib.sha256(("krug-totp:" + env).encode()).digest()
        return _key_cache
    row = db.value("SELECT value FROM app_secrets WHERE name='totp_key'")
    if not row:
        db.run("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('totp_key', ?)", (secrets.token_hex(32),))
        row = db.value("SELECT value FROM app_secrets WHERE name='totp_key'")
    _key_cache = bytes.fromhex(row)
    return _key_cache


def _stream(key: bytes, nonce: bytes, n: int) -> bytes:
    out, counter = b"", 0
    while len(out) < n:
        out += hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return out[:n]


def encrypt(plain: str) -> str:
    """Поточное шифрование HMAC-SHA256 в режиме счётчика + метка целостности."""
    key, nonce, raw = _key(), secrets.token_bytes(16), plain.encode()
    ct = bytes(a ^ b for a, b in zip(raw, _stream(key, nonce, len(raw))))
    tag = hmac.new(key, b"tag" + nonce + ct, hashlib.sha256).digest()[:16]
    return "v1:" + base64.urlsafe_b64encode(nonce + tag + ct).decode()


def decrypt(token: str) -> str:
    if not token.startswith("v1:"):
        raise ValueError("unknown format")
    blob = base64.urlsafe_b64decode(token[3:])
    nonce, tag, ct = blob[:16], blob[16:32], blob[32:]
    key = _key()
    if not hmac.compare_digest(tag, hmac.new(key, b"tag" + nonce + ct, hashlib.sha256).digest()[:16]):
        raise ValueError("bad tag")
    return bytes(a ^ b for a, b in zip(ct, _stream(key, nonce, len(ct)))).decode()


# ---------------------------------------------------------------- TOTP
def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    n = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{n:06d}"


def verify(secret: str, code: str, last_step: int | None, now: float | None = None) -> int | None:
    """Шаг, на котором код совпал (±30 секунд), или None. Шаг не старше last_step не принимается — код одноразовый."""
    code = "".join(ch for ch in str(code) if ch.isdigit())
    if len(code) != 6:
        return None
    step = int((now if now is not None else time.time()) // STEP)
    for s in (step - 1, step, step + 1):
        if (last_step is None or s > last_step) and hmac.compare_digest(code_at(secret, s), code):
            return s
    return None


def otpauth_url(secret: str, account: str) -> str:
    issuer = config.APP_NAME
    return (f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={secret}"
            f"&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period={STEP}")


# ---------------------------------------------------------------- состояние пользователя
def enabled(user_id: int) -> bool:
    return bool(db.value("SELECT 1 FROM user_totp WHERE user_id=? AND enabled_at IS NOT NULL", (user_id,)))


def _hash_backup(code: str) -> str:
    return hashlib.sha256(("krug-backup:" + code.replace("-", "").upper()).encode()).hexdigest()


def new_backup_codes(user_id: int) -> list[str]:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    codes = ["".join(secrets.choice(alphabet) for _ in range(4)) + "-" + "".join(secrets.choice(alphabet) for _ in range(4))
             for _ in range(BACKUP_COUNT)]
    with db.tx() as c:
        c.execute("DELETE FROM backup_codes WHERE user_id=?", (user_id,))
        for code in codes:
            c.execute("INSERT INTO backup_codes (user_id, code_hash) VALUES (?,?)", (user_id, _hash_backup(code)))
    return codes


def backup_left(user_id: int) -> int:
    return db.value("SELECT count(*) FROM backup_codes WHERE user_id=? AND used_at IS NULL", (user_id,)) or 0


def check(user_id: int, code: str) -> str | None:
    """Проверяет код из приложения или резервный. Возвращает способ ('totp' | 'backup') или None."""
    row = db.one("SELECT secret_enc, last_step FROM user_totp WHERE user_id=? AND enabled_at IS NOT NULL", (user_id,))
    if not row:
        return None
    raw = str(code or "").strip()
    if sum(ch.isdigit() for ch in raw) == 6 and len(raw.replace(" ", "")) == 6:
        step = verify(decrypt(row["secret_enc"]), raw, row["last_step"])
        if step is None:
            return None
        db.run("UPDATE user_totp SET last_step=? WHERE user_id=?", (step, user_id))
        return "totp"
    h = _hash_backup(raw)
    cur = db.run("UPDATE backup_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL", (db.now(), user_id, h))
    return "backup" if cur.rowcount else None
