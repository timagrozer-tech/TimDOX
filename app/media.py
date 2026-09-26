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
# disk — папка UPLOAD_DIR (по умолчанию); db — таблица media_files (бесплатный хостинг без диска)
def _store(result: dict) -> dict:
    files = result.pop("_files")
    for rel, data in files.items():
        if config.MEDIA_STORAGE == "db":
            from . import db
            db.run("INSERT INTO media_files (path, content_type, data) VALUES (?, 'image/webp', ?)", (rel, data))
        else:
            target = config.UPLOAD_DIR / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return result


def process_and_store(data: bytes, kind: str) -> dict:
    """Синхронный вариант для скриптов (seed)."""
    return _store(_process(data, kind))


def read_file(rel: str) -> bytes | None:
    if config.MEDIA_STORAGE == "db":
        from . import db
        row = db.one("SELECT data FROM media_files WHERE path=?", (rel,))
        return bytes(row["data"]) if row else None
    p = (config.UPLOAD_DIR / rel).resolve()
    if config.UPLOAD_DIR.resolve() in p.parents and p.is_file():
        return p.read_bytes()
    return None


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
    return _store(result)                                   # запись в хранилище — в основном потоке


def delete_files(*urls: str | None) -> None:
    for url in urls:
        if not url or not url.startswith("/uploads/"):
            continue
        rel = url[len("/uploads/"):]
        rels = [rel] if rel.endswith("_t.webp") else [rel, rel[:-5] + "_t.webp"]
        if config.MEDIA_STORAGE == "db":
            from . import db
            db.run(f"DELETE FROM media_files WHERE path IN ({db.placeholders(rels)})", tuple(rels))
            continue
        for r in rels:
            p = (config.UPLOAD_DIR / r).resolve()
            if config.UPLOAD_DIR.resolve() in p.parents:
                p.unlink(missing_ok=True)
