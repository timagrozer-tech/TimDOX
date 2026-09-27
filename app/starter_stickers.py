"""Встроенный набор стикеров «Кружок» — рисуется кодом при первом запуске (без внешних файлов)."""
import io
import logging
import math

from PIL import Image, ImageDraw, ImageFont

from . import db, media

log = logging.getLogger("krug.stickers")
SLUG = "krug"
S = 1024  # рисуем крупно и уменьшаем — так края гладкие


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # старый Pillow
        return ImageFont.load_default()


def _body(d: ImageDraw.ImageDraw, color=(124, 92, 255), top=(186, 164, 255)):
    cx, cy, r = S // 2, S // 2 + 40, 360
    # тень
    d.ellipse((cx - 300, cy + r - 40, cx + 300, cy + r + 30), fill=(0, 0, 0, 55))
    # тело с «градиентом» из концентрических кругов
    for i in range(60):
        t = i / 59
        rr = r - i * 3
        col = tuple(int(color[k] + (top[k] - color[k]) * t) for k in range(3)) + (255,)
        d.ellipse((cx - rr - i * 0.6, cy - rr - i * 1.8, cx + rr - i * 0.6, cy + rr - i * 1.8), fill=col)
    # контур и блик
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(40, 20, 120, 255), width=18)
    d.ellipse((cx - 230, cy - 290, cx - 90, cy - 190), fill=(255, 255, 255, 150))
    return cx, cy


def _eyes(d, cx, cy, kind="open"):
    for dx in (-130, 130):
        x, y = cx + dx, cy - 60
        if kind == "open":
            d.ellipse((x - 62, y - 78, x + 62, y + 78), fill="white", outline=(40, 20, 120), width=12)
            d.ellipse((x - 30, y - 30, x + 34, y + 44), fill=(30, 20, 60))
            d.ellipse((x - 14, y - 22, x + 6, y - 2), fill="white")
        elif kind == "happy":
            d.arc((x - 60, y - 40, x + 60, y + 60), 200, 340, fill=(40, 20, 120), width=22)
        elif kind == "closed":
            d.arc((x - 60, y - 60, x + 60, y + 30), 20, 160, fill=(40, 20, 120), width=22)
        elif kind == "heart":
            _heart(d, x, y + 10, 70, (255, 60, 110))
        elif kind == "wide":
            d.ellipse((x - 72, y - 90, x + 72, y + 90), fill="white", outline=(40, 20, 120), width=12)
            d.ellipse((x - 22, y - 20, x + 22, y + 24), fill=(30, 20, 60))


def _heart(d, x, y, s, color):
    d.ellipse((x - s, y - s * .8, x, y + s * .2), fill=color)
    d.ellipse((x, y - s * .8, x + s, y + s * .2), fill=color)
    d.polygon([(x - s * .97, y - s * .15), (x + s * .97, y - s * .15), (x, y + s * 1.05)], fill=color)


def _mouth(d, cx, cy, kind="smile"):
    y = cy + 110
    ink = (40, 20, 120)
    if kind == "smile":
        d.arc((cx - 110, y - 90, cx + 110, y + 70), 20, 160, fill=ink, width=22)
    elif kind == "open":
        d.chord((cx - 120, y - 60, cx + 120, y + 120), 0, 180, fill=(120, 20, 60), outline=ink, width=16)
        d.chord((cx - 70, y + 50, cx + 70, y + 118), 180, 360, fill=(255, 110, 140))
    elif kind == "sad":
        d.arc((cx - 90, y, cx + 90, y + 130), 200, 340, fill=ink, width=22)
    elif kind == "o":
        d.ellipse((cx - 50, y - 20, cx + 50, y + 90), fill=(120, 20, 60), outline=ink, width=14)
    elif kind == "flat":
        d.line((cx - 60, y + 40, cx + 70, y + 20), fill=ink, width=22)
    elif kind == "grr":
        d.rounded_rectangle((cx - 110, y + 10, cx + 110, y + 80), 30, fill="white", outline=ink, width=14)
        for i in range(1, 4):
            d.line((cx - 110 + i * 55, y + 12, cx - 110 + i * 55, y + 78), fill=ink, width=8)


def _blush(d, cx, cy):
    for dx in (-230, 230):
        d.ellipse((cx + dx - 55, cy + 40, cx + dx + 55, cy + 90), fill=(255, 120, 170, 140))


