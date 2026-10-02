"""3D-аватар: параметры персонажа (как Memoji). Сервер хранит только проверенный набор значений —
сам 3D рисует браузер (three.js), а для ленты и чатов загружается обычная картинка-снимок.

Списки совпадают с OPTIONS в static/js/components/avatar3d.js (это проверяет тест)."""
import json
import re

OPTIONS = {
    "headShape": ["round", "oval", "wide", "long", "chubby"],
    "headSize": ["s", "m", "l"],
    "build": ["slim", "normal", "broad"],
    "ears": ["normal", "small", "big", "elf", "none"],
    "nose": ["small", "round", "pointy", "wide", "long", "pig", "clown"],
    "hair": ["none", "buzz", "short", "side", "quiff", "undercut", "long", "wavy", "bob", "bangs", "emo", "curly", "afro", "bun",
             "topknot", "spacebuns", "ponytail", "pigtails", "braids", "dreads", "mullet", "mohawk", "spiky"],
    "eyes": ["round", "almond", "big", "anime", "small", "happy", "sleepy", "wink"],
    "lashes": ["none", "short", "long"],
    "brows": ["soft", "bold", "thin", "arched", "angry", "unibrow", "none"],
    "mouth": ["smile", "smirk", "grin", "open", "calm", "tongue", "fangs", "kiss", "buck"],
    "facial": ["none", "stubble", "mustache", "chevron", "handlebar", "goatee", "sideburns", "beard", "longbeard"],
    "paint": ["none", "whiskers", "warpaint", "star", "heart", "tear", "glitter"],
    "mole": ["none", "cheek", "lip", "eye"],
    "scar": ["none", "eye", "cheek"],
    "piercing": ["none", "nose", "septum", "brow", "lip"],
    "hat": ["none", "cap", "capback", "beanie", "beret", "bandana", "headband", "cowboy", "tophat", "wizard", "party", "chef",
            "crown", "tiara", "halo", "flowers", "bow", "catears", "bunnyears", "horns", "viking", "antenna", "astronaut"],
    "glasses": ["none", "glasses", "round", "nerd", "sunglasses", "shades", "aviator", "heart", "star", "monocle", "ski", "vr", "eyepatch"],
    "earwear": ["none", "studs", "hoops", "drops", "earbuds", "headphones"],
    "neck": ["none", "chain", "pendant", "pearls", "choker", "scarf", "bowtie", "tie", "medal"],
    "outfit": ["hoodie", "tee", "shirt", "jacket", "biker", "sweater", "turtleneck", "coat", "suit", "kimono", "overalls",
               "jersey", "armor", "spacesuit", "hero"],
    "pattern": ["none", "stripes", "dots", "checks", "camo", "stars", "hearts", "zigzag"],
    "print": ["none", "star", "heart", "bolt", "smile", "fire", "skull", "alien", "rocket", "crown", "paw", "music", "krug", "number"],
    "pet": ["none", "cat", "ghost", "star", "planet", "heart", "slime", "robot", "bird"],
    "fx": ["none", "sparkles", "hearts", "stars", "bubbles", "snow", "notes", "petals", "fire"],
    "idle": ["calm", "bouncy", "dance", "float", "sway", "vibe"],
    "bgStyle": ["gradient", "solid", "stars", "space", "dots", "stripes", "rings", "sunburst", "hearts", "grid", "confetti"],
    "emotion": ["neutral", "happy", "smirk", "cool", "surprised", "love", "laugh", "wink", "angry", "sad", "sleepy"],
}
PALETTE_SIZE = {"skin": 12, "hairColor": 14, "eyeColor": 10, "lipColor": 8, "accColor": 14, "outfitColor": 14, "bg": 14}
# цветовой параметр → палитра; значение — номер в палитре или свой цвет "#rrggbb"
COLORS = {
    "skin": "skin", "hairColor": "hairColor", "hairColor2": "hairColor", "eyeColor": "eyeColor", "eyeColor2": "eyeColor",
    "lipColor": "lipColor", "shadowColor": "accColor", "hatColor": "accColor", "glassesColor": "accColor",
    "jewelColor": "accColor", "paintColor": "accColor", "outfitColor": "outfitColor", "outfitColor2": "outfitColor",
    "petColor": "accColor", "bg": "bg",
}
BOOLS = ["cheeks", "freckles", "hairStreak", "heterochromia", "eyeGlow", "lipstick", "eyeshadow"]

DEFAULT = {
    "headShape": "round", "headSize": "m", "build": "normal", "ears": "normal", "skin": 2, "nose": "small",
    "hair": "short", "hairColor": 1, "hairStreak": False, "hairColor2": 8,
    "eyes": "round", "eyeColor": 0, "heterochromia": False, "eyeColor2": 1, "eyeGlow": False, "lashes": "none",
    "eyeshadow": False, "shadowColor": 1, "brows": "soft", "mouth": "smile", "lipstick": False, "lipColor": 0, "facial": "none",
    "cheeks": True, "freckles": False, "paint": "none", "paintColor": 2, "mole": "none", "scar": "none", "piercing": "none",
    "hat": "none", "hatColor": 1, "glasses": "none", "glassesColor": 0, "earwear": "none", "neck": "none", "jewelColor": 8,
    "outfit": "hoodie", "outfitColor": 0, "outfitColor2": 7, "pattern": "none", "print": "none",
    "pet": "none", "petColor": 3, "fx": "none", "idle": "calm", "bg": 0, "bgStyle": "gradient", "emotion": "neutral",
}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_LEGACY_HAT = {"cap", "beanie", "crown", "halo"}
_LEGACY_GLASSES = {"glasses", "sunglasses", "shades"}


class Invalid(ValueError):
    pass


def _migrate(data: dict) -> dict:
    """Старые аватары: один слот «acc» → отдельные слоты шляпы, очков и наушников."""
    if "acc" not in data:
        return data
    d = dict(data)
    acc, color = d.pop("acc"), d.pop("accColor", 0)
    if acc in _LEGACY_HAT:
        d.setdefault("hat", acc); d.setdefault("hatColor", color)
    elif acc in _LEGACY_GLASSES:
        d.setdefault("glasses", acc); d.setdefault("glassesColor", color)
    elif acc == "headphones":
        d.setdefault("earwear", "headphones"); d.setdefault("jewelColor", color)
    elif acc not in (None, "none"):
        raise Invalid("Неверное значение: acc")
    return d


def validate(data) -> dict:
    if not isinstance(data, dict):
        raise Invalid("Нет параметров аватара")
    data = _migrate(data)
    out = {}
    for key, allowed in OPTIONS.items():
        v = data.get(key, DEFAULT[key])
        if v not in allowed:
            raise Invalid(f"Неверное значение: {key}")
        out[key] = v
    for key, pal in COLORS.items():
        v = data.get(key, DEFAULT[key])
        if isinstance(v, str) and HEX.match(v):
            out[key] = v.lower()
            continue
        if isinstance(v, bool):
            raise Invalid(f"Неверное значение: {key}")
        try:
            v = int(v)
        except (TypeError, ValueError):
            raise Invalid(f"Неверное значение: {key}")
        if not 0 <= v < PALETTE_SIZE[pal]:
            raise Invalid(f"Неверное значение: {key}")
        out[key] = v
    for key in BOOLS:
        out[key] = bool(data.get(key, DEFAULT[key]))
    return out


def load(raw) -> dict | None:
    if not raw:
        return None
    try:
        return validate(json.loads(raw))
    except (ValueError, TypeError):
        return None
