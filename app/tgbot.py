"""Бот QEVI Stickers в Telegram — мост между Telegram и QEVI.

Что умеет:
• Привязка аккаунта QEVI (кнопка в настройках → /start link_<код>). После неё:
  – пришли стикер или ссылку на набор → набор сразу появляется в QEVI, прогресс виден прямо в сообщении;
  – пришли фото (можно с подписью) → бот вырежет фон, сделает стикер с белой обводкой, пришлёт его и сохранит в QEVI;
  – уведомления о новых сообщениях (когда вы не в сети), заявках в друзья, упоминаниях и комментариях;
  – вход в мини-приложение QEVI внутри Telegram одним касанием (подпись initData проверяется по токену бота).
• Без привязки: стикер или ссылка → кнопка импорта на сайте; фото → готовый стикер.
• /packs — моя коллекция, /notify — уведомления, /unlink — отвязать, /help.
Обновления приходят через вебхук; секрет вебхука выводится из токена — отдельных настроек нет."""
import hashlib
import hmac
import io
import json
import logging
import queue
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import config, db, stickers2
from .web import ApiError, auth, body, limit, ok

log = logging.getLogger("krug.tgbot")
BOT: dict = {"username": None}


def enabled() -> bool:
    return bool(stickers2.tg_token())


def _secret() -> str:
    token = stickers2.tg_token()
    return hashlib.sha256(("krug-webhook:" + token).encode()).hexdigest()[:40] if token else ""


def app_url(path: str = "/") -> str:
    return config.APP_URL.rstrip("/") + path


# ---------------------------------------------------------------- вызовы Bot API
def _call(method: str, payload: dict) -> dict | None:
    token = stickers2.tg_token()
    if not token:
        return None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": "KrugStickers/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"ok": False, "description": str(e.code)}
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log.warning("Telegram %s недоступен: %s", method, e)
        return None


