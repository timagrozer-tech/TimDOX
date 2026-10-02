"""Стикеры 2.0: импорт (Telegram по ссылке или @имени, ZIP, файлы), фоновые задачи импорта и умный поиск.

Telegram: публичные наборы читаются через Bot API (getStickerSet/getFile). Для этого администратор задаёт
TELEGRAM_BOT_TOKEN — токен любого своего бота из @BotFather. Без токена импорт по ссылке честно говорит, что не подключён.
Один и тот же набор Telegram скачивается один раз: следующие люди получают его мгновенно (общий набор)."""
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from . import db, media
from .web import ApiError

log = logging.getLogger("krug.stickers2")

MAX_PACK = 200
TG_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")
ZIP_MAX_FILES, ZIP_MAX_TOTAL, FILE_MAX = 200, 80 * 1024 * 1024, 5 * 1024 * 1024
STICKER_EXT = (".png", ".webp", ".gif", ".jpg", ".jpeg", ".tgs", ".webm")
IMPORTS_PER_DAY = 15


# ---------------------------------------------------------------- Telegram
def tg_token() -> str:
    return os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


def parse_tg_ref(raw: str) -> tuple[str, str] | None:
    """Ссылка t.me/addstickers/NAME, t.me/addemoji/NAME, tg://addstickers?set=NAME, @NAME или NAME → (имя, вид)."""
    s = (raw or "").strip()
    kind = "emoji" if "addemoji" in s.lower() else "stickers"
    m = re.search(r"(?:t(?:elegram)?\.me|telegram\.dog)/add(?:stickers|emoji)/([A-Za-z0-9_]+)", s, re.I)
    if m:
        return m.group(1), kind
    m = re.search(r"tg://add(?:stickers|emoji)\?set=([A-Za-z0-9_]+)", s, re.I)
    if m:
        return m.group(1), kind
    s = s.lstrip("@")
    return (s, kind) if TG_NAME.match(s) else None


def _tg_api(method: str, **params) -> dict:
    token = tg_token()
    if not token:
        raise ApiError(503, "Импорт из Telegram пока не подключён: администратору нужно добавить TELEGRAM_BOT_TOKEN")
    url = f"https://api.telegram.org/bot{token}/{method}?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "KrugStickers/1.0"}), timeout=20) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read())
        except ValueError:
            data = {"ok": False, "description": str(e.code)}
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ApiError(502, "Telegram сейчас недоступен — попробуйте позже")
    if not data.get("ok"):
        desc = str(data.get("description") or "")
        if "STICKERSET_INVALID" in desc or "not found" in desc.lower():
            raise ApiError(404, "Такого набора в Telegram нет — проверьте ссылку")
        raise ApiError(502, "Telegram не отдал набор — попробуйте позже")
    return data["result"]


def _tg_download(file_id: str, limit: int = FILE_MAX) -> bytes:
    info = _tg_api("getFile", file_id=file_id)
    path = info.get("file_path")
    if not path or int(info.get("file_size") or 0) > limit:
        raise ApiError(400, "Файл стикера слишком большой")
    url = f"https://api.telegram.org/file/bot{tg_token()}/{path}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "KrugStickers/1.0"}), timeout=30) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ApiError(400, "Файл стикера слишком большой")
    return data


# кэш превью: имя → (время, данные набора). Через прокси миниатюр отдаём только файлы из этих наборов
_preview_cache: dict[str, tuple[float, dict]] = {}
_thumb_cache: dict[str, bytes] = {}
_lock = threading.Lock()


def tg_set(name: str) -> dict:
    key = name.lower()
    with _lock:
        hit = _preview_cache.get(key)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
    data = _tg_api("getStickerSet", name=name)
    with _lock:
        _preview_cache[key] = (time.time(), data)
        if len(_preview_cache) > 200:
            _preview_cache.pop(next(iter(_preview_cache)))
    return data


