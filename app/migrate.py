"""Переезд на свой сервер: одноразовая передача настроек (ключей сервисов) с работающего сайта на новый сервер.

Новый сервер при первом запуске обращается сюда с токеном MIGRATE_TOKEN и получает значения переменных окружения.
Токен задаётся в настройках старого сервера только на время переезда и удаляется сразу после него."""
import hmac
import os

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


# что переносим: всё, что задаёт поведение сайта, кроме служебного окружения Render и путей на диске
KEYS = ["APP_URL", "DATABASE_URL", "DB_AUTO_SCHEMA", "KRUG_SECRET_KEY", "APP_NAME", "SESSION_DAYS",
        "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_WORLD", "AI_TICK_SECONDS", "AI_DAILY_TOKENS", "AI_CHAT_PER_DAY",
        "GROQ_API_KEY", "GROQ_MODEL", "GROQ_VISION_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OLLAMA_URL", "OLLAMA_MODEL",
        "WHISPER_MODEL", "TELEGRAM_BOT_TOKEN", "BREVO_API_KEY", "MAIL_FROM_EMAIL", "MAIL_FROM_NAME", "MAIL_WEBHOOK_SECRET",
        "MAIL_WEBHOOK_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM",
        "MEDIA_STORAGE", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_BUCKET",
        "MAX_UPLOAD_MB", "MAX_VIDEO_MB", "MAX_AUDIO_MB", "MAX_FILE_MB", "MAX_JSON_KB", "REEL_MAX_SECONDS",
        "REGISTER_PER_DAY", "REGISTER_PER_HOUR", "NEW_DIALOGS_NEW_ACCOUNT", "UPLOAD_DAY_FILES", "UPLOAD_DAY_FILES_UNVERIFIED",
        "UPLOAD_DAY_MB", "UPLOAD_DAY_MB_UNVERIFIED", "KRUG_UPDATES_LOOP"]


async def export_env(request: Request):
    token = os.environ.get("MIGRATE_TOKEN", "")
    got = request.headers.get("x-migrate-token", "")
    if len(token) < 32 or not got or not hmac.compare_digest(got, token):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    out = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    out.setdefault("TRUSTED_PROXY_HOPS", "1")  # на новом сервере перед сайтом один прокси хостинга
    return JSONResponse(out)


routes = [Route("/api/edge/env", export_env, methods=["POST"])]