def _upload(method: str, fields: dict, file_field: str, filename: str, data: bytes, mime: str) -> dict | None:
    """multipart/form-data — для отправки стикера-файла."""
    token = stickers2.tg_token()
    if not token:
        return None
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=b"".join(parts), method="POST",
                                 headers={"content-type": f"multipart/form-data; boundary={boundary}", "user-agent": "KrugStickers/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"ok": False, "description": str(e.code)}
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log.warning("Telegram %s (файл) недоступен: %s", method, e)
        return None


def _kb(rows: list[list[tuple[str, str]]]) -> dict:
    """Клавиатура: ("текст", "https://…") — ссылка, ("текст", "app:/путь") — мини-приложение, иначе callback_data."""
    out = []
    for row in rows:
        r = []
        for text, act in row:
            if act.startswith("http"):
                r.append({"text": text, "url": act})
            elif act.startswith("app:"):
                r.append({"text": text, "web_app": {"url": app_url(act[4:])}})
            else:
                r.append({"text": text, "callback_data": act[:64]})
        out.append(r)
    return {"inline_keyboard": out}


def send(chat_id: int, text: str, rows: list | None = None) -> int | None:
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if rows:
        payload["reply_markup"] = _kb(rows)
    r = _call("sendMessage", payload) or {}
    return (r.get("result") or {}).get("message_id")


def edit(chat_id: int, message_id: int, text: str, rows: list | None = None) -> None:
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if rows:
        payload["reply_markup"] = _kb(rows)
    _call("editMessageText", payload)


def esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- настройка бота
def bot_username() -> str | None:
    if BOT["username"]:
        return BOT["username"]
    saved = db.value("SELECT value FROM ai_state WHERE key='tg:bot_username'")
    if saved:
        BOT["username"] = saved
    return BOT["username"]


def setup() -> None:
    """Вебхук, имя бота, команды, описание и кнопка мини-приложения (повторный вызов безопасен)."""
    if not enabled():
        return
    me = (_call("getMe", {}) or {}).get("result") or {}
    if me.get("username"):
        BOT["username"] = me["username"]
        db.run("DELETE FROM ai_state WHERE key='tg:bot_username'")
        db.run("INSERT INTO ai_state (key, value) VALUES ('tg:bot_username', ?)", (me["username"],))
    r = _call("setWebhook", {"url": app_url("/api/telegram/webhook"), "secret_token": _secret(),
                             "allowed_updates": ["message", "callback_query"], "max_connections": 20})
    log.info("Бот Telegram @%s: вебхук %s", BOT["username"], "подключён" if r and r.get("ok") else f"не подключён ({(r or {}).get('description')})")
    _call("setMyCommands", {"commands": [
        {"command": "start", "description": "Что я умею"},
        {"command": "packs", "description": "Моя коллекция в QEVI"},
        {"command": "all", "description": "Перенести все наборы разом"},
        {"command": "export", "description": "Мои наборы QEVI → в Telegram"},
        {"command": "notify", "description": "Уведомления из QEVI"},
        {"command": "link", "description": "Привязать аккаунт QEVI"},
        {"command": "unlink", "description": "Отвязать аккаунт"},
        {"command": "help", "description": "Помощь"}]})
    _call("setMyName", {"name": "QEVI"})
    _call("setMyShortDescription", {"short_description": "Перенесу стикеры в QEVI, сделаю стикер из фото и пришлю уведомления."})
    _call("setMyDescription", {"description": "Мост между Telegram и соцсетью KRUG.\n\n"
                                              "• Пришлите стикер или ссылку на набор — перенесу весь набор в KRUG.\n"
                                              "• Пришлите фото (можно с подписью) — сделаю из него стикер.\n"
                                              "• Привяжите аккаунт — буду присылать уведомления, а QEVI откроется прямо в Telegram."})
    _call("setChatMenuButton", {"menu_button": {"type": "web_app", "text": "QEVI", "web_app": {"url": app_url("/")}}})


# ---------------------------------------------------------------- привязка аккаунта
def link_of_tg(tg_id: int) -> dict | None:
    return db.one("SELECT l.*, p.username, p.name FROM tg_links l JOIN profiles p ON p.user_id=l.user_id WHERE l.tg_id=?", (tg_id,))


def link_of_user(uid: int) -> dict | None:
    return db.one("SELECT * FROM tg_links WHERE user_id=?", (uid,))


def new_link_code(uid: int) -> str:
    db.run("DELETE FROM tg_link_codes WHERE user_id=? OR expires_at<?", (uid, db.now()))
    code = secrets.token_urlsafe(18).replace("-", "a").replace("_", "b")[:24]
    db.run("INSERT INTO tg_link_codes (code, user_id, expires_at) VALUES (?,?,?)", (code, uid, db.future(minutes=15)))
    return code


def _bind(code: str, frm: dict) -> dict | None:
    row = db.one("SELECT * FROM tg_link_codes WHERE code=? AND expires_at>=?", (code, db.now()))
    if not row:
        return None
    db.run("DELETE FROM tg_link_codes WHERE code=?", (code,))
    return _bind_user(row["user_id"], frm)


def _bind_user(uid: int, frm: dict) -> dict | None:
    tg_id = int(frm["id"])
    db.run("DELETE FROM tg_links WHERE user_id=? OR tg_id=?", (uid, tg_id))  # один Telegram — один аккаунт QEVI
    name = " ".join(x for x in (frm.get("first_name"), frm.get("last_name")) if x)[:64]
    db.run("INSERT INTO tg_links (user_id, tg_id, tg_username, tg_name) VALUES (?,?,?,?)", (uid, tg_id, (frm.get("username") or "")[:64], name))
    from . import social
    from .realtime import hub
    hub.publish(uid, "telegram", {"linked": True})
    social.push_counters(uid) if hasattr(social, "push_counters") else None
    return link_of_tg(tg_id)


# ---------------------------------------------------------------- сообщения боту
MAIN_ROWS_LINKED = lambda: [[("Открыть QEVI", "app:/")], [("Мои стикеры", "app:/stickers"), ("Сообщения", "app:/messages")]]  # noqa: E731


ALL_HOWTO = ("📚 <b>Как перенести все наборы разом</b>\n\n"
             "1. Telegram → Настройки → «Стикеры и эмодзи».\n"
             "2. Зажмите любой набор (на iPhone — «Изменить»), затем отметьте остальные.\n"
             "3. Нажмите «Поделиться» и выберите этот чат.\n\n"
             "Я получу ссылки на все наборы сразу и перенесу их в KRUG. Если в вашей версии Telegram нет выделения — "
             "просто пересылайте мне по одному стикеру из каждого набора.")


def _menu(cid: int, link: dict | None) -> None:
    if link:
        send(cid, f"Привет, <b>{esc(link['name'])}</b>! Аккаунт QEVI <b>@{esc(link['username'])}</b> привязан 💜\n\n"
                  "• пришлите стикер или ссылку на набор — сразу добавлю его в QEVI;\n"
                  "• пришлите фото (можно с подписью) — сделаю стикер и сохраню в QEVI;\n"
                  "• /all — как перенести все свои наборы разом;\n"
                  "• /export — ваши наборы QEVI (и 3D-стикеры) настоящим стикерпаком в Telegram;\n"
                  "• /packs — ваша коллекция, /notify — уведомления.", MAIN_ROWS_LINKED())
    else:
        send(cid, "Привет! Я мост между Telegram и <b>QEVI</b> 💜\n\n"
                  "• пришлите стикер или ссылку на набор — перенесу весь набор в QEVI;\n"
                  "• пришлите фото (можно с подписью) — сделаю из него стикер;\n"
                  "• привяжите аккаунт — наборы будут добавляться одним касанием, а уведомления из QEVI придут сюда.",
             [[("Открыть QEVI", "app:/")], [("Привязать аккаунт", "app:/settings?tab=telegram")]])


def _bar(done: int, total: int) -> str:
    n = 10
    k = round(n * done / total) if total else 0
    return "▰" * k + "▱" * (n - k) + f"  {done}/{total}"


def _import(cid: int, link: dict | None, name: str) -> None:
    try:
        s = stickers2.tg_set(name)
    except ApiError as e:
        send(cid, f"😕 {esc(e.args[1] if len(e.args) > 1 else 'Набор не найден')}")
        return
    title = s.get("title") or name
    count = len(s.get("stickers") or [])
    if not link:
        send(cid, f"Набор <b>{esc(title)}</b> · {count} стикеров ✨\n\nНажмите — QEVI откроется, и набор перенесётся целиком, вместе с анимациями. "
                  "А если привязать аккаунт, буду добавлять наборы сразу, без лишних шагов.",
             [[("Перенести в QEVI", "app:/stickers?tab=import&ref=" + urllib.parse.quote(name))],
              [("📦 Скачать ZIP", f"zip:{name}"), ("Привязать аккаунт", "app:/settings?tab=telegram")]])
        return
    stickers2.remember_sets(link["user_id"], [s["name"]])
    try:
        job = stickers2.start_tg_import(link["user_id"], name)
    except ApiError as e:
        send(cid, f"😕 {esc(e.args[1] if len(e.args) > 1 else 'Не получилось')}")
        return
    if job["status"] == "done":
        send(cid, f"✅ <b>{esc(title)}</b> уже в вашем QEVI — {job['done']} стикеров.",
             [[("Открыть набор", f"app:/stickers/{job.get('slug') or ''}")], [("📦 Скачать ZIP", f"zip:{name}")]])
        return
    mid = send(cid, f"⏳ Переношу <b>{esc(title)}</b>\n{_bar(0, job['total'] or count)}")
    threading.Thread(target=_watch, args=(cid, mid, job["id"], title), daemon=True).start()


def _import_many(cid: int, link: dict | None, names: list[str]) -> None:
    n = len(names)
    if not link:
        refs = ",".join(names)
        rows = [[("Привязать аккаунт", "app:/settings?tab=telegram")]]
        if len(refs) < 900:
            rows.insert(0, [("Перенести все на сайте", "app:/stickers?tab=import&ref=" + urllib.parse.quote(refs))])
        send(cid, f"Нашёл <b>{n}</b> наборов ✨\n\nПривяжите аккаунт QEVI — и я перенесу их все разом, а на сайте они появятся "
                  "в списке «Ваши наборы из Telegram».", rows)
        return
    uid = link["user_id"]
    mid = send(cid, f"📥 Нашёл <b>{n}</b> наборов — запоминаю…")
    sets = stickers2.remember_sets(uid, names)
    if not sets:
        edit(cid, mid, "😕 Эти наборы не нашлись в Telegram.") if mid else None
        return
    total = len(sets)
    state = {"last": 0.0}

    def progress(i, todo, name, ok):
        if mid and (time.time() - state["last"] > 2.5 or i == todo):
            state["last"] = time.time()
            edit(cid, mid, f"⏳ Переношу наборы в QEVI\n{_bar(i, todo)}\nСейчас: {esc(name)}")

    if mid:
        edit(cid, mid, f"⏳ Переношу <b>{total}</b> наборов в QEVI — по одному, это займёт пару минут.\n{_bar(0, total)}")
    r = stickers2.import_many(uid, [x["name"] for x in sets], progress)
    lines = [f"✅ Готово: в вашем QEVI <b>{r['done']}</b> из {r['total']} наборов."]
    if r["already"]:
        lines.append(f"Уже были раньше: {r['already']}.")
    if r["failed"]:
        lines.append(f"Не получилось: {r['failed']} ({esc(r['errors'][0]) if r['errors'] else 'ошибка'}).")
    rows = [[("Открыть коллекцию", "app:/stickers?tab=collection")], [("Ваши наборы из Telegram", "app:/stickers?tab=import")]]
    edit(cid, mid, "\n".join(lines), rows) if mid else send(cid, "\n".join(lines), rows)


def _watch(cid: int, mid: int | None, job_id: int, title: str) -> None:
    last = -1
    for _ in range(150):
        time.sleep(2)
        j = db.one("SELECT * FROM sticker_imports WHERE id=?", (job_id,))
        if not j:
            return
        if j["status"] in ("done", "error"):
            view = stickers2.job_view(j)
            if j["status"] == "done":
                text, rows = f"✅ <b>{esc(title)}</b> в вашем QEVI — {j['done']} стикеров.\nИщите во вкладке «Стикеры» в любом чате.", \
                    [[("Открыть набор", f"app:/stickers/{view.get('slug') or ''}")]]
            else:
                text, rows = f"😕 Не получилось перенести <b>{esc(title)}</b>: {esc(j['error'] or 'ошибка')}", None
            edit(cid, mid, text, rows) if mid else send(cid, text, rows)
            return
        if mid and j["done"] != last and j["done"] % 3 == 0:
            last = j["done"]
            edit(cid, mid, f"⏳ Переношу <b>{esc(title)}</b>\n{_bar(j['done'], j['total'])}")


def _photo_sticker(cid: int, link: dict | None, file_id: str, caption: str) -> None:
    from . import stickerart
    _call("sendChatAction", {"chat_id": cid, "action": "choose_sticker"})
    try:
        raw = stickers2._tg_download(file_id, 10 * 1024 * 1024)
        try:
            src = stickerart.remove_background(raw)
        except ApiError:
            src = raw   # фон не отделился — делаем стикер из картинки целиком
        params = {"outline": "white", "shadow": True}
        if caption:
            params["text"] = caption[:40]
        img, _ = stickerart.remix(src, params, 512)
    except ApiError as e:
        send(cid, f"😕 {esc(e.args[1] if len(e.args) > 1 else 'Не получилось сделать стикер')}")
        return
    _upload("sendSticker", {"chat_id": cid, "emoji": "✨"}, "sticker", "sticker.webp", img, "image/webp")
    if link:
        from .api.stickers import _lab_target, _store_result
        pid = _lab_target(link["user_id"], None, "Из Telegram")
        st = _store_result(link["user_id"], pid, img, False, "✨", "telegram фото")
        slug = db.value("SELECT slug FROM sticker_packs WHERE id=?", (pid,))
        send(cid, "Сохранил в QEVI, набор «Из Telegram» ✨", [[("Открыть набор", f"app:/stickers/{slug}")]])
        return st
    send(cid, "Готово! Сохраните стикер в Telegram или привяжите QEVI — буду складывать такие стикеры в ваш набор.",
         [[("Привязать аккаунт", "app:/settings?tab=telegram")]])


_zip_busy: dict = {}
EXT = {"tgs": "tgs", "webm": "webm"}


def _send_document(cid: int, filename: str, data: bytes, caption: str) -> None:
    _upload("sendDocument", {"chat_id": cid, "caption": caption, "parse_mode": "HTML"}, "document", filename, data, "application/zip")


def _zip(cid: int, tg_id: int, name: str) -> None:
    """Архив набора в исходных форматах (webp / tgs / webm) — до 45 МБ, один архив в минуту на человека."""
    import zipfile
    if time.time() - _zip_busy.get(tg_id, 0) < 60:
        send(cid, "Один архив в минуту — подождите немного ⏳")
        return
    _zip_busy[tg_id] = time.time()
    try:
        s = stickers2.tg_set(name)
    except ApiError as e:
        send(cid, f"😕 {esc(e.args[1] if len(e.args) > 1 else 'Набор не найден')}")
        return
    _call("sendChatAction", {"chat_id": cid, "action": "upload_document"})
    buf, total, n = io.BytesIO(), 0, 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, st in enumerate((s.get("stickers") or [])[:200], 1):
            ext = "tgs" if st.get("is_animated") else "webm" if st.get("is_video") else "webp"
            try:
                data = stickers2._tg_download(st["file_id"], 20 * 1024 * 1024)
            except ApiError:
                continue
            total += len(data)
            if total > 45 * 1024 * 1024:
                break
            z.writestr(f"{i:03d}.{ext}", data)
            n += 1
    if not n:
        send(cid, "😕 Не удалось скачать стикеры этого набора.")
        return
    safe = "".join(ch for ch in name if ch.isalnum() or ch in "_-")[:60] or "stickers"
    _send_document(cid, f"{safe}.zip", buf.getvalue(), f"📦 <b>{esc(s.get('title') or name)}</b> — {n} стикеров")


def _export_menu(cid: int, link: dict) -> None:
    rows = db.all("""SELECT p.id, p.title, (SELECT count(*) FROM stickers s WHERE s.pack_id=p.id) AS n FROM sticker_packs p
                     WHERE p.owner_id=? AND COALESCE(p.source,'own')<>'telegram' ORDER BY p.id DESC LIMIT 12""", (link["user_id"],))
    rows = [r for r in rows if r["n"]]
    if not rows:
        return send(cid, "У вас пока нет своих наборов в KRUG. Создайте 3D-аватар — и получите набор стикеров с вашим персонажем 😎",
                    [[("Создать в QEVI", "app:/stickers")]])
    send(cid, "📤 Какой набор QEVI отправить в Telegram? Я создам настоящий стикерпак — он будет вашим.",
         [[(f"{r['title'][:40]} · {r['n']}", f"ex:{r['id']}")] for r in rows])


def _notify_rows(link: dict) -> list:
    on = lambda v: "🔔" if v else "🔕"  # noqa: E731
    return [[(f"{on(link['notify_messages'])} Сообщения", "n:m")], [(f"{on(link['notify_social'])} Друзья и упоминания", "n:s")],
            [(f"{'🔓' if link['webapp_login'] else '🔒'} Вход в QEVI из Telegram", "n:w")]]


def _packs(cid: int, link: dict) -> None:
    rows = db.all("""SELECT p.title, p.slug, (SELECT count(*) FROM stickers s WHERE s.pack_id=p.id) AS n FROM sticker_packs p
                     JOIN user_sticker_packs u ON u.pack_id=p.id WHERE u.user_id=? ORDER BY u.added_at DESC LIMIT 8""", (link["user_id"],))
    total = db.value("SELECT count(*) FROM user_sticker_packs WHERE user_id=?", (link["user_id"],))
    stickers = db.value("SELECT count(*) FROM stickers s JOIN user_sticker_packs u ON u.pack_id=s.pack_id WHERE u.user_id=?", (link["user_id"],))
    lines = "\n".join(f"• {esc(r['title'])} — {r['n']}" for r in rows) or "Пока пусто — пришлите мне любой стикер."
    send(cid, f"📚 Ваша коллекция: <b>{total}</b> наборов, <b>{stickers}</b> стикеров\n\n{lines}",
         [[("Открыть коллекцию", "app:/stickers"), ("Витрина", f"app:/u/{link['username']}?tab=stickers")]])


def handle(update: dict) -> None:
    if update.get("callback_query"):
        return _callback(update["callback_query"])
    msg = update.get("message") or {}
    chat, frm = msg.get("chat") or {}, msg.get("from") or {}
    if chat.get("type") != "private" or not chat.get("id") or not frm.get("id"):
        return
    cid = chat["id"]
    link = link_of_tg(frm["id"])
    text = (msg.get("text") or "").strip()
    caption = (msg.get("caption") or "").strip()
    if text.startswith("/start link_") or text.startswith("/link "):
        code = text.split("link_", 1)[-1] if "link_" in text else text.split(" ", 1)[1]
        new = _bind(code.strip(), frm)
        if new:
            send(cid, f"🎉 Готово! Аккаунт QEVI <b>@{esc(new['username'])}</b> привязан.\n\n"
                      "Теперь стикеры и наборы, которые вы мне пришлёте, сразу попадут в QEVI, а уведомления придут сюда.", MAIN_ROWS_LINKED())
        else:
            send(cid, "Ссылка для привязки устарела. Откройте QEVI → Настройки → Telegram и нажмите «Привязать» ещё раз.",
                 [[("Открыть настройки", "app:/settings?tab=telegram")]])
        return
    if text in ("/start", "/help") or text.startswith("/start "):
        return _menu(cid, link)
    if text == "/export":
        return _export_menu(cid, link) if link else send(cid, "Сначала привяжите аккаунт KRUG.", [[("Привязать", "app:/settings?tab=telegram")]])
    if text == "/all":
        return send(cid, ALL_HOWTO)
    if text == "/link":
        return send(cid, "Откройте настройки QEVI и нажмите «Привязать Telegram» — займёт секунду.", [[("Привязать", "app:/settings?tab=telegram")]])
    if text == "/packs":
        return _packs(cid, link) if link else send(cid, "Сначала привяжите аккаунт KRUG.", [[("Привязать", "app:/settings?tab=telegram")]])
    if text == "/notify":
        return send(cid, "Что присылать из QEVI? Нажмите, чтобы включить или выключить.", _notify_rows(link)) if link \
            else send(cid, "Уведомления приходят после привязки аккаунта.", [[("Привязать", "app:/settings?tab=telegram")]])
    if text == "/unlink":
        if not link:
            return send(cid, "Аккаунт и так не привязан.")
        return send(cid, f"Отвязать аккаунт <b>@{esc(link['username'])}</b>? Уведомления перестанут приходить.", [[("Да, отвязать", "u:yes")]])
    # «Поделиться» несколькими наборами из настроек Telegram — приходит одно сообщение со множеством ссылок
    urls = [e.get("url", "") for e in (msg.get("entities") or []) + (msg.get("caption_entities") or []) if e.get("type") == "text_link"]
    many = stickers2.parse_tg_refs(text, caption, *urls)
    if len(many) >= 2:
        return _import_many(cid, link, many)
    sticker = msg.get("sticker")
    if sticker:
        if sticker.get("set_name"):
            return _import(cid, link, sticker["set_name"])
        return send(cid, "У этого стикера нет набора. Пришлите стикер из любого набора — перенесу весь набор.")
    photo = (msg.get("photo") or [None])[-1]
    doc = msg.get("document") or {}
    if photo or str(doc.get("mime_type", "")).startswith("image/"):
        return _photo_sticker(cid, link, (photo or doc)["file_id"], caption)
    src = text or caption
    ref = stickers2.parse_tg_ref(src) if src else None
    if ref and ("add" in src or src.startswith("@")):
        return _import(cid, link, ref[0])
    send(cid, "Пришлите мне стикер, ссылку на набор или фото — а я сделаю остальное ✨\n/help — что я умею.")


def _callback(q: dict) -> None:
    frm, data = q.get("from") or {}, q.get("data") or ""
    msg = q.get("message") or {}
    cid, mid = (msg.get("chat") or {}).get("id"), msg.get("message_id")
    link = link_of_tg(frm.get("id", 0))
    note = ""
    if data.startswith("zip:") and cid:
        _call("answerCallbackQuery", {"callback_query_id": q.get("id"), "text": "Собираю архив…"})
        return _zip(cid, frm.get("id", 0), data[4:])
    if not link:
        note = "Аккаунт не привязан"
    elif data.startswith("n:"):
        col = {"m": "notify_messages", "s": "notify_social", "w": "webapp_login"}.get(data[2:])
        if col:
            db.run(f"UPDATE tg_links SET {col}=1-{col} WHERE user_id=?", (link["user_id"],))
            link = link_of_tg(frm["id"])
            _call("editMessageReplyMarkup", {"chat_id": cid, "message_id": mid, "reply_markup": _kb(_notify_rows(link))})
            note = "Сохранено"
    elif data.startswith("ex:") and data[3:].isdigit():
        from . import tgexport
        p = db.one("SELECT * FROM sticker_packs WHERE id=? AND owner_id=?", (int(data[3:]), link["user_id"]))
        if not p:
            note = "Набор не найден"
        else:
            try:
                tgexport.start(link["user_id"], p)
                note = "Собираю набор…"
                send(cid, f"⏳ Отправляю <b>{esc(p['title'])}</b> в Telegram — это займёт около минуты.")
            except ApiError as e:
                note = (e.args[1] if len(e.args) > 1 else "Не получилось")[:190]
    elif data == "u:yes":
        db.run("DELETE FROM tg_links WHERE user_id=?", (link["user_id"],))
        edit(cid, mid, "Аккаунт отвязан. Привязать снова можно в настройках KRUG.")
        note = "Отвязано"
    _call("answerCallbackQuery", {"callback_query_id": q.get("id"), "text": note})


# ---------------------------------------------------------------- уведомления из QEVI
_jobs: "queue.Queue" = queue.Queue(maxsize=2000)
_last: dict = {}


def _worker() -> None:
    while True:
        fn, args = _jobs.get()
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001
            log.warning("уведомление в Telegram не отправлено: %s", e)


_thread = None


def _enqueue(fn, *args) -> None:
    global _thread
    if not enabled():
        return
    if _thread is None or not _thread.is_alive():
        _thread = threading.Thread(target=_worker, daemon=True)
        _thread.start()
    try:
        _jobs.put_nowait((fn, args))
    except queue.Full:
        pass


def _throttled(key, seconds: int) -> bool:
    now = time.time()
    if now - _last.get(key, 0) < seconds:
        return True
    _last[key] = now
    if len(_last) > 5000:
        for k in list(_last)[:2500]:
            _last.pop(k, None)
    return False


def notify_message(uid: int, sender_name: str, conv_id: int, preview: str) -> None:
    """Новое сообщение, пока человек не в сети: одно уведомление на чат раз в 2 минуты."""
    from .realtime import hub
    if not enabled() or hub.is_online(uid):
        return
    link = link_of_user(uid)
    if not link or not link["notify_messages"] or _throttled(("m", uid, conv_id), 120):
        return
    _enqueue(send, link["tg_id"], f"💬 <b>{esc(sender_name)}</b>\n{esc(preview[:300])}", [[("Ответить в QEVI", f"app:/messages/{conv_id}")]])


SOCIAL = {"friend_request": ("🤝", "хочет добавить вас в друзья", "/friends?tab=requests"),
          "mention": ("📣", "упомянул(а) вас", None), "comment": ("💭", "прокомментировал(а) вашу запись", None),
          "reply": ("↩️", "ответил(а) на ваш комментарий", None), "follow": ("✨", "подписался(-ась) на вас", None),
          "friend_accept": ("🎉", "принял(а) вашу заявку в друзья", "/friends"),
          "gift": ("🎁", "отправил(а) вам подарок", "/notifications"),
          "transfer": ("💸", "перевёл(а) вам KC", "/wallet")}


def notify_social(uid: int, actor_name: str, type_: str, post_id: int | None = None) -> None:
    if type_ not in SOCIAL or not enabled():
        return
    link = link_of_user(uid)
    if not link or not link["notify_social"] or _throttled(("s", uid, type_, post_id), 60):
        return
    ic, what, path = SOCIAL[type_]
    path = path or (f"/post/{post_id}" if post_id else "/notifications")
    _enqueue(send, link["tg_id"], f"{ic} <b>{esc(actor_name)}</b> {what}", [[("Открыть в QEVI", f"app:{path}")]])


# ---------------------------------------------------------------- вход из мини-приложения
def check_init_data(init_data: str, max_age: int = 2 * 3600) -> dict | None:
    """Проверка подписи данных мини-приложения Telegram (HMAC-SHA256 c ключом из токена бота)."""
    token = stickers2.tg_token()
    if not token or not init_data or len(init_data) > 4096:
        return None
    pairs = urllib.parse.parse_qsl(init_data, keep_blank_values=True)
    data = dict(pairs)
    got = data.pop("hash", "")
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    want = hmac.new(key, check.encode(), hashlib.sha256).hexdigest()
    if not got or not hmac.compare_digest(want, got):
        return None
    try:
        if time.time() - int(data.get("auth_date", "0")) > max_age:
            return None
        return json.loads(data.get("user") or "{}")
    except ValueError:
        return None


async def webapp_login(request: Request):
    limit(request, "auth", "tg")
    data = await body(request)
    user = check_init_data(str(data.get("init_data") or ""))
    if not user or not user.get("id"):
        raise ApiError(400, "Не удалось проверить вход из Telegram")
    link = link_of_tg(int(user["id"]))
    if not link:
        raise ApiError(404, "Этот Telegram не привязан к аккаунту QEVI — войдите как обычно и привяжите его в настройках", "tg_not_linked")
    if not link["webapp_login"]:
        raise ApiError(403, "Вход из Telegram выключен в настройках", "tg_login_off")
    from . import twofa
    if twofa.enabled(link["user_id"]):
        raise ApiError(403, "У аккаунта включена двухфакторная защита — войдите с паролем и кодом", "tg_2fa")
    if db.value("SELECT is_banned FROM users WHERE id=?", (link["user_id"],)):
        raise ApiError(403, "Аккаунт заблокирован администрацией")
    from .api.auth_routes import _finish_login
    return await _finish_login(request, link["user_id"], "telegram")


# ---------------------------------------------------------------- настройки на сайте
def _view(uid: int) -> dict:
    link = link_of_user(uid)
    return {"enabled": enabled(), "bot": bot_username(),
            "linked": {k: link[k] for k in ("tg_username", "tg_name", "notify_messages", "notify_social", "webapp_login", "linked_at")} if link else None}


@auth()
async def settings(request: Request):
    v = request.state.user["id"]
    if request.method == "PATCH":
        data = await body(request)
        for col in ("notify_messages", "notify_social", "webapp_login"):
            if col in data:
                db.run(f"UPDATE tg_links SET {col}=? WHERE user_id=?", (1 if data[col] else 0, v))
    elif request.method == "DELETE":
        link = link_of_user(v)
        db.run("DELETE FROM tg_links WHERE user_id=?", (v,))
        if link:
            _enqueue(send, link["tg_id"], "Аккаунт QEVI отвязан. Привязать снова можно в настройках.", None)
    return JSONResponse(_view(v))


@auth()
async def link_start(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    if not enabled() or not bot_username():
        raise ApiError(503, "Бот Telegram пока не подключён")
    data = await body(request)
    if data.get("init_data"):
        # открыто внутри мини-приложения: Telegram уже подписал, кто это — привязываем сразу
        tg_user = check_init_data(str(data["init_data"]), max_age=24 * 3600)
        if not tg_user or not tg_user.get("id"):
            raise ApiError(400, "Данные Telegram устарели — откройте QEVI из бота заново", "tg_init_bad")
        new = _bind_user(v, tg_user)
        if new:
            _enqueue(send, new["tg_id"], f"🎉 Готово! Аккаунт QEVI <b>@{esc(new['username'])}</b> привязан.\n\n"
                                         "Теперь стикеры и наборы, которые вы мне пришлёте, сразу попадут в QEVI, а уведомления придут сюда.",
                     MAIN_ROWS_LINKED())
        return JSONResponse(_view(v))
    code = new_link_code(v)
    return JSONResponse({"url": f"https://t.me/{bot_username()}?start=link_{code}", "expires_in": 900})


async def webhook(request: Request):
    secret = _secret()
    if not secret or not hmac.compare_digest(request.headers.get("x-telegram-bot-api-secret-token", ""), secret):
        return JSONResponse({"error": "Не найдено"}, status_code=404)
    try:
        update = await request.json()
    except ValueError:
        return JSONResponse({"ok": True})
    # отвечаем Telegram сразу, а долгую работу (скачивание, вырезание фона) делаем в фоне
    threading.Thread(target=_safe_handle, args=(update if isinstance(update, dict) else {},), daemon=True).start()
    return JSONResponse({"ok": True})


def _safe_handle(update: dict) -> None:
    try:
        handle(update)
    except Exception as e:  # noqa: BLE001
        log.warning("обновление бота не обработано: %s", e)


routes = [
    Route("/api/telegram/webhook", webhook, methods=["POST"]),
    Route("/api/telegram", settings, methods=["GET", "PATCH", "DELETE"]),
    Route("/api/telegram/link", link_start, methods=["POST"]),
    Route("/api/auth/telegram", webapp_login, methods=["POST"]),
]
_ = io  # совместимость импорта
