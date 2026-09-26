"""Настройки приложения. Все значения читаются из переменных окружения (.env)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes", "on")


APP_NAME = os.environ.get("APP_NAME", "Круг")
# На Render адрес сервиса приходит в RENDER_EXTERNAL_URL
APP_URL = os.environ.get("APP_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://localhost:8000"
APP_URL = APP_URL.rstrip("/")
DEBUG = _bool("DEBUG", True)

DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.environ.get("DB_PATH", DATA_DIR / "krug.db"))
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", BASE_DIR / "uploads"))
STATIC_DIR = BASE_DIR / "static"

SESSION_COOKIE = "krug_session"
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
COOKIE_SECURE = _bool("COOKIE_SECURE", APP_URL.startswith("https://"))

# Если включено — без подтверждения e-mail нельзя публиковать и писать сообщения.
REQUIRE_EMAIL_CONFIRM = _bool("REQUIRE_EMAIL_CONFIRM", False)

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "Круг <no-reply@krug.local>")
SMTP_TLS = _bool("SMTP_TLS", True)

# Brevo (бывш. Sendinblue): письма через HTTPS API — работает там, где SMTP-порты закрыты (бесплатный Render)
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "").strip()


def _from_parts(raw: str) -> tuple[str, str]:
    from email.utils import parseaddr
    name, addr = parseaddr(raw)
    return name or "Круг", addr or "no-reply@krug.local"


MAIL_FROM_NAME, MAIL_FROM_EMAIL = _from_parts(SMTP_FROM)
MAIL_FROM_EMAIL = os.environ.get("MAIL_FROM_EMAIL", MAIL_FROM_EMAIL).strip()
MAIL_FROM_NAME = os.environ.get("MAIL_FROM_NAME", MAIL_FROM_NAME).strip()

# Где хранить фото: disk (папка UPLOAD_DIR) или db (в самой базе — для хостинга без постоянного диска)
MEDIA_STORAGE = os.environ.get("MEDIA_STORAGE", "disk").lower()

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "10"))
MAX_PHOTOS_PER_POST = 10
POST_MAX_LEN = 5000
NOTE_MAX_LEN = 500
COMMENT_MAX_LEN = 2000
MESSAGE_MAX_LEN = 4000

for d in (DATA_DIR, UPLOAD_DIR):
    d.mkdir(parents=True, exist_ok=True)
