"""Пароли, токены, ограничение частоты запросов, фильтр запрещённых слов."""
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque

# ---------- Пароли (scrypt из стандартной библиотеки, соль 16 байт) ----------
_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, dk_hex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, TypeError):
        return False


def validate_password(password: str) -> str | None:
    if len(password) < 8:
        return "Пароль должен быть не короче 8 символов"
    if len(password) > 128:
        return "Пароль слишком длинный"
    if not re.search(r"[A-Za-zА-Яа-яЁё]", password) or not re.search(r"\d", password):
        return "Пароль должен содержать буквы и цифры"
    return None


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- Ограничение частоты запросов (скользящее окно в памяти) ----------
class RateLimiter:
    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)

    def hit(self, key: str, limit: int, window: float) -> bool:
        """True — запрос разрешён; False — лимит превышен."""
        now = time.monotonic()
        if len(self._hits) > 50000:  # редкая уборка: выбрасываем пустые и давно неактивные ключи
            for k in [k for k, q in self._hits.items() if not q or q[-1] < now - 86400]:
                del self._hits[k]
        q = self._hits[key]
        while q and q[0] <= now - window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    def check(self, key: str, limit: int, window: float) -> bool:
        """Проверка без записи попытки: True — ещё можно."""
        now = time.monotonic()
        q = self._hits.get(key)
        if not q:
            return True
        while q and q[0] <= now - window:
            q.popleft()
        return len(q) < limit

    def reset(self):
        self._hits.clear()


rate_limiter = RateLimiter()

# Лимиты: (кол-во запросов, окно в секундах)
LIMITS = {
    "auth": (10, 60),        # вход, регистрация, сброс пароля
    "login_account": (10, 900),  # неудачные входы в один аккаунт — не зависит от IP
    "mail_address": (4, 3600),   # писем на один адрес в час
    "codes_day": (8, 86400),     # новых кодов из писем на пользователя в сутки
    "write": (60, 60),       # посты, комментарии, реакции
    "message": (40, 60),     # сообщения
    "upload": (20, 60),      # загрузка файлов
    "stats": (30, 60),         # личная статистика (тяжёлые выборки)
    "search_music": (60, 60),  # поиск музыки (внешний сервис)
    "report": (20, 3600),      # жалобы: не больше 20 в час
    "default": (300, 60),
}

# ---------- Фильтр запрещённых слов ----------
# Базовый список; расширяется через файл data/banned_words.txt (по слову в строке).
_BANNED = {"хуй", "пизд", "ебат", "ебал", "бля", "сука", "мудак", "пидор", "fuck", "shit"}


def load_extra_banned(path) -> None:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            w = line.strip().lower()
            if w:
                _BANNED.add(w)
    except FileNotFoundError:
        pass


_word_re = re.compile(r"[\wЁё]+", re.UNICODE)


def censor(text: str) -> str:
    """Заменяет слова, содержащие запрещённые корни, на звёздочки."""
    def repl(m: re.Match) -> str:
        w = m.group(0)
        lw = w.lower()
        if any(b in lw for b in _BANNED):
            return w[0] + "*" * (len(w) - 1)
        return w
    return _word_re.sub(repl, text)


# ---------- Разбор текста ----------
HASHTAG_RE = re.compile(r"(?<![\wЁё])#([\wЁё]{1,50})", re.UNICODE)
MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{3,30})")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,30}$")


def extract_hashtags(text: str) -> list[str]:
    seen, out = set(), []
    for tag in HASHTAG_RE.findall(text):
        t = tag.lower()
        if t not in seen and not t.isdigit():
            seen.add(t)
            out.append(t)
    return out[:30]


def extract_mentions(text: str) -> list[str]:
    return list(dict.fromkeys(m.lower() for m in MENTION_RE.findall(text)))[:20]


def clean_text(text: str | None, max_len: int) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip()
    return text[:max_len]
