"""Экспорт наборов KRUG в Telegram: бот создаёт настоящий стикерпак от имени владельца (Bot API createNewStickerSet).

Набор принадлежит самому человеку (его Telegram-аккаунту), имя вида krug<slug>v<N>_by_<бот>. Повторный экспорт
после изменений удаляет прежнюю версию и создаёт новую. Анимированные стикеры KRUG уходят первым кадром."""
import io
import logging
import re
import threading
import time

from . import db, media
from .web import ApiError

log = logging.getLogger("krug.tgexport")
MAX_STICKERS = 120
_state: dict[int, dict] = {}   # pack_id → ход экспорта
_lock = threading.Lock()
EMOJI_OK = re.compile(r"^[©®‼-㊙\U0001F000-\U0001FAFF‍️⃣#*0-9]+$")


def _bot():
    from . import tgbot
    return tgbot


def exported(pack_id: int) -> dict | None:
    return db.one("SELECT * FROM tg_exports WHERE pack_id=?", (pack_id,))


def tg_url(p: dict) -> str | None:
    if (p.get("source") == "telegram") and p.get("source_ref"):
        return f"https://t.me/addstickers/{p['source_ref']}"
    e = exported(p["id"])
    return f"https://t.me/addstickers/{e['set_name']}" if e else None


def status(pack_id: int) -> dict:
    with _lock:
        st = dict(_state.get(pack_id) or {})
    e = exported(pack_id)
    if e:
        changed = db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pack_id,)) != e["count"] or \
            bool(db.value("SELECT 1 FROM stickers WHERE pack_id=? AND created_at>?", (pack_id, e["exported_at"])))
        st.setdefault("status", "done")
        st.update({"url": f"https://t.me/addstickers/{e['set_name']}", "exported_at": e["exported_at"], "stale": changed})
    return st or {"status": None}


def to_static_webp(data: bytes) -> bytes:
    """Любая картинка/первый кадр анимации → WEBP 512 px по длинной стороне, не больше 512 КБ (требование Telegram)."""
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    try:
        im.seek(0)
    except EOFError:
        pass
    im = im.convert("RGBA")
    w, h = im.size
    k = 512 / max(w, h)
    im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    for q in (95, 85, 75, 60, 45):
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=q, method=4)
        if buf.tell() <= 500 * 1024:
            return buf.getvalue()
    raise ApiError(400, "Стикер слишком тяжёлый для Telegram")


def _emoji(e: str) -> str:
    e = (e or "").strip()
    return e if e and EMOJI_OK.match(e) else "🙂"


def _set(pack_id: int, **kw) -> None:
    with _lock:
        _state.setdefault(pack_id, {}).update(kw)


def start(uid: int, pack: dict) -> dict:
    bot = _bot()
    if not bot.enabled() or not bot.bot_username():
        raise ApiError(503, "Бот Telegram пока не подключён")
    link = bot.link_of_user(uid)
    if not link:
        raise ApiError(409, "Сначала привяжите Telegram: Настройки → Telegram", "tg_not_linked")
    if pack.get("source") == "telegram":
        raise ApiError(400, "Этот набор и так из Telegram")
    with _lock:
        if (_state.get(pack["id"]) or {}).get("status") == "running":
            return dict(_state[pack["id"]])
    rows = db.all("SELECT * FROM stickers WHERE pack_id=? AND format NOT IN ('tgs','webm') ORDER BY position, id LIMIT ?",
                  (pack["id"], MAX_STICKERS))
    if not rows:
        raise ApiError(400, "В наборе нет стикеров, которые можно отправить в Telegram")
    with _lock:
        _state[pack["id"]] = {"status": "running", "done": 0, "total": len(rows), "error": None}
    threading.Thread(target=_run, args=(uid, link, pack, rows), daemon=True).start()
    return status(pack["id"])


def _run(uid: int, link: dict, pack: dict, rows: list[dict]) -> None:
    bot = _bot()
    pid, tg_id = pack["id"], int(link["tg_id"])
    try:
        files = []
        for i, r in enumerate(rows, 1):
            try:
                img = to_static_webp(media.read_upload(r["file"]))
                res = bot._upload("uploadStickerFile", {"user_id": tg_id, "sticker_format": "static"}, "sticker", "s.webp", img, "image/webp") or {}
                fid = (res.get("result") or {}).get("file_id")
                if fid:
                    files.append({"sticker": fid, "format": "static", "emoji_list": [_emoji(r["emoji"])]})
                elif "bot was blocked" in str(res.get("description", "")) or "user not found" in str(res.get("description", "")).lower():
                    raise ApiError(409, "Откройте бота в Telegram и нажмите «Запустить» — тогда он сможет создать набор")
            except (OSError, ValueError) as e:
                log.info("стикер %s пропущен: %s", r["id"], e)
            _set(pid, done=i)
        if not files:
            raise ApiError(400, "Telegram не принял ни один стикер")
        old = exported(pid)
        version = (old["version"] + 1) if old else 1
        if old:
            bot._call("deleteStickerSet", {"name": old["set_name"]})
        name = f"krug{pack['slug']}v{version}_by_{bot.bot_username()}"
        title = (pack["title"] or "KRUG")[:56] + " · KRUG"
        res = bot._call("createNewStickerSet", {"user_id": tg_id, "name": name, "title": title, "stickers": files[:50], "sticker_type": "regular"}) or {}
        if not res.get("ok"):
            raise ApiError(400, f"Telegram не создал набор: {res.get('description') or 'нет ответа'}")
        for f in files[50:]:
            bot._call("addStickerToSet", {"user_id": tg_id, "name": name, "sticker": f})
            time.sleep(0.05)
        db.run("DELETE FROM tg_exports WHERE pack_id=?", (pid,))
        db.run("INSERT INTO tg_exports (pack_id, user_id, set_name, version, count, exported_at) VALUES (?,?,?,?,?,?)",
               (pid, uid, name, version, db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pid,)), db.now()))
        url = f"https://t.me/addstickers/{name}"
        _set(pid, status="done", url=url)
        skipped = len(rows) - len(files)
        bot.send(tg_id, f"🎉 Набор <b>{bot.esc(pack['title'])}</b> теперь в Telegram — {len(files)} стикеров."
                        + (f"\n(пропущено: {skipped})" if skipped else "") + "\nНажмите, чтобы добавить его себе 👇",
                 [[("Добавить в Telegram", url)]])
    except ApiError as e:
        _set(pid, status="error", error=e.args[1] if len(e.args) > 1 else "Не получилось")
    except Exception as e:  # noqa: BLE001 — фоновая задача
        log.warning("экспорт набора %s не удался: %s", pid, e)
        _set(pid, status="error", error="Не получилось отправить набор в Telegram")

