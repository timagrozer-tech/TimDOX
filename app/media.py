"""Обработка изображений: проверка, удаление EXIF (геометки), сжатие, превью."""
import io
import secrets
from datetime import datetime

from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from . import config
from .web import ApiError

Image.MAX_IMAGE_PIXELS = 40_000_000  # защита от «бомб» распаковки
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
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
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
        db.run("INSERT INTO media_files (path, content_type, data) VALUES (?, ?, ?)", (rel, ctype, data))
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


def read_file(rel: str) -> bytes | None:
    if config.MEDIA_STORAGE == "supabase":
        return None  # раздаёт CDN — см. public_url
    if config.MEDIA_STORAGE == "db":
        from . import db
        row = db.one("SELECT data FROM media_files WHERE path=?", (rel,))
        return bytes(row["data"]) if row else None
    p = (config.UPLOAD_DIR / rel).resolve()
    if config.UPLOAD_DIR.resolve() in p.parents and p.is_file():
        return p.read_bytes()
    return None


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


async def save_upload(upload, kind: str) -> dict:
    """upload — starlette UploadFile."""
    if upload.content_type not in ALLOWED_MIME:
        raise ApiError(400, "Поддерживаются JPEG, PNG, WebP и GIF")
    data = await upload.read(config.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
        raise ApiError(413, f"Файл больше {config.MAX_UPLOAD_MB} МБ")
    if not data:
        raise ApiError(400, "Пустой файл")
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


async def save_sticker(upload) -> dict:
    data = await upload.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise ApiError(413, "Стикер больше 5 МБ")
    if not data:
        raise ApiError(400, "Пустой файл")
    result = await run_in_threadpool(_process_sticker, data)
    if config.MEDIA_STORAGE == "supabase":
        return await run_in_threadpool(_store, result)
    return _store(result)


def store_sticker_bytes(data: bytes) -> dict:
    """Для встроенного набора (генерируется при запуске)."""
    return _store(_process_sticker(data))
