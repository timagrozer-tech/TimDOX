"""Бот KRUG Stickers в Telegram: помогает перенести наборы в Круг.

/start — приветствие и кнопка «Открыть KRUG». Пришлите боту любой стикер или ссылку t.me/addstickers/… —
он ответит кнопкой «Перенести в KRUG», которая открывает импорт именно этого набора.
Обновления приходят через вебхук; адрес и секрет выводятся из токена, отдельных настроек не нужно."""
import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import config, stickers2

log = logging.getLogger("krug.tgbot")


def _secret() -> str:
    token = stickers2.tg_token()
    return hashlib.sha256(("krug-webhook:" + token).encode()).hexdigest()[:40] if token else ""


def _call(method: str, payload: dict) -> dict | None:
    token = stickers2.tg_token()
    if not token:
        return None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": "KrugStickers/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"ok": False, "description": str(e.code)}
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log.warning("Telegram %s недоступен: %s", method, e)
        return None


def setup() -> None:
    """Регистрирует вебхук, описание и команды бота (повторный вызов безопасен)."""
    if not stickers2.tg_token():
        return
    url = f"{config.APP_URL.rstrip('/')}/api/telegram/webhook"
    r = _call("setWebhook", {"url": url, "secret_token": _secret(), "allowed_updates": ["message"], "drop_pending_updates": False})
    log.info("Бот Telegram: вебхук %s", "подключён" if r and r.get("ok") else f"не подключён ({(r or {}).get('description')})")
    _call("setMyCommands", {"commands": [{"command": "start", "description": "Как перенести стикеры в KRUG"}]})
    _call("setMyShortDescription", {"short_description": "Перенесу ваши стикеры из Telegram в соцсеть KRUG — в один клик."})
    _call("setMyDescription", {"description": "Пришлите мне любой стикер или ссылку на набор — дам кнопку, которая перенесёт весь набор в KRUG. "
                                              "Анимированные и видеостикеры тоже переносятся."})


def _import_url(name: str) -> str:
    return f"{config.APP_URL.rstrip('/')}/stickers?tab=import&ref={urllib.parse.quote(name)}"


def _reply(chat_id: int, text: str, buttons: list[tuple[str, str]] | None = None) -> None:
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": t, "url": u}] for t, u in buttons]}
    _call("sendMessage", payload)


def handle(update: dict) -> None:
    msg = update.get("message") or {}
    chat = msg.get("chat") or {}
    if chat.get("type") != "private" or not chat.get("id"):
        return
    cid = chat["id"]
    sticker = msg.get("sticker")
    text = (msg.get("text") or msg.get("caption") or "").strip()
    name = (sticker or {}).get("set_name")
    if not name and text and not text.startswith("/"):
        ref = stickers2.parse_tg_ref(text)
        name = ref[0] if ref and ("addstickers" in text or "addemoji" in text or text.startswith("@")) else None
    if name:
        title = name
        try:
            title = stickers2.tg_set(name).get("title") or name
        except Exception:  # noqa: BLE001 — название для красоты, без него тоже можно
            pass
        _reply(cid, f"Набор <b>{_esc(title)}</b> готов к переезду ✨\n\nНажмите кнопку — откроется KRUG, и набор перенесётся целиком, "
                    "вместе с анимациями.", [("Перенести в KRUG", _import_url(name))])
        return
    if sticker:
        _reply(cid, "У этого стикера нет набора — его не получится перенести целиком. Пришлите стикер из любого набора.")
        return
    _reply(cid, "Привет! Я помогаю перенести стикеры из Telegram в <b>KRUG</b> 💜\n\n"
                "Пришлите мне любой стикер из набора (или ссылку вида t.me/addstickers/…) — я дам кнопку, "
                "которая перенесёт весь набор в ваш KRUG.", [("Открыть KRUG", f"{config.APP_URL.rstrip('/')}/stickers?tab=import")])


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def webhook(request: Request):
    secret = _secret()
    if not secret or not hmac.compare_digest(request.headers.get("x-telegram-bot-api-secret-token", ""), secret):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    try:
        update = await request.json()
    except ValueError:
        return JSONResponse({"ok": True})
    from starlette.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(handle, update if isinstance(update, dict) else {})
    except Exception as e:  # noqa: BLE001 — Telegram не должен получать ошибку, иначе будет слать обновление снова
        log.warning("обновление бота не обработано: %s", e)
    return JSONResponse({"ok": True})


routes = [Route("/api/telegram/webhook", webhook, methods=["POST"])]
