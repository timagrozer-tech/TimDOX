"""Yarko Remix и AI Sticker Lab: обработка стикеров на сервере (Pillow).

Remix: цвет (оттенок, насыщенность, яркость, тонирование), фон, обводка, тень и свечение, надписи, новые элементы
(сердечки, искры, корона, нимб, слёзы) и анимации (прыжок, тряска, пульс, вращение, покачивание, парение, радуга, глитч).
Lab: удаление фона, улучшение и увеличение, мемы, набор стикеров из одного фото. Оригинал никогда не меняется."""
import io
import math
from collections import deque
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from .web import ApiError

SIDE = 512
FONT = Path(__file__).parent / "assets" / "fonts" / "Unbounded.ttf"
ANIMATIONS = ("none", "bounce", "shake", "pulse", "spin", "wobble", "float", "rainbow", "glitch", "jelly")
BACKGROUNDS = ("none", "circle", "square", "burst", "gradient")
ELEMENTS = ("hearts", "sparkles", "crown", "halo", "tears", "stars")
OUTLINES = ("none", "white", "black", "color")


@lru_cache(maxsize=16)
def font(size: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT), size)
    try:
        f.set_variation_by_name("Black")
    except (OSError, ValueError):
        pass
    return f


def _hex(c: str | None, default=(255, 255, 255)) -> tuple:
    c = (c or "").lstrip("#")
    if len(c) == 6:
        try:
            return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return default


def _num(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def load_frames(data: bytes, max_frames: int = 48) -> tuple[list[Image.Image], list[int]]:
    try:
        im = Image.open(io.BytesIO(data))
        if im.size[0] * im.size[1] > 40_000_000:
            raise ApiError(400, "Картинка слишком большая — не больше 40 мегапикселей")
        n = getattr(im, "n_frames", 1)
        frames, durs = [], []
        step = max(1, math.ceil(n / max_frames))
        for i in range(0, n, step):
            im.seek(i)
            frames.append(im.convert("RGBA").copy())
            durs.append(max(20, int(im.info.get("duration", 60) or 60)) * step)
        return frames, durs
    except (OSError, ValueError, Image.DecompressionBombError):
        raise ApiError(400, "Не получилось открыть картинку")


def fit(im: Image.Image, box: int) -> Image.Image:
    im = im.copy()
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    im.thumbnail((box, box), Image.LANCZOS) if max(im.size) > box else None
    if max(im.size) < box * .6:  # маленькие картинки аккуратно увеличиваем
        k = box * .8 / max(im.size)
        im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    return im


def encode(frames: list[Image.Image], durs: list[int] | None = None) -> tuple[bytes, bool]:
    buf = io.BytesIO()
    if len(frames) > 1:
        frames[0].save(buf, "WEBP", save_all=True, append_images=frames[1:], duration=durs or 60, loop=0, quality=82, method=4)
    else:
        frames[0].save(buf, "WEBP", quality=90, method=4)
    return buf.getvalue(), len(frames) > 1


# ---------------------------------------------------------------- цвет
def recolor(im: Image.Image, hue: float = 0, sat: float = 1, bright: float = 1, tint: str | None = None, tint_k: float = 0) -> Image.Image:
    a = im.getchannel("A")
    rgb = im.convert("RGB")
    if hue:
        h, s, v = rgb.convert("HSV").split()
        shift = int(hue / 360 * 255) % 256
        h = h.point(lambda x: (x + shift) % 256)
        rgb = Image.merge("HSV", (h, s, v)).convert("RGB")
    if sat != 1:
        rgb = ImageEnhance.Color(rgb).enhance(sat)
    if bright != 1:
        rgb = ImageEnhance.Brightness(rgb).enhance(bright)
    if tint and tint_k > 0:
        rgb = Image.blend(rgb, Image.new("RGB", rgb.size, _hex(tint)), min(.85, tint_k))
    out = rgb.convert("RGBA")
    out.putalpha(a)
    return out


# ---------------------------------------------------------------- обводка, тень, свечение
def outline(im: Image.Image, color=(255, 255, 255), width: int = 10) -> Image.Image:
    a = im.getchannel("A").point(lambda x: 255 if x > 40 else 0)
    grown = a
    left = width
    while left > 0:  # MaxFilter работает с нечётными размерами до ~15 — наращиваем по шагам
        k = min(left, 6)
        grown = grown.filter(ImageFilter.MaxFilter(2 * k + 1))
        left -= k
    grown = grown.filter(ImageFilter.GaussianBlur(1))
    layer = Image.new("RGBA", im.size, color + (0,))
    layer.putalpha(grown)
    layer.alpha_composite(im)
    return layer


def shadow(im: Image.Image, color=(0, 0, 0), blur: int = 10, offset=(0, 10), strength: float = .45) -> Image.Image:
    a = im.getchannel("A").filter(ImageFilter.GaussianBlur(blur)).point(lambda x: int(x * strength))
    sh = Image.new("RGBA", im.size, color + (0,))
    sh.putalpha(a)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.alpha_composite(sh, offset)
    out.alpha_composite(im)
    return out


# ---------------------------------------------------------------- фоны и элементы
def background(kind: str, color, size: int = SIDE) -> Image.Image:
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if kind == "none":
        return bg
    d = ImageDraw.Draw(bg)
    c2 = tuple(min(255, int(x * .65 + 255 * .35)) for x in color)
    pad = size * .06
    if kind == "circle":
        d.ellipse([pad, pad, size - pad, size - pad], fill=color + (255,))
    elif kind == "square":
        d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size * .2, fill=color + (255,))
    elif kind == "gradient":
        for i in range(int(size / 2 - pad), 0, -2):
            k = i / (size / 2)
            d.ellipse([size / 2 - i, size / 2 - i, size / 2 + i, size / 2 + i], fill=tuple(int(c2[j] + (color[j] - c2[j]) * k) for j in range(3)) + (255,))
    elif kind == "burst":
        cx = cy = size / 2
        pts = []
        for i in range(32):
            r = (size / 2 - pad) * (1 if i % 2 == 0 else .8)
            a = i / 32 * math.tau
            pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
        d.polygon(pts, fill=color + (255,))
        d.ellipse([size * .2, size * .2, size * .8, size * .8], fill=c2 + (255,))
    return bg