def tg_preview(name: str) -> dict:
    s = tg_set(name)
    items = s.get("stickers") or []
    anim = sum(1 for x in items if x.get("is_animated"))
    video = sum(1 for x in items if x.get("is_video"))
    existing = db.one("SELECT id, slug FROM sticker_packs WHERE source='telegram' AND lower(source_ref)=lower(?) AND shared=1", (s["name"],))
    thumbs = []
    for x in items[:12]:
        t = (x.get("thumbnail") or x.get("thumb") or {}).get("file_id") or (x["file_id"] if not (x.get("is_animated") or x.get("is_video")) else None)
        if t:
            thumbs.append(f"/api/sticker-import/tg-thumb?set={urllib.parse.quote(s['name'])}&f={urllib.parse.quote(t)}")
    return {"name": s["name"], "title": s.get("title") or s["name"], "count": len(items), "animated": anim, "video": video,
            "static": len(items) - anim - video, "size": sum(int(x.get("file_size") or 0) for x in items),
            "kind": "emoji" if s.get("sticker_type") == "custom_emoji" else "stickers", "thumbs": thumbs,
            "ready": bool(existing), "slug": existing["slug"] if existing else None}


def tg_thumb(name: str, file_id: str) -> bytes:
    s = tg_set(name)
    allowed = set()
    for x in s.get("stickers") or []:
        allowed.add(x["file_id"])
        t = (x.get("thumbnail") or x.get("thumb") or {}).get("file_id")
        if t:
            allowed.add(t)
    if file_id not in allowed:
        raise ApiError(404, "Не найдено")
    with _lock:
        if file_id in _thumb_cache:
            return _thumb_cache[file_id]
    data = _tg_download(file_id, 512 * 1024)
    with _lock:
        _thumb_cache[file_id] = data
        if len(_thumb_cache) > 400:
            _thumb_cache.pop(next(iter(_thumb_cache)))
    return data


# ---------------------------------------------------------------- задачи импорта
def _job(job_id: int, **fields) -> None:
    sets = ", ".join(f"{k}=?" for k in fields)
    db.run(f"UPDATE sticker_imports SET {sets} WHERE id=?", (*fields.values(), job_id))


def job_view(r: dict) -> dict:
    out = {k: r[k] for k in ("id", "source", "ref", "title", "status", "total", "done", "error")}
    if r["pack_id"]:
        p = db.one("SELECT slug FROM sticker_packs WHERE id=?", (r["pack_id"],))
        out["slug"] = p["slug"] if p else None
        out["pack_id"] = r["pack_id"]
    return out


def check_quota(uid: int) -> None:
    if db.value("SELECT count(*) FROM sticker_imports WHERE user_id=? AND created_at>=?", (uid, db.future(days=-1))) >= IMPORTS_PER_DAY:
        raise ApiError(429, f"Не больше {IMPORTS_PER_DAY} импортов в сутки — продолжите завтра")


def _new_pack(owner: int, title: str, source: str, ref: str | None = None, kind: str = "stickers", shared: int = 0) -> int:
    slug = secrets.token_hex(5)
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, source, source_ref, kind, shared) VALUES (?,?,?,?,?,?,?)",
                 (owner, slug, title[:64], source, ref, kind, shared)).lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (owner, pid))
    return pid


def _add(pid: int, saved: dict, emoji: str, pos: int, thumb: str | None = None, tags: str = "") -> None:
    db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position, format, thumb, tags) VALUES (?,?,?,?,?,?,?,?)",
           (pid, saved["path"], (emoji or "🙂")[:8], 1 if saved.get("animated") else 0, pos, saved.get("format", "webp"), thumb, tags))


def start_tg_import(uid: int, name: str) -> dict:
    """Набор уже есть в KRUG — мгновенно добавляем; нет — скачиваем в фоне (по стикеру за раз, с прогрессом)."""
    s = tg_set(name)
    title = (s.get("title") or s["name"])[:64]
    kind = "emoji" if s.get("sticker_type") == "custom_emoji" else "stickers"
    existing = db.one("SELECT * FROM sticker_packs WHERE source='telegram' AND lower(source_ref)=lower(?) AND shared=1", (s["name"],))
    if existing and db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (existing["id"],)):
        db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (uid, existing["id"]))
        n = db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (existing["id"],))
        jid = db.run("INSERT INTO sticker_imports (user_id, source, ref, title, status, total, done, pack_id) VALUES (?,?,?,?,?,?,?,?)",
                     (uid, "telegram", s["name"], title, "done", n, n, existing["id"])).lastrowid
        return job_view(db.one("SELECT * FROM sticker_imports WHERE id=?", (jid,)))
    check_quota(uid)
    running = db.one("SELECT * FROM sticker_imports WHERE source='telegram' AND lower(ref)=lower(?) AND status='running' AND created_at>=?",
                     (s["name"], db.future(minutes=-15)))
    if running:  # кто-то уже качает этот набор — подождём его
        jid = db.run("INSERT INTO sticker_imports (user_id, source, ref, title, status, total, done) VALUES (?,?,?,?,?,?,?)",
                     (uid, "telegram", s["name"], title, "waiting", running["total"], 0)).lastrowid
        return job_view(db.one("SELECT * FROM sticker_imports WHERE id=?", (jid,)))
    items = (s.get("stickers") or [])[:MAX_PACK]
    jid = db.run("INSERT INTO sticker_imports (user_id, source, ref, title, total) VALUES (?,?,?,?,?)",
                 (uid, "telegram", s["name"], title, len(items))).lastrowid
    threading.Thread(target=_run_tg, args=(jid, uid, s, items, title, kind), daemon=True).start()
    return job_view(db.one("SELECT * FROM sticker_imports WHERE id=?", (jid,)))


