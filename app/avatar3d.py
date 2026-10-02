"""3D-аватар: параметры персонажа (как Memoji). Сервер хранит только проверенный набор значений —
сам 3D рисует браузер (three.js), а для ленты и чатов загружается обычная картинка-снимок."""
import json

# категория: допустимые значения (строки) или размер палитры (int)
OPTIONS = {
    "skin": 8,
    "hair": ["none", "buzz", "short", "long", "bob", "curly", "bun", "mohawk", "spiky"],
    "hairColor": 10,
    "eyes": ["round", "happy", "sleepy", "wink"],
    "eyeColor": 6,
    "brows": ["soft", "bold", "none"],
    "nose": ["small", "round"],
    "mouth": ["smile", "grin", "open", "calm", "tongue"],
    "facial": ["none", "stubble", "mustache", "beard"],
    "acc": ["none", "glasses", "sunglasses", "headphones", "cap", "beanie", "crown", "halo"],
    "accColor": 10,
    "outfit": ["hoodie", "tee", "jacket", "sweater"],
    "outfitColor": 10,
    "bg": 8,
    "cheeks": "bool",
    "freckles": "bool",
}
DEFAULT = {"skin": 2, "hair": "short", "hairColor": 1, "eyes": "round", "eyeColor": 0, "brows": "soft", "nose": "small",
           "mouth": "smile", "facial": "none", "acc": "none", "accColor": 0, "outfit": "hoodie", "outfitColor": 0, "bg": 0,
           "cheeks": True, "freckles": False}


class Invalid(ValueError):
    pass


def validate(data) -> dict:
    if not isinstance(data, dict):
        raise Invalid("Нет параметров аватара")
    out = {}
    for key, rule in OPTIONS.items():
        v = data.get(key, DEFAULT[key])
        if rule == "bool":
            out[key] = bool(v)
        elif isinstance(rule, int):
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise Invalid(f"Неверное значение: {key}")
            if not 0 <= v < rule:
                raise Invalid(f"Неверное значение: {key}")
            out[key] = v
        else:
            if v not in rule:
                raise Invalid(f"Неверное значение: {key}")
            out[key] = v
    return out


def load(raw) -> dict | None:
    if not raw:
        return None
    try:
        return validate(json.loads(raw))
    except (ValueError, TypeError):
        return None