def _heart(d, x, y, r, fill):
    d.ellipse([x - r, y - r * .6, x, y + r * .4], fill=fill)
    d.ellipse([x, y - r * .6, x + r, y + r * .4], fill=fill)
    d.polygon([(x - r * .97, y - r * .02), (x + r * .97, y - r * .02), (x, y + r * 1.15)], fill=fill)


def _spark(d, x, y, r, fill):
    pts = []
    for i in range(8):
        rr = r if i % 2 == 0 else r * .28
        a = i / 8 * math.tau - math.pi / 2
        pts.append((x + math.cos(a) * rr, y + math.sin(a) * rr))
    d.polygon(pts, fill=fill)


def _star(d, x, y, r, fill):
    pts = []
    for i in range(10):
        rr = r if i % 2 == 0 else r * .45
        a = i / 10 * math.tau - math.pi / 2
        pts.append((x + math.cos(a) * rr, y + math.sin(a) * rr))
    d.polygon(pts, fill=fill)


def elements(kinds: list[str], size: int = SIDE, t: float = 0) -> Image.Image:
    """Слой с новыми элементами поверх стикера. t — фаза (0..1) для лёгкого движения в анимациях."""
    lay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    s = size / 512
    bob = math.sin(t * math.tau) * 8 * s
    for k in kinds:
        if k == "hearts":
            for (x, y, r, c) in ((70, 120, 30, (255, 64, 120)), (450, 90, 24, (255, 120, 170)), (440, 400, 34, (255, 64, 120)), (60, 420, 20, (255, 140, 180))):
                _heart(d, x * s, y * s + bob, r * s, c + (255,))
        elif k == "sparkles":
            for (x, y, r) in ((80, 80, 30), (440, 140, 22), (420, 440, 34), (90, 380, 18), (260, 40, 16)):
                _spark(d, x * s, y * s - bob, r * s * (1 + .2 * math.sin((t + x / 500) * math.tau)), (255, 236, 140, 255))
        elif k == "stars":
            for (x, y, r) in ((70, 90, 26), (450, 110, 30), (440, 420, 22), (70, 410, 28)):
                _star(d, x * s, y * s + bob, r * s, (255, 210, 60, 255))
        elif k == "crown":
            cx, top = 256 * s, 18 * s + bob
            w, hh = 150 * s, 80 * s
            d.polygon([(cx - w / 2, top + hh), (cx - w / 2, top + hh * .3), (cx - w / 4, top + hh * .65), (cx, top),
                       (cx + w / 4, top + hh * .65), (cx + w / 2, top + hh * .3), (cx + w / 2, top + hh)], fill=(250, 196, 50, 255), outline=(190, 130, 20, 255), width=int(4 * s))
            for x in (-w / 4, 0, w / 4):
                d.ellipse([cx + x - 9 * s, top + hh * .7 - 9 * s, cx + x + 9 * s, top + hh * .7 + 9 * s], fill=(230, 40, 80, 255))
        elif k == "halo":
            d.ellipse([150 * s, 8 * s + bob, 362 * s, 58 * s + bob], outline=(255, 226, 110, 255), width=int(12 * s))
        elif k == "tears":
            for x in (190, 322):
                y = 270 + (t * 120 % 120)
                d.ellipse([(x - 12) * s, y * s, (x + 12) * s, (y + 30) * s], fill=(110, 200, 255, 230))
    return lay


