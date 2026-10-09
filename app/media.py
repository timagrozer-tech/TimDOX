"""Обработка изображений: проверка, удаление EXIF (геометки), сжатие, превью."""
import io
import os
from pathlib import Path
import urllib.request
import secrets
from collections import OrderedDict
from contextvars import ContextVar
from datetime import datetime

from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from . import config, db
from .web import ApiError

# Кто сейчас загружает файл: заполняется для каждого запроса в SecurityMiddleware.
# Так квоту не нужно передавать через все вызовы save_upload/save_media.
current_user: ContextVar[dict | None] = ContextVar("krug_media_user", default=None)


def charge_upload(nbytes: int) -> None:
    """Учитывает загрузку в дневной квоте пользователя; при превышении — 429 до следующих суток (UTC)."""
    u = current_user.get()
    if not u:
        return
    verified = bool(u.get("email_verified_at"))
    cap_mb = config.UPLOAD_DAY_MB if verified else config.UPLOAD_DAY_MB_UNVERIFIED
    cap_files = config.UPLOAD_DAY_FILES if verified else config.UPLOAD_DAY_FILES_UNVERIFIED
    day = db.now()[:10]
    row = db.one("SELECT bytes, files FROM upload_usage WHERE user_id=? AND day=?", (u["id"], day))
    used_b, used_f = (row["bytes"], row["files"]) if row else (0, 0)
    if used_f + 1 > cap_files or used_b + nbytes > cap_mb * 1024 * 1024:
        hint = "" if verified else " Подтвердите e-mail в настройках — лимит станет больше."
        raise ApiError(429, f"На сегодня лимит загрузок исчерпан.{hint}", "upload_quota")
    if row:
        db.run("UPDATE upload_usage SET bytes=bytes+?, files=files+1 WHERE user_id=? AND day=?", (nbytes, u["id"], day))
    else:
        db.run("INSERT OR IGNORE INTO upload_usage (user_id, day, bytes, files) VALUES (?,?,?,1)", (u["id"], day, nbytes))

Image.MAX_IMAGE_PIXELS = 40_000_000  # защита от «бомб» распаковки
MAX_PIXELS = 40_000_000  # больше — отказ сразу (иначе картинка займёт в памяти сотни мегабайт)
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "MPO"}
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}

PRESETS = {
    # вид: (макс. сторона основного, размер превью, обрезка превью до квадрата)
    "post": (1600, 640, False),
    "message": (1600, 480, False),
    "story": (1600, 360, False),
    "event": (1600, 800, False),
    "avatar": (512, 128, True),
    "cover": (1600, 800, False),
    "background": (2400, 480, False),
}


def _process(data: bytes, kind: str) -> dict:
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = probe.format
        if probe.size[0] * probe.size[1] > MAX_PIXELS:
            raise ApiError(400, "Изображение слишком большое — не больше 40 мегапикселей")
        probe.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ApiError(400, "Файл не является изображением или повреждён")
    if fmt not in ALLOWED_FORMATS:
        raise ApiError(400, "Поддерживаются JPEG, PNG, WebP и GIF")

    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # повернуть по EXIF, а сами метаданные не сохраняем
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "transparency" in img.info or img.mode in ("LA", "P") else "RGB")

    max_side, thumb_side, square = PRESETS[kind]
    if kind == "avatar":
        img = ImageOps.fit(img, (max_side, max_side), Image.LANCZOS)
    elif kind == "cover":
        img = ImageOps.fit(img, (1600, 500), Image.LANCZOS)
    else:
        img.thumbnail((max_side, max_side), Image.LANCZOS)

    if square:
        thumb = ImageOps.fit(img, (thumb_side, thumb_side), Image.LANCZOS)
    else:
        thumb = img.copy()
        thumb.thumbnail((thumb_side, thumb_side), Image.LANCZOS)

    sub = datetime.now().strftime("%Y/%m")
    name = secrets.token_hex(12)
    main_buf, thumb_buf = io.BytesIO(), io.BytesIO()
    img.save(main_buf, "WEBP", quality=84, method=4)
    thumb.save(thumb_buf, "WEBP", quality=78, method=4)
    return {
        "path": f"/uploads/{sub}/{name}.webp",
        "thumb": f"/uploads/{sub}/{name}_t.webp",
        "width": img.width,
        "height": img.height,
        "_files": {f"{sub}/{name}.webp": main_buf.getvalue(), f"{sub}/{name}_t.webp": thumb_buf.getvalue()},
    }


