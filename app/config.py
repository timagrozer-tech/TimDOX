"""Настройки приложения. Все значения читаются из переменных окружения (.env)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    # .env рядом с кодом и настройки, перенесённые со старого сервера при переезде (DATA_DIR/migrated.env)
    for env_file in (BASE_DIR / ".env", Path(os.environ.get("DATA_DIR", BASE_DIR / "data")) / "migrated.env",
                     Path("/tmp/yarko-migrated.env")):
        if env_file.exists():
            _read_env(env_file)


def _read_env(env_file: Path) -> None:
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes", "on")


APP_NAME = os.environ.get("APP_NAME", "Yarko")
if APP_NAME.strip() in ("Круг", "KRUG", "Krug"):  # ребрендинг: старое значение из окружения не должно вернуть прежнее имя
    APP_NAME = "Yarko"
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
REQUIRE_PHONE = _bool("REQUIRE_PHONE", False)  # True — без номера телефона не зарегистрироваться (по умолчанию: номер или почта)

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "Yarko <no-reply@krug.local>")
SMTP_TLS = _bool("SMTP_TLS", True)

# Brevo (бывш. Sendinblue): письма через HTTPS API — работает там, где SMTP-порты закрыты (бесплатный Render)
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "").strip()
# Google Apps Script: письма уходят с вашего Gmail через веб-приложение скрипта (HTTPS, бесплатно)
MAIL_WEBHOOK_URL = os.environ.get("MAIL_WEBHOOK_URL", "").strip()
MAIL_WEBHOOK_SECRET = os.environ.get("MAIL_WEBHOOK_SECRET", "").strip()


def _from_parts(raw: str) -> tuple[str, str]:
    from email.utils import parseaddr
    name, addr = parseaddr(raw)
    if name.strip() in ("Круг", "KRUG", "Krug"):
        name = "Yarko"
    return name or "Yarko", addr or "no-reply@krug.local"


MAIL_FROM_NAME, MAIL_FROM_EMAIL = _from_parts(SMTP_FROM)
MAIL_FROM_EMAIL = os.environ.get("MAIL_FROM_EMAIL", MAIL_FROM_EMAIL).strip()
MAIL_FROM_NAME = os.environ.get("MAIL_FROM_NAME", MAIL_FROM_NAME).strip()

# Где хранить фото: disk (папка UPLOAD_DIR) или db (в самой базе — для хостинга без постоянного диска)
MEDIA_STORAGE = os.environ.get("MEDIA_STORAGE", "disk").lower()

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "10"))
MAX_VIDEO_MB = int(os.environ.get("MAX_VIDEO_MB", "30"))
MAX_AUDIO_MB = int(os.environ.get("MAX_AUDIO_MB", "15"))
MAX_SONG_MB = int(os.environ.get("MAX_SONG_MB", "25"))         # свои песни в «Музыке»
SONGS_PER_DAY = int(os.environ.get("SONGS_PER_DAY", "10"))
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "25"))  # любые файлы в сообщениях
REEL_MAX_SECONDS = int(os.environ.get("REEL_MAX_SECONDS", "90"))

# Supabase Storage для фото, видео и музыки (MEDIA_STORAGE=supabase)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "krug-media")
if MEDIA_STORAGE == "supabase" and not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
    MEDIA_STORAGE = "db"
# Дневные квоты загрузок на человека: защищают хранилище от заливки мусора с одного аккаунта.
# Без подтверждённой почты квота меньше — фермам одноразовых аккаунтов это невыгодно.
UPLOAD_DAY_MB = int(os.environ.get("UPLOAD_DAY_MB", "400"))
UPLOAD_DAY_FILES = int(os.environ.get("UPLOAD_DAY_FILES", "300"))
UPLOAD_DAY_MB_UNVERIFIED = int(os.environ.get("UPLOAD_DAY_MB_UNVERIFIED", "40"))
UPLOAD_DAY_FILES_UNVERIFIED = int(os.environ.get("UPLOAD_DAY_FILES_UNVERIFIED", "30"))
MAX_JSON_KB = int(os.environ.get("MAX_JSON_KB", "512"))

# Откуда брать настоящий IP посетителя. На Render — из заголовков Cloudflare;
# за другим обратным прокси укажите, сколько адресов в конце X-Forwarded-For добавляют ваши прокси.
ON_RENDER = os.environ.get("RENDER", "").lower() == "true"
TRUSTED_PROXY_HOPS = int(os.environ.get("TRUSTED_PROXY_HOPS", "0"))
# Российский «вход» (прокси на хостинге в РФ): он подписывает запросы этим секретом и передаёт настоящий адрес посетителя
EDGE_SECRET = os.environ.get("EDGE_SECRET", "")

MAX_PHOTOS_PER_POST = 10
POST_MAX_LEN = 5000
NOTE_MAX_LEN = 500
COMMENT_MAX_LEN = 2000
MESSAGE_MAX_LEN = 4000

def _writable_dir(d: Path, fallback: Path) -> Path:
    """Постоянная папка хостинга может быть недоступна для записи (смонтирована от root) — тогда временная папка"""
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".write-test"
        probe.write_text("ok")
        probe.unlink()
        return d
    except OSError:
        fallback.mkdir(parents=True, exist_ok=True)
        print(f"Папка {d} недоступна для записи — использую {fallback}")
        return fallback


DATA_DIR = _writable_dir(DATA_DIR, Path("/tmp/yarko-data"))
# Хостинг в России: файлы из зарубежного хранилища (Supabase) отдаются через свой сервер и копируются в MEDIA_CACHE_DIR
MEDIA_PROXY = _bool("MEDIA_PROXY", False)
MEDIA_CACHE_DIR = Path(os.environ.get("MEDIA_CACHE_DIR", DATA_DIR / "media-cache"))
if "DB_PATH" not in os.environ:
    DB_PATH = DATA_DIR / "krug.db"
UPLOAD_DIR = _writable_dir(UPLOAD_DIR, Path("/tmp/yarko-uploads"))