def _run_tg(jid: int, uid: int, s: dict, items: list, title: str, kind: str) -> None:
    pid = None
    try:
        pid = _new_pack(uid, title, "telegram", s["name"], kind, shared=1)
        _job(jid, pack_id=pid)
        ok = 0
        for i, x in enumerate(items):
            try:
                saved = media.store_any_sticker(_tg_download(x["file_id"]))
                thumb = None
                t = (x.get("thumbnail") or x.get("thumb") or {}).get("file_id")
                if t and saved.get("format") in ("tgs", "webm"):
                    try:
                        thumb = media.store_sticker_bytes(_tg_download(t, 512 * 1024))["path"]
                    except (ApiError, OSError):
                        thumb = None
                _add(pid, saved, x.get("emoji") or "🙂", i, thumb, title.lower())
                ok += 1
            except (ApiError, OSError, ValueError) as e:
                log.info("стикер %s пропущен: %s", x.get("file_id"), e)
            _job(jid, done=i + 1)
        if not ok:
            raise ApiError(400, "Ни один стикер не удалось скачать")
        _job(jid, status="done")
        # те, кто ждал этот же набор, получают его сразу
        for w in db.all("SELECT * FROM sticker_imports WHERE source='telegram' AND lower(ref)=lower(?) AND status='waiting'", (s["name"],)):
            db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (w["user_id"], pid))
            _job(w["id"], status="done", pack_id=pid, done=ok, total=ok)
    except Exception as e:  # noqa: BLE001 — фоновая задача: любую ошибку показываем человеку
        log.warning("импорт %s не удался: %s", s.get("name"), e)
        if pid and not db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pid,)):
            db.run("DELETE FROM sticker_packs WHERE id=?", (pid,))
        _job(jid, status="error", error=e.args[1] if isinstance(e, ApiError) and len(e.args) > 1 else "Не удалось импортировать набор")
        db.run("UPDATE sticker_imports SET status='error', error=? WHERE source='telegram' AND lower(ref)=lower(?) AND status='waiting'",
               ("Не удалось импортировать набор", s.get("name", "")))


# ---------------------------------------------------------------- архив и файлы
def unpack(name: str, data: bytes) -> list[tuple[str, bytes]]:
    """ZIP → файлы стикеров (с защитой от «зип-бомб»); одиночный файл — как есть."""
    if not name.lower().endswith(".zip") and data[:4] != b"PK\x03\x04":
        return [(name, data)]
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ApiError(400, "Архив повреждён")
    out, total = [], 0
    for info in sorted(z.infolist(), key=lambda i: i.filename):
        fn = info.filename
        if info.is_dir() or "__MACOSX" in fn or fn.split("/")[-1].startswith("."):
            continue
        if not fn.lower().endswith(STICKER_EXT):
            continue
        if info.file_size > FILE_MAX:
            continue
        total += info.file_size
        if total > ZIP_MAX_TOTAL or len(out) >= ZIP_MAX_FILES:
            break
        with z.open(info) as f:
            raw = f.read(FILE_MAX + 1)
        if len(raw) <= FILE_MAX:
            out.append((fn.split("/")[-1], raw))
    if not out:
        raise ApiError(400, "В архиве нет стикеров (PNG, WEBP, GIF, JPEG, TGS, WEBM)")
    return out


EMOJI_IN_NAME = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")


def start_file_import(uid: int, title: str, files: list[tuple[str, bytes]], pack_id: int | None = None) -> dict:
    check_quota(uid)
    files = files[:MAX_PACK]
    jid = db.run("INSERT INTO sticker_imports (user_id, source, ref, title, total) VALUES (?,?,?,?,?)",
                 (uid, "files", "", title, len(files))).lastrowid
    threading.Thread(target=_run_files, args=(jid, uid, title, files, pack_id), daemon=True).start()
    return job_view(db.one("SELECT * FROM sticker_imports WHERE id=?", (jid,)))