def _text(d, xy, text, size, fill, stroke=(40, 20, 120)):
    d.text(xy, text, font=_font(size), fill=fill, stroke_width=max(4, size // 12), stroke_fill=stroke, anchor="mm")


def _tear(d, x, y):
    d.ellipse((x - 26, y, x + 26, y + 70), fill=(90, 180, 255))
    d.polygon([(x - 24, y + 22), (x + 24, y + 22), (x, y - 30)], fill=(90, 180, 255))


def _make(kind: str) -> bytes:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == "angry":
        cx, cy = _body(d, (230, 60, 70), (255, 150, 140))
    elif kind == "sleep":
        cx, cy = _body(d, (90, 110, 220), (170, 190, 255))
    elif kind == "love":
        cx, cy = _body(d, (236, 72, 153), (255, 170, 210))
    else:
        cx, cy = _body(d)
    if kind == "hi":
        _eyes(d, cx, cy, "happy"); _mouth(d, cx, cy, "open"); _blush(d, cx, cy)
        d.ellipse((cx + 330, cy - 260, cx + 470, cy - 120), fill=(186, 164, 255), outline=(40, 20, 120), width=16)
        for a in (-40, -10, 20):
            x = cx + 400 + 150 * math.cos(math.radians(a - 60)); y = cy - 190 + 150 * math.sin(math.radians(a - 60))
            d.arc((x - 40, y - 40, x + 40, y + 40), a - 150, a - 60, fill=(255, 200, 60), width=14)
        _text(d, (cx - 200, 110), "Hi!", 150, (255, 220, 80))
    elif kind == "love":
        _eyes(d, cx, cy, "heart"); _mouth(d, cx, cy, "smile"); _blush(d, cx, cy)
        _heart(d, cx + 330, 170, 70, (255, 60, 110)); _heart(d, cx - 360, 250, 45, (255, 110, 150))
    elif kind == "lol":
        _eyes(d, cx, cy, "closed"); _mouth(d, cx, cy, "open")
        _tear(d, cx - 250, cy - 30); _tear(d, cx + 250, cy - 30)
        _text(d, (cx + 250, 120), "HA", 130, (255, 220, 80))
    elif kind == "sad":
        _eyes(d, cx, cy, "open"); _mouth(d, cx, cy, "sad"); _tear(d, cx - 130, cy + 20)
    elif kind == "angry":
        _eyes(d, cx, cy, "open"); _mouth(d, cx, cy, "grr")
        d.line((cx - 210, cy - 180, cx - 60, cy - 120), fill=(40, 20, 120), width=30)
        d.line((cx + 210, cy - 180, cx + 60, cy - 120), fill=(40, 20, 120), width=30)
        _text(d, (cx + 300, 130), "#!", 140, (255, 90, 90))
    elif kind == "wow":
        _eyes(d, cx, cy, "wide"); _mouth(d, cx, cy, "o")
        _text(d, (cx + 280, 140), "!", 200, (255, 220, 80))
    elif kind == "ok":
        _eyes(d, cx, cy, "happy"); _mouth(d, cx, cy, "smile"); _blush(d, cx, cy)
        d.rounded_rectangle((cx + 170, 70, cx + 470, 250), 60, fill="white", outline=(40, 20, 120), width=14)
        d.polygon([(cx + 220, 230), (cx + 280, 240), (cx + 190, 320)], fill="white")
        _text(d, (cx + 320, 160), "OK", 120, (80, 200, 120), stroke=(40, 20, 120))
    elif kind == "sleep":
        _eyes(d, cx, cy, "closed"); _mouth(d, cx, cy, "o")
        _text(d, (cx + 250, 200), "Z", 110, "white"); _text(d, (cx + 350, 110), "z", 90, "white")
    elif kind == "party":
        _eyes(d, cx, cy, "happy"); _mouth(d, cx, cy, "open"); _blush(d, cx, cy)
        d.polygon([(cx - 90, cy - 330), (cx + 90, cy - 330), (cx + 10, cy - 560)], fill=(255, 200, 60), outline=(40, 20, 120))
        d.ellipse((cx - 20, cy - 600, cx + 40, cy - 540), fill=(255, 90, 140))
        colors = [(255, 90, 140), (80, 200, 255), (255, 220, 80), (120, 230, 150)]
        for i in range(14):
            x = 120 + (i * 137) % 800; y = 90 + (i * 71) % 260
            d.rectangle((x, y, x + 26, y + 44), fill=colors[i % 4])
    elif kind == "hmm":
        _eyes(d, cx, cy, "open"); _mouth(d, cx, cy, "flat")
        d.line((cx - 200, cy - 170, cx - 60, cy - 190), fill=(40, 20, 120), width=26)
        _text(d, (cx + 300, 150), "?", 220, (255, 220, 80))
    img = img.resize((512, 512), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


STARTER = [("hi", "👋"), ("love", "😍"), ("lol", "😂"), ("ok", "👌"), ("wow", "😮"), ("hmm", "🤔"),
           ("sad", "😢"), ("angry", "😡"), ("party", "🎉"), ("sleep", "😴")]


def ensure_starter_pack() -> None:
    """Создаёт встроенный набор, если его ещё нет. Безопасно вызывать при каждом запуске."""
    if db.value("SELECT 1 FROM sticker_packs WHERE slug=?", (SLUG,)):
        return
    try:
        files = [(media.store_sticker_bytes(_make(k))["path"], emoji) for k, emoji in STARTER]
    except Exception:
        log.exception("Не удалось нарисовать встроенные стикеры")
        return
    cur = db.run("INSERT OR IGNORE INTO sticker_packs (owner_id, slug, title) VALUES (NULL, ?, ?)", (SLUG, "Кружок"))
    pack_id = db.value("SELECT id FROM sticker_packs WHERE slug=?", (SLUG,))
    if not cur.rowcount:  # набор успел создать другой процесс
        media.delete_files(*(f for f, _ in files))
        return
    for i, (path, emoji) in enumerate(files):
        db.run("INSERT INTO stickers (pack_id, file, emoji, position) VALUES (?,?,?,?)", (pack_id, path, emoji, i))
    log.info("Создан встроенный набор стикеров «Кружок»")