# ---------------------------------------------------------------- надписи
def caption(lay: Image.Image, text: str, where: str = "bottom", color=(255, 255, 255), stroke=(0, 0, 0), meme: bool = False) -> None:
    text = (text or "").strip()[:48]
    if not text:
        return
    if meme:
        text = text.upper()
    d = ImageDraw.Draw(lay)
    w = lay.width
    size = int(w * (.13 if meme else .1))
    lines = [text]
    while size > w * .05:
        f = font(size)
        lines = _wrap(text, f, w * .9)
        if len(lines) <= 2:
            break
        size -= 4
    f = font(size)
    lh = int(size * 1.15)
    total = lh * len(lines)
    y = int(w * .03) if where == "top" else (w - total - int(w * .04) if where == "bottom" else (w - total) // 2)
    for ln in lines:
        tw = d.textlength(ln, font=f)
        d.text(((w - tw) / 2, y), ln, font=f, fill=color + (255,), stroke_width=max(3, size // 9), stroke_fill=stroke + (255,))
        y += lh


def _wrap(text: str, f, width: float) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if f.getlength(t) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = wd
    lines.append(cur)
    return lines


# ---------------------------------------------------------------- анимации
def animate(base: Image.Image, kind: str, elements_kinds: list[str], n: int = 16) -> tuple[list[Image.Image], list[int]]:
    frames = []
    S = base.width
    for i in range(n):
        t = i / n
        fr = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        im = base
        dx = dy = 0
        if kind == "bounce":
            dy = -abs(math.sin(t * math.pi)) * S * .08
            sq = 1 + .06 * max(0, math.cos(t * math.tau))
            im = base.resize((int(S * sq), int(S / sq)), Image.BICUBIC)
        elif kind == "shake":
            dx = math.sin(t * math.tau * 4) * S * .025
            im = base.rotate(math.sin(t * math.tau * 4) * 6, Image.BICUBIC)
        elif kind == "pulse":
            k = 1 + .08 * math.sin(t * math.tau)
            im = base.resize((int(S * k), int(S * k)), Image.BICUBIC)
        elif kind == "spin":
            im = base.rotate(-t * 360, Image.BICUBIC)
        elif kind == "wobble":
            im = base.rotate(math.sin(t * math.tau) * 12, Image.BICUBIC)
        elif kind == "float":
            dy = math.sin(t * math.tau) * S * .04
        elif kind == "jelly":
            kx = 1 + .07 * math.sin(t * math.tau)
            im = base.resize((int(S * kx), int(S / kx)), Image.BICUBIC)
        elif kind == "rainbow":
            im = recolor(base, hue=t * 360)
        elif kind == "glitch":
            if i % 4 in (1, 2):
                r, g, b, a = base.split()
                off = int(S * .02) * (1 if i % 2 else -1)
                im = Image.merge("RGBA", (ImageChops.offset(r, off, 0), g, ImageChops.offset(b, -off, 0), a))
                dx = off
        fr.alpha_composite(im, (int((S - im.width) / 2 + dx), int((S - im.height) / 2 + dy)))
        if elements_kinds:
            fr.alpha_composite(elements(elements_kinds, S, t))
        frames.append(fr)
    return frames, [70] * n


# ---------------------------------------------------------------- Remix целиком
def remix(data: bytes, p: dict, size: int = SIDE) -> tuple[bytes, bool]:
    """Параметры: hue, sat, bright, tint, tint_k, bg, bg_color, outline, outline_color, outline_w, shadow, glow, glow_color,
    text, text_pos, text_color, stroke_color, meme_top, meme_bottom, elements[], anim."""
    frames, durs = load_frames(data)
    anim = p.get("anim") if p.get("anim") in ANIMATIONS else "none"
    els = [e for e in (p.get("elements") or []) if e in ELEMENTS][:4]
    bg_kind = p.get("bg") if p.get("bg") in BACKGROUNDS else "none"
    ol = p.get("outline") if p.get("outline") in OUTLINES else "none"
    hue, sat, bright = _num(p.get("hue"), -180, 180, 0), _num(p.get("sat"), 0, 2.5, 1), _num(p.get("bright"), .3, 1.8, 1)
    tint_k = _num(p.get("tint_k"), 0, .85, 0)
    has_text = bool((p.get("text") or "").strip() or (p.get("meme_top") or "").strip() or (p.get("meme_bottom") or "").strip())
    box = int(size * (.62 if has_text and bg_kind != "none" else .7 if has_text or bg_kind != "none" or ol != "none" else .9))
    out_frames = []

    def compose(fr: Image.Image, t: float = 0, with_elements: bool = True) -> Image.Image:
        im = recolor(fit(fr, box), hue, sat, bright, p.get("tint"), tint_k)
        if ol != "none":
            col = (255, 255, 255) if ol == "white" else (17, 17, 17) if ol == "black" else _hex(p.get("outline_color"))
            pad = int(_num(p.get("outline_w"), 2, 24, 10))
            im = ImageOps.expand(im, pad, (0, 0, 0, 0))
            im = outline(im, col, pad)
        if p.get("glow"):
            g = Image.new("RGBA", (im.width + 40, im.height + 40), (0, 0, 0, 0)); g.alpha_composite(im, (20, 20))
            im = shadow(g, _hex(p.get("glow_color"), (255, 220, 90)), 14, (0, 0), .9)
        if p.get("shadow"):
            g = Image.new("RGBA", (im.width + 40, im.height + 40), (0, 0, 0, 0)); g.alpha_composite(im, (20, 10))
            im = shadow(g)
        canvas = background(bg_kind, _hex(p.get("bg_color"), (124, 92, 255)), size)
        y = (size - im.height) // 2
        if has_text and (p.get("text_pos") or "bottom") == "bottom" and not p.get("meme_top"):
            y = max(0, int(size * .45 - im.height / 2))
        elif has_text and (p.get("text_pos") == "top"):
            y = min(size - im.height, int(size * .56 - im.height / 2))
        canvas.alpha_composite(im, ((size - im.width) // 2, max(0, y)))
        if with_elements and els:
            canvas.alpha_composite(elements(els, size, t))
        tc, sc = _hex(p.get("text_color")), _hex(p.get("stroke_color"), (0, 0, 0))
        if p.get("meme_top") or p.get("meme_bottom"):
            caption(canvas, p.get("meme_top") or "", "top", tc, sc, meme=True)
            caption(canvas, p.get("meme_bottom") or "", "bottom", tc, sc, meme=True)
        elif p.get("text"):
            caption(canvas, p["text"], p.get("text_pos") or "bottom", tc, sc)
        return canvas

    if len(frames) == 1 and anim != "none":
        base = compose(frames[0], with_elements=False)
        out_frames, durs = animate(base, anim, els)
    else:
        n = len(frames)
        out_frames = [compose(fr, i / max(1, n)) for i, fr in enumerate(frames)]
        if len(frames) == 1 and els and p.get("anim_elements"):
            out_frames, durs = animate(out_frames[0], "none", els)
    return encode(out_frames, durs)


# ---------------------------------------------------------------- AI Lab: фон, качество
def remove_background(data: bytes, tolerance: int = 38) -> bytes:
    """Убирает фон, который «касается краёв»: заливка от краёв по похожему цвету, сглаживание кромки.
    Лучше всего работает на однотонном или спокойном фоне (как у большинства фото для стикеров)."""
    frames, _ = load_frames(data, 1)
    im = frames[0]
    im.thumbnail((1024, 1024), Image.LANCZOS)
    a0 = im.getchannel("A")
    if a0.getextrema()[0] < 200 and sum(a0.histogram()[:128]) > im.width * im.height * .08:
        return encode([im])[0]  # уже есть прозрачность
    small = im.convert("RGB")
    k = 220 / max(small.size)
    small = small.resize((max(1, int(small.width * k)), max(1, int(small.height * k))), Image.BILINEAR).filter(ImageFilter.MedianFilter(3))
    W, H = small.size
    px = small.load()
    seen = bytearray(W * H)
    q = deque()
    for x in range(W):
        q.append((x, 0)); q.append((x, H - 1))
    for y in range(H):
        q.append((0, y)); q.append((W - 1, y))
    # цвета фона — самые частые цвета по краям кадра; пиксель считается фоном, если он близок к ним
    # (или плавно продолжает соседний фоновый пиксель — для градиентов), и связан с краем
    border = [px[x, 0] for x in range(W)] + [px[x, H - 1] for x in range(W)] + [px[0, y] for y in range(H)] + [px[W - 1, y] for y in range(H)]
    buckets: dict = {}
    for c in border:
        key = (c[0] // 24, c[1] // 24, c[2] // 24)
        buckets.setdefault(key, []).append(c)
    palette = []
    for grp in sorted(buckets.values(), key=len, reverse=True)[:4]:
        if len(grp) >= len(border) * .06:
            palette.append(tuple(sum(c[j] for c in grp) // len(grp) for j in range(3)))
    if not palette:
        raise ApiError(400, "Не получилось отделить фон — попробуйте фото на однотонном фоне")

    def bgdist(n):
        return min((n[0] - b[0]) ** 2 + (n[1] - b[1]) ** 2 + (n[2] - b[2]) ** 2 for b in palette)
    tol2, soft2, step2 = tolerance * tolerance, (tolerance * 2.4) ** 2, 13 * 13
    while q:
        x, y = q.popleft()
        i = y * W + x
        if seen[i]:
            continue
        c = px[x, y]
        if bgdist(c) > soft2:
            continue
        seen[i] = 1
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < W and 0 <= ny < H and not seen[ny * W + nx]:
                n = px[nx, ny]
                d = bgdist(n)
                if d <= tol2 or (d <= soft2 and (n[0] - c[0]) ** 2 + (n[1] - c[1]) ** 2 + (n[2] - c[2]) ** 2 <= step2):
                    q.append((nx, ny))
    mask = Image.frombytes("L", (W, H), bytes(0 if v else 255 for v in seen))
    if mask.getbbox() is None or sum(mask.histogram()[255:]) < W * H * .03:
        raise ApiError(400, "Не получилось отделить фон — попробуйте фото на однотонном фоне")
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    mask = mask.resize(im.size, Image.BICUBIC).filter(ImageFilter.GaussianBlur(1.6))
    out = im.copy()
    out.putalpha(ImageChops.multiply(mask, a0))
    bbox = out.getchannel("A").point(lambda v: 255 if v > 20 else 0).getbbox()
    if bbox:
        out = out.crop(bbox)
    out.thumbnail((SIDE, SIDE), Image.LANCZOS)
    return encode([out])[0]


def enhance(data: bytes) -> bytes:
    """Чётче и крупнее: увеличение до 512 px, подавление шума, повышение резкости и чуть больше цвета."""
    frames, durs = load_frames(data)
    out = []
    for fr in frames:
        a = fr.getchannel("A")
        k = SIDE / max(fr.size)
        if k > 1:
            fr = fr.resize((int(fr.width * k), int(fr.height * k)), Image.LANCZOS)
            a = a.resize(fr.size, Image.LANCZOS)
        rgb = fr.convert("RGB")
        if k > 1.5:
            rgb = rgb.filter(ImageFilter.MedianFilter(3))
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=2))
        rgb = ImageEnhance.Color(rgb).enhance(1.12)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.06)
        img = rgb.convert("RGBA")
        img.putalpha(a)
        img.thumbnail((SIDE, SIDE), Image.LANCZOS)
        out.append(img)
    return encode(out, durs)[0]


DEFAULT_CAPTIONS = ["Привет!", "Ахаха", "Ок", "Люблю", "Что?!", "Вау!", "Спасибо", "Грусть…"]
PHOTO_PACK = [  # из одного фото — набор с разными характерами
    {"outline": "white"},
    {"outline": "white", "text": "{0}"},
    {"outline": "white", "anim": "bounce", "text": "{1}"},
    {"outline": "white", "elements": ["hearts"], "text": "{3}"},
    {"outline": "white", "anim": "shake", "text": "{4}"},
    {"outline": "white", "elements": ["sparkles"], "text": "{5}"},
    {"outline": "white", "elements": ["crown"], "bg": "burst", "bg_color": "#ffcc33"},
    {"outline": "white", "anim": "pulse", "text": "{6}"},
    {"outline": "white", "elements": ["tears"], "sat": .6, "text": "{7}"},
    {"outline": "white", "anim": "rainbow", "text": "{2}"},
]


def photo_pack(data: bytes, captions: list[str], cut: bool = True) -> list[tuple[bytes, bool, str]]:
    src = remove_background(data) if cut else data
    caps = [c or d for c, d in zip((captions + [""] * 8)[:8], DEFAULT_CAPTIONS)]
    emoji = ["🙂", "👋", "😂", "❤️", "😮", "✨", "👑", "🙏", "😢", "🌈"]
    out = []
    for i, tpl in enumerate(PHOTO_PACK):
        p = {k: (v.format(*caps) if isinstance(v, str) else v) for k, v in tpl.items()}
        img, animated = remix(src, p)
        out.append((img, animated, emoji[i]))
    return out