def _run_files(jid: int, uid: int, title: str, files: list, pack_id: int | None) -> None:
    pid = pack_id
    try:
        if not pid:
            pid = _new_pack(uid, title, "import")
        _job(jid, pack_id=pid)
        pos = (db.value("SELECT max(position) FROM stickers WHERE pack_id=?", (pid,)) or 0) + 1
        ok, last_err = 0, None
        for i, (fn, data) in enumerate(files):
            if db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pid,)) >= MAX_PACK:
                break
            try:
                saved = media.store_any_sticker(data)
                em = EMOJI_IN_NAME.search(fn)
                tag = re.sub(r"[_\-.]+", " ", fn.rsplit(".", 1)[0]).strip().lower()[:60]
                _add(pid, saved, em.group(0) if em else "🙂", pos + i, None, "" if re.fullmatch(r"[\d\s]*", tag) else tag)
                ok += 1
            except ApiError as e:
                last_err = e.args[1] if len(e.args) > 1 else None
            _job(jid, done=i + 1)
        if not ok:
            raise ApiError(400, last_err or "Ни один файл не подошёл")
        _job(jid, status="done")
    except Exception as e:  # noqa: BLE001
        if pid and not pack_id and not db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pid,)):
            db.run("DELETE FROM sticker_packs WHERE id=?", (pid,))
        _job(jid, status="error", error=e.args[1] if isinstance(e, ApiError) and len(e.args) > 1 else "Не удалось импортировать")


# ---------------------------------------------------------------- умный поиск
# слово → эмодзи: «кот» найдёт стикеры с 🐱, даже если слова нет ни в названии, ни в тегах
WORDS = {
    "кот": "🐱😺😸😹😻😼😽🙀😿😾🐈", "кошка": "🐱😺😸😹😻🐈", "котик": "🐱😺😸😻🐈", "собака": "🐶🐕🐩", "пёс": "🐶🐕", "пес": "🐶🐕",
    "щенок": "🐶", "мышь": "🐭🐁", "заяц": "🐰🐇", "кролик": "🐰🐇", "лиса": "🦊", "медведь": "🐻🧸", "панда": "🐼", "тигр": "🐯🐅",
    "лев": "🦁", "корова": "🐮", "свинья": "🐷🐖", "лягушка": "🐸", "обезьяна": "🐵🐒🙈🙉🙊", "курица": "🐔", "пингвин": "🐧",
    "птица": "🐦🐤🐥🕊", "утка": "🦆", "сова": "🦉", "волк": "🐺", "лошадь": "🐴", "единорог": "🦄", "пчела": "🐝", "бабочка": "🦋",
    "черепаха": "🐢", "змея": "🐍", "осьминог": "🐙", "дельфин": "🐬", "кит": "🐳🐋", "рыба": "🐟🐠", "акула": "🦈", "динозавр": "🦖🦕",
    "дракон": "🐉🐲", "смех": "😂🤣😆😹", "смешно": "😂🤣😆", "ржу": "😂🤣", "радость": "😄😁😊😃🥳", "счастье": "😊😄🥰",
    "улыбка": "🙂😊😄😃", "любовь": "❤️😍🥰😘💕💖💗💘💝", "люблю": "❤️😍🥰😘", "сердце": "❤️💕💖💗💘💝🧡💛💚💙💜",
    "поцелуй": "😘😗😚💋", "грусть": "😢😭😞😔☹️🙁😿", "грустно": "😢😭😞😔", "плачу": "😭😢", "слёзы": "😭😢", "слезы": "😭😢",
    "злость": "😠😡🤬👿", "злой": "😠😡🤬", "бесит": "😠😡🤬", "удивление": "😮😲😯😳🙀", "шок": "😱😳🤯😲", "страх": "😱😨😰",
    "думаю": "🤔", "думать": "🤔", "хм": "🤔🧐", "круто": "😎🔥👍💯", "класс": "👍😎🔥", "огонь": "🔥", "спать": "😴💤🛌",
    "сон": "😴💤", "устал": "😩😫🥱😴", "ок": "👌👍", "окей": "👌👍", "да": "👍✅", "нет": "👎❌🙅", "привет": "👋🤗",
    "пока": "👋", "спасибо": "🙏❤️", "пожалуйста": "🙏", "извини": "🙏😔", "праздник": "🎉🥳🎊🎈", "день рождения": "🎂🥳🎁🎉",
    "подарок": "🎁", "деньги": "💰🤑💵💸", "еда": "🍕🍔🍟🍣🍜🍩", "пицца": "🍕", "кофе": "☕", "чай": "🍵", "пиво": "🍺",
    "музыка": "🎵🎶🎧🎸", "игра": "🎮🕹", "спорт": "⚽🏀🏆", "футбол": "⚽", "машина": "🚗🏎", "космос": "🚀🌌🪐👽",
    "инопланетянин": "👽👾", "робот": "🤖", "призрак": "👻", "череп": "💀☠️", "клоун": "🤡", "дьявол": "😈👿", "ангел": "😇",
    "крутой": "😎", "очки": "😎🤓", "умник": "🤓🧐", "ботаник": "🤓", "больной": "🤒🤕🤢🤮", "тошнит": "🤢🤮", "жарко": "🥵",
    "холодно": "🥶❄️", "снег": "❄️☃️⛄", "солнце": "☀️🌞", "дождь": "🌧☔", "цветы": "🌸🌹🌻🌷💐", "цветок": "🌸🌹🌻🌷",
    "звезда": "⭐🌟✨", "магия": "✨🪄🔮", "аплодисменты": "👏", "браво": "👏🎉", "сила": "💪", "лайк": "👍❤️", "дизлайк": "👎",
    "стыд": "🙈😳", "смущение": "😳☺️🙈", "подмигивание": "😉", "язык": "😛😜😝🤪", "безумие": "🤪🤯", "взрыв": "💥🤯",
    "ждать": "⏳⌛", "время": "⏰⌛", "работа": "💻👨‍💻📈", "учёба": "📚✏️", "учеба": "📚✏️", "сердитый": "😠😡", "обнять": "🤗🫂",
    "объятия": "🤗🫂", "мем": "🤡😂🗿", "хаха": "😂🤣", "лол": "😂🤣", "кек": "😂", "вау": "😮🤩😲", "ура": "🎉🥳🙌", "спокойно": "😌🧘",
}