# ---------------------------------------------------------------- Хранилище файлов
# disk — папка UPLOAD_DIR (по умолчанию); db — таблица media_files (бесплатный хостинг без диска);
# supabase — Supabase Storage (отдельный бесплатный 1 ГБ, файлы раздаются через CDN).
CONTENT_TYPES = {
    "webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "gif": "image/gif",
    "mp4": "video/mp4", "webm": "video/webm", "tgs": "application/x-tgsticker", "mov": "video/quicktime",
    "weba": "audio/webm", "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "oga": "audio/ogg", "wav": "audio/wav", "flac": "audio/flac",
}


def content_type_of(rel: str) -> str:
    return CONTENT_TYPES.get(rel.rsplit(".", 1)[-1].lower(), "application/octet-stream")


def _supabase_request(method: str, path: str, data: bytes | None = None, headers: dict | None = None):
    import urllib.request
    req = urllib.request.Request(f"{config.SUPABASE_URL}/storage/v1/{path}", data=data, method=method, headers={
        "authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}", "apikey": config.SUPABASE_SERVICE_KEY, **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def cached_copy(rel: str):
    """Копия файла из хранилища на своём диске (MEDIA_CACHE_DIR): скачивается один раз, дальше берётся с диска"""
    from pathlib import Path
    if ".." in rel or rel.startswith("/"):
        return None
    target = Path(config.MEDIA_CACHE_DIR) / rel
    if target.is_file():
        return target
    url = public_url(rel)
    if url:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Yarko"}), timeout=120) as r:
                data = r.read(200 * 1048576 + 1)
        except Exception:  # noqa: BLE001 — нет файла или хранилище недоступно: браузер пойдёт по прямой ссылке
            return None
    elif config.MEDIA_STORAGE == "db":
        data = read_file(rel)  # файл в базе: один раз достаём и кладём на диск — дальше его отдаёт веб-сервер
        if not data:
            return None
    else:
        return None
    if len(data) > 200 * 1048576:
        return None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + f".{os.getpid()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)
    except OSError:
        return None
    return target


def public_url(rel: str) -> str | None:
    """Прямая ссылка на CDN (только для хранилища supabase)."""
    if config.MEDIA_STORAGE == "supabase":
        return f"{config.SUPABASE_URL}/storage/v1/object/public/{config.SUPABASE_BUCKET}/{rel}"
    return None


def _put(rel: str, data: bytes, ctype: str) -> None:
    if config.MEDIA_STORAGE == "supabase":
        _supabase_request("POST", f"object/{config.SUPABASE_BUCKET}/{rel}", data,
                          {"content-type": ctype, "cache-control": "31536000", "x-upsert": "true"})
    elif config.MEDIA_STORAGE == "db":
        from . import db
        # RETURNING path — иначе PostgreSQL вернул бы обратно весь файл
        db.run("INSERT INTO media_files (path, content_type, data) VALUES (?, ?, ?)" + (" RETURNING path" if db.IS_PG else ""),
               (rel, ctype, data))
    else:
        target = config.UPLOAD_DIR / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _store(result: dict) -> dict:
    files = result.pop("_files")
    for rel, data in files.items():
        _put(rel, data, content_type_of(rel))
    return result


def process_and_store(data: bytes, kind: str) -> dict:
    """Синхронный вариант для скриптов (seed)."""
    return _store(_process(data, kind))


# Небольшой кэш часто запрашиваемых файлов из базы (аватарки, превью): база не гоняет одно и то же по сети
_cache: "OrderedDict[str, bytes]" = OrderedDict()
_cache_size = 0
CACHE_LIMIT = 48 * 1024 * 1024
CACHE_ITEM_MAX = 1536 * 1024


def _cache_put(rel: str, data: bytes) -> None:
    global _cache_size
    if len(data) > CACHE_ITEM_MAX:
        return
    _cache[rel] = data
    _cache_size += len(data)
    while _cache_size > CACHE_LIMIT and _cache:
        _, old = _cache.popitem(last=False)
        _cache_size -= len(old)


def file_size(rel: str) -> int | None:
    """Размер файла из базы без загрузки содержимого (для перемотки видео)."""
    if rel in _cache:
        return len(_cache[rel])
    from . import db
    return db.value("SELECT length(data) FROM media_files WHERE path=?", (rel,))


def read_range(rel: str, start: int, end: int) -> bytes | None:
    """Кусок файла из базы: для видео не читаем весь ролик ради пары мегабайт."""
    if rel in _cache:
        return _cache[rel][start:end + 1]
    from . import db
    row = db.one("SELECT substr(data, ?, ?) AS part FROM media_files WHERE path=?", (start + 1, end - start + 1, rel))
    return bytes(row["part"]) if row and row["part"] is not None else None


def read_file(rel: str) -> bytes | None:
    if config.MEDIA_STORAGE == "supabase":
        return None  # раздаёт CDN — см. public_url
    if config.MEDIA_STORAGE == "db":
        if rel in _cache:
            _cache.move_to_end(rel)
            return _cache[rel]
        from . import db
        row = db.one("SELECT data FROM media_files WHERE path=?", (rel,))
        if not row:
            return None
        data = bytes(row["data"])
        _cache_put(rel, data)
        return data
    p = (config.UPLOAD_DIR / rel).resolve()
    if config.UPLOAD_DIR.resolve() in p.parents and p.is_file():
        return p.read_bytes()
    return None


def read_upload(url: str, limit: int = 8 * 1024 * 1024) -> bytes:
    """Содержимое загруженного файла по его адресу /uploads/... — из папки, базы или CDN (для обработки на сервере)."""
    if not url or not url.startswith("/uploads/") or ".." in url:
        raise ApiError(404, "Файл не найден")
    rel = url[len("/uploads/"):]
    if config.MEDIA_STORAGE == "supabase":
        import urllib.request
        with urllib.request.urlopen(public_url(rel), timeout=30) as r:
            data = r.read(limit + 1)
    else:
        data = read_file(rel)
    if data is None:
        raise ApiError(404, "Файл не найден")
    if len(data) > limit:
        raise ApiError(400, "Файл слишком большой")
    return data


# ---------------------------------------------------------------- Видео и музыка
def _sniff(data: bytes) -> str | None:
    """Определяет формат по содержимому, а не по имени файла."""
    head = data[:16]
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"M4A ", b"M4B ", b"M4P "):
            return "m4a"
        return "mov" if brand == b"qt  " else "mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "mp3"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:4] == b"fLaC":
        return "flac"
    return None


VIDEO_EXT = {"mp4", "webm", "mov"}
AUDIO_EXT = {"mp3", "m4a", "ogg", "wav", "flac"}


async def save_media(upload, kind: str) -> dict:
    """Сохраняет видео или аудио как есть (без перекодирования). kind: video | audio."""
    limit_mb = config.MAX_VIDEO_MB if kind == "video" else config.MAX_AUDIO_MB
    data = await upload.read(limit_mb * 1024 * 1024 + 1)
    if len(data) > limit_mb * 1024 * 1024:
        raise ApiError(413, f"Файл больше {limit_mb} МБ")
    ext = _sniff(data)
    allowed = VIDEO_EXT if kind == "video" else AUDIO_EXT | {"mp4", "webm"}
    if ext not in allowed:
        raise ApiError(400, "Видео: MP4, WebM или MOV" if kind == "video" else "Музыка: MP3, M4A, OGG, WAV или FLAC")
    charge_upload(len(data))
    if kind == "audio" and ext == "mp4":
        ext = "m4a"
    if kind == "audio" and ext == "webm":  # голосовые из браузера (Opus в WebM)
        ext = "weba"
    sub = datetime.now().strftime("%Y/%m")
    rel = f"{sub}/{secrets.token_hex(12)}.{ext}"
    if config.MEDIA_STORAGE == "supabase":
        await run_in_threadpool(_put, rel, data, content_type_of(rel))  # сетевой запрос — в отдельном потоке
    else:
        _put(rel, data, content_type_of(rel))
    return {"path": f"/uploads/{rel}", "size": len(data), "mime": content_type_of(rel)}


async def save_file(upload) -> dict:
    """Любой файл для сообщений. Хранится как .bin (application/octet-stream) и отдаётся только на скачивание:
    браузер никогда не откроет его как страницу, поэтому HTML/SVG/JS в файле не опасны для сайта."""
    limit_mb = config.MAX_FILE_MB
    data = await upload.read(limit_mb * 1024 * 1024 + 1)
    if len(data) > limit_mb * 1024 * 1024:
        raise ApiError(413, f"Файл больше {limit_mb} МБ")
    if not data:
        raise ApiError(400, "Файл пустой")
    charge_upload(len(data))
    sub = datetime.now().strftime("%Y/%m")
    rel = f"{sub}/{secrets.token_hex(12)}.bin"
    if config.MEDIA_STORAGE == "supabase":
        await run_in_threadpool(_put, rel, data, "application/octet-stream")
    else:
        _put(rel, data, "application/octet-stream")
    return {"path": f"/uploads/{rel}", "size": len(data)}


async def save_upload(upload, kind: str) -> dict:
    """upload — starlette UploadFile."""
    if upload.content_type not in ALLOWED_MIME:
        raise ApiError(400, "Поддерживаются JPEG, PNG, WebP и GIF")
    data = await upload.read(config.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
        raise ApiError(413, f"Файл больше {config.MAX_UPLOAD_MB} МБ")
    if not data:
        raise ApiError(400, "Пустой файл")
    charge_upload(len(data))
    result = await run_in_threadpool(_process, data, kind)  # тяжёлая обработка — в отдельном потоке
    if config.MEDIA_STORAGE == "supabase":
        return await run_in_threadpool(_store, result)
    return _store(result)                                   # запись в базу — в основном потоке


def delete_files(*urls: str | None) -> None:
    rels = []
    for url in urls:
        if not url or not url.startswith("/uploads/"):
            continue
        rel = url[len("/uploads/"):]
        if ".." in rel:
            continue
        rels += [rel] if not rel.endswith(".webp") or rel.endswith("_t.webp") else [rel, rel[:-5] + "_t.webp"]
    if not rels:
        return
    if config.MEDIA_PROXY:  # копии на диске хостинга (их отдаёт веб-сервер) удаляются вместе с оригиналом
        base = Path(config.MEDIA_CACHE_DIR).resolve()
        for r in rels:
            p = (base / r).resolve()
            if base in p.parents:
                p.unlink(missing_ok=True)
    if config.MEDIA_STORAGE == "supabase":
        import json
        try:
            _supabase_request("DELETE", f"object/{config.SUPABASE_BUCKET}", json.dumps({"prefixes": rels}).encode(),
                              {"content-type": "application/json"})
        except Exception:  # удаление не должно ронять запрос
            import logging
            logging.getLogger("krug.media").exception("Не удалось удалить файлы из хранилища")
        return
    if config.MEDIA_STORAGE == "db":
        from . import db
        db.run(f"DELETE FROM media_files WHERE path IN ({db.placeholders(rels)})", tuple(rels))
        return
    for r in rels:
        p = (config.UPLOAD_DIR / r).resolve()
        if config.UPLOAD_DIR.resolve() in p.parents:
            p.unlink(missing_ok=True)


# ---------------------------------------------------------------- Стикеры
STICKER_SIDE = 512


def _process_sticker(data: bytes) -> dict:
    """Стикер: до 512×512, прозрачность сохраняется; анимированные GIF/WebP остаются анимированными."""
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = probe.format
        if probe.size[0] * probe.size[1] > MAX_PIXELS:
            raise ApiError(400, "Изображение слишком большое — не больше 40 мегапикселей")
        probe.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ApiError(400, "Файл не является изображением или повреждён")
    if fmt not in ALLOWED_FORMATS:
        raise ApiError(400, "Стикер: PNG, WebP, GIF или JPEG")
    img = Image.open(io.BytesIO(data))
    animated = bool(getattr(img, "is_animated", False)) and getattr(img, "n_frames", 1) > 1
    buf = io.BytesIO()
    if animated:
        frames, durations = [], []
        for i in range(min(img.n_frames, 120)):
            img.seek(i)
            fr = img.convert("RGBA")
            fr.thumbnail((STICKER_SIDE, STICKER_SIDE), Image.LANCZOS)
            frames.append(fr)
            durations.append(max(20, int(img.info.get("duration", 60) or 60)))
        frames[0].save(buf, "WEBP", save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=80, method=4)
    else:
        img = ImageOps.exif_transpose(img).convert("RGBA")
        img.thumbnail((STICKER_SIDE, STICKER_SIDE), Image.LANCZOS)
        img.save(buf, "WEBP", quality=88, method=4)
    sub = datetime.now().strftime("%Y/%m")
    rel = f"{sub}/st_{secrets.token_hex(10)}.webp"
    return {"path": f"/uploads/{rel}", "animated": animated, "_files": {rel: buf.getvalue()}}


def _sprite_sticker(data: bytes, frames: int, ms: int) -> dict:
    """Лента кадров PNG (по горизонтали, одинаковые квадраты) → живой WebP-стикер по кругу."""
    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in ("PNG", "WEBP"):
            raise ApiError(400, "Кадры стикера: PNG или WebP")
        w, h = img.size
        if not (2 <= frames <= 24) or w != h * frames or not 64 <= h <= STICKER_SIDE:
            raise ApiError(400, "Неверная лента кадров")
        img = img.convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ApiError(400, "Файл не является изображением или повреждён")
    shots = [img.crop((i * h, 0, (i + 1) * h, h)) for i in range(frames)]
    buf = io.BytesIO()
    shots[0].save(buf, "WEBP", save_all=True, append_images=shots[1:], duration=max(30, min(ms, 200)), loop=0, quality=82, method=4)
    sub = datetime.now().strftime("%Y/%m")
    rel = f"{sub}/st_{secrets.token_hex(10)}.webp"
    return {"path": f"/uploads/{rel}", "animated": True, "format": "webp", "_files": {rel: buf.getvalue()}}


async def save_sprite_sticker(upload, frames: int, ms: int = 80) -> dict:
    data = await upload.read(6 * 1024 * 1024 + 1)
    if len(data) > 6 * 1024 * 1024:
        raise ApiError(413, "Слишком большой стикер")
    # стикеры 3D-аватара сайт собирает сам при каждом сохранении — в дневной лимит загрузок не считаем
    return _store(await run_in_threadpool(_sprite_sticker, data, frames, ms))


async def save_sticker(upload) -> dict:
    data = await upload.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise ApiError(413, "Стикер больше 5 МБ")
    if not data:
        raise ApiError(400, "Пустой файл")
    charge_upload(len(data))
    result = await run_in_threadpool(_process_sticker, data)
    if config.MEDIA_STORAGE == "supabase":
        return await run_in_threadpool(_store, result)
    return _store(result)


# ---------------------------------------------------------------- Стикеры 2.0: TGS (Lottie), WEBM (видео) и всё остальное
TGS_MAX, TGS_JSON_MAX, WEBM_MAX = 256 * 1024, 2 * 1024 * 1024, 2 * 1024 * 1024


def _process_tgs(data: bytes) -> dict:
    """Анимированный стикер Telegram: gzip с JSON-анимацией Lottie. Проверяем, что это действительно Lottie разумного размера."""
    import gzip
    import json
    import zlib
    if len(data) > TGS_MAX:
        raise ApiError(400, "Анимированный стикер больше 256 КБ")
    try:
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = d.decompress(data, TGS_JSON_MAX + 1)
        if len(raw) > TGS_JSON_MAX or d.unconsumed_tail:
            raise ApiError(400, "Анимация слишком большая")
        anim = json.loads(raw)
    except (zlib.error, ValueError, UnicodeDecodeError):
        raise ApiError(400, "Файл TGS повреждён")
    if not isinstance(anim, dict) or not isinstance(anim.get("layers"), list):
        raise ApiError(400, "Это не анимация Lottie")
    try:
        w, h, fr = int(anim.get("w", 0)), int(anim.get("h", 0)), float(anim.get("fr", 0))
        dur = (float(anim.get("op", 0)) - float(anim.get("ip", 0))) / fr if fr else 0
    except (TypeError, ValueError):
        raise ApiError(400, "Это не анимация Lottie")
    if not (0 < w <= 1024 and 0 < h <= 1024 and 0 < fr <= 120 and 0 < dur <= 15):
        raise ApiError(400, "Неподходящая анимация: размер до 1024 px, длина до 15 секунд")
    # без внешних ресурсов: картинки и шрифты по ссылкам позволили бы следить за теми, кто смотрит стикер
    anim.pop("fonts", None)
    anim.pop("chars", None)
    anim["assets"] = [a for a in anim.get("assets") or [] if isinstance(a, dict) and "layers" in a and not a.get("p") and not a.get("u")]
    if '"t":{"d"' in json.dumps(anim, separators=(",", ":")):  # текстовые слои требуют шрифтов — у стикеров их не бывает
        raise ApiError(400, "В анимации есть текстовые слои — такие стикеры не поддерживаются")
    out = gzip.compress(json.dumps(anim, separators=(",", ":"), ensure_ascii=False).encode(), 9)
    rel = f"{datetime.now().strftime('%Y/%m')}/st_{secrets.token_hex(10)}.tgs"
    return {"path": f"/uploads/{rel}", "animated": True, "format": "tgs", "_files": {rel: out}}


def _process_webm(data: bytes) -> dict:
    """Видеостикер: WEBM (VP9) до 2 МБ. Проверяем заголовок EBML и тип документа."""
    if len(data) > WEBM_MAX:
        raise ApiError(400, "Видеостикер больше 2 МБ")
    if data[:4] != b"\x1a\x45\xdf\xa3" or b"webm" not in data[:64]:
        raise ApiError(400, "Это не видео WEBM")
    rel = f"{datetime.now().strftime('%Y/%m')}/st_{secrets.token_hex(10)}.webm"
    return {"path": f"/uploads/{rel}", "animated": True, "format": "webm", "_files": {rel: data}}


def sniff_sticker(data: bytes) -> str:
    if data[:2] == b"\x1f\x8b":
        return "tgs"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    return "image"


def process_any_sticker(data: bytes) -> dict:
    """Любой поддерживаемый формат → внутренний формат Yarko: картинки и GIF → WebP (анимация сохраняется), TGS и WEBM — как есть после проверки."""
    if not data:
        raise ApiError(400, "Пустой файл")
    kind = sniff_sticker(data)
    if kind == "tgs":
        return _process_tgs(data)
    if kind == "webm":
        return _process_webm(data)
    r = _process_sticker(data)
    r["format"] = "webp"
    return r


async def save_any_sticker(data: bytes) -> dict:
    charge_upload(len(data))
    result = await run_in_threadpool(process_any_sticker, data)
    if config.MEDIA_STORAGE == "supabase":
        return await run_in_threadpool(_store, result)
    return _store(result)


def store_any_sticker(data: bytes) -> dict:
    """Синхронно (фоновые задачи импорта, без квоты пользователя)."""
    return _store(process_any_sticker(data))


def store_sticker_bytes(data: bytes) -> dict:
    """Для встроенного набора (генерируется при запуске)."""
    return _store(_process_sticker(data))
