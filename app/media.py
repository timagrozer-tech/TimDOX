"""Обработка изображений: проверка, удаление EXIF (геометки), сжатие, превью."""
import io
import secrets
from datetime import datetime
from pathlib import Path

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
    folder = config.UPLOAD_DIR / sub
    folder.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(12)
    main_path = folder / f"{name}.webp"
    thumb_path = folder / f"{name}_t.webp"
    img.save(main_path, "WEBP", quality=84, method=4)
    thumb.save(thumb_path, "WEBP", quality=78, method=4)
    return {
        "path": f"/uploads/{sub}/{name}.webp",
        "thumb": f"/uploads/{sub}/{name}_t.webp",
        "width": img.width,
        "height": img.height,
    }


async def save_upload(upload, kind: str) -> dict:
    """upload — starlette UploadFile."""
    if upload.content_type not in ALLOWED_MIME:
        raise ApiError(400, "Поддерживаются JPEG, PNG, WebP и GIF")
    data = await upload.read(config.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
        raise ApiError(413, f"Файл больше {config.MAX_UPLOAD_MB} МБ")
    if not data:
        raise ApiError(400, "Пустой файл")
    return await run_in_threadpool(_process, data, kind)


def delete_files(*urls: str | None) -> None:
    for url in urls:
        if not url or not url.startswith("/uploads/"):
            continue
        p = (config.UPLOAD_DIR / url[len("/uploads/"):]).resolve()
        if config.UPLOAD_DIR.resolve() in p.parents:
            p.unlink(missing_ok=True)
            if not p.stem.endswith("_t"):
                p.with_name(p.stem + "_t.webp").unlink(missing_ok=True)