def words_to_emoji(q: str) -> set[str]:
    out = set()
    ql = q.lower()
    for w, ems in WORDS.items():
        if w in ql or (len(ql) >= 3 and w.startswith(ql)):
            out.update(c for c in ems if c.strip() and c != "️")
    return out


def search(uid: int, q: str, scope: str = "mine", limit: int = 80) -> list[dict]:
    """Поиск по названию набора, тегам, описанию, эмодзи и словам-эмоциям (кот → 🐱), плюс ИИ-теги картинок."""
    q = (q or "").strip().lower()[:60]
    if not q:
        return []
    terms = [t for t in re.split(r"\s+", q) if t]
    emojis = words_to_emoji(q) | {c for c in q if ord(c) > 0x2000}
    if scope == "all":
        where = "(p.owner_id IS NULL OR u.user_id IS NOT NULL OR p.owner_id = :v OR p.published = 1)"
    else:
        where = "(p.owner_id IS NULL OR u.user_id IS NOT NULL OR p.owner_id = :v)"
    rows = db.all(f"""SELECT s.*, p.title AS pack_title, p.description AS pack_desc, p.slug, p.price, p.owner_id AS pack_owner
                      FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
                      LEFT JOIN user_sticker_packs u ON u.pack_id = p.id AND u.user_id = :v
                      WHERE {where} ORDER BY s.id DESC LIMIT 6000""", {"v": uid})
    scored = []
    for r in rows:
        tags = (r["tags"] or "").lower()
        score = 0
        for t in terms:
            if t in tags:
                score += 4
            if t in (r["pack_title"] or "").lower():
                score += 2
            if t in (r["pack_desc"] or "").lower():
                score += 1
        if r["emoji"] and any(e in r["emoji"] for e in emojis):
            score += 3
        if score:
            scored.append((score, r))
    scored.sort(key=lambda x: (-x[0], -x[1]["id"]))
    return [r for _, r in scored[:limit]]


# ---------------------------------------------------------------- ИИ-теги (компьютерное зрение)
VISION_PROMPT = ("Это стикер для мессенджера. Перечисли по-русски 4–8 коротких слов для поиска: кто или что изображено, "
                 "эмоция, действие. Только JSON: {\"tags\": [\"кот\", \"радость\", ...]}")


_vision = {"model": None, "checked": 0.0}
VISION_HINTS = ("llama-4-scout", "llama-4-maverick", "vision", "-vl", "llava", "pixtral", "gemma-3")


def vision_model() -> str | None:
    """Модель с распознаванием картинок: из GROQ_VISION_MODEL или первая подходящая из списка моделей Groq (раз в 6 часов)."""
    if os.environ.get("GROQ_VISION_MODEL"):
        return os.environ["GROQ_VISION_MODEL"]
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return None
    if _vision["model"] or time.time() - _vision["checked"] < 6 * 3600:
        return _vision["model"]
    _vision["checked"] = time.time()
    try:
        req = urllib.request.Request("https://api.groq.com/openai/v1/models",
                                     headers={"authorization": f"Bearer {key}", "user-agent": "KrugStickers/1.0 (+https://krug-social.onrender.com)"})
        with urllib.request.urlopen(req, timeout=20) as r:
            ids = [m.get("id", "") for m in json.loads(r.read()).get("data", []) if m.get("active", True)]
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log.info("список моделей Groq недоступен: %s", e)
        return None
    for hint in VISION_HINTS:
        for mid in ids:
            if hint in mid.lower():
                _vision["model"] = mid
                log.info("ИИ-зрение для стикеров: %s", mid)
                return mid
    return None


def vision_chat(prompt: str, image: bytes, mime: str = "image/png", max_tokens: int = 160, temperature: float = .3) -> str | None:
    import base64
    key, model = os.environ.get("GROQ_API_KEY"), vision_model()
    if not key or not model:
        return None
    payload = {"model": model, "max_tokens": max_tokens, "temperature": temperature,
               "messages": [{"role": "user", "content": [{"type": "text", "text": prompt},
                                                         {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(image).decode()}}]}]}
    req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {key}",
                                          "user-agent": "KrugStickers/1.0 (+https://krug-social.onrender.com)"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):  # модель убрали — найдём другую
            _vision.update(model=None, checked=0.0)
        log.info("ИИ-зрение недоступно: %s", e)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TimeoutError) as e:
        log.info("ИИ-зрение недоступно: %s", e)
    return None


def vision_tags(image_png: bytes) -> list[str] | None:
    text = vision_chat(VISION_PROMPT, image_png)
    if not text:
        return None
    try:
        tags = json.loads(re.search(r"\{.*\}", text, re.S).group(0)).get("tags") or []
    except (ValueError, AttributeError):
        return None
    clean = []
    for t in tags:
        t = re.sub(r"[^\w\- ]", "", str(t).lower(), flags=re.U).strip()[:24]
        if t and t not in clean:
            clean.append(t)
    return clean[:8]


def tag_some(n: int = 6) -> int:
    """Фоновая разметка: берём несколько ещё не размеченных картинок (или миниатюр анимаций) и просим модель подписать."""
    if not os.environ.get("GROQ_API_KEY"):
        return 0
    from PIL import Image
    done = 0
    for s in db.all("SELECT id, file, thumb, format, tags FROM stickers WHERE ai_tagged=0 ORDER BY id DESC LIMIT ?", (n,)):
        src = s["thumb"] if s["format"] != "webp" else s["file"]
        tags = None
        if src:
            try:
                raw = media.read_upload(src)
                im = Image.open(io.BytesIO(raw)).convert("RGBA")
                im.thumbnail((256, 256))
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                bg.alpha_composite(im)
                buf = io.BytesIO(); bg.convert("RGB").save(buf, "PNG")
                tags = vision_tags(buf.getvalue())
            except Exception as e:  # noqa: BLE001
                log.info("стикер %s не размечен: %s", s["id"], e)
        if tags is None and src:
            break  # модель недоступна — попробуем позже, не помечая стикеры
        merged = " ".join(dict.fromkeys(((s["tags"] or "") + " " + " ".join(tags or [])).split()))[:240]
        db.run("UPDATE stickers SET tags=?, ai_tagged=1 WHERE id=?", (merged, s["id"]))
        done += 1
    return done


async def tagging_loop() -> None:
    import asyncio
    await asyncio.sleep(60)
    while True:
        try:
            n = await asyncio.to_thread(tag_some, 6)
        except Exception as e:  # noqa: BLE001
            log.warning("ИИ-разметка стикеров: %s", e)
            n = 0
        await asyncio.sleep(45 if n else 600)
