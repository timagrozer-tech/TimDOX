"""Ребрендинг KRUG/Круг → QEVI в пользовательских текстах (однократный инструмент, оставлен для истории).

Меняет только видимые людям названия. Не трогает:
• функцию «Круги» (списки друзей) и её тексты («Круг «Близкие»», «Круг не найден»);
• фигуру «круг» в редакторе стикеров;
• имена в коде и окружении (KRUG_KINDS, KRUG_SECRET_KEY, KRUG_UPDATES_LOOP, const KRUG…);
• служебные идентификаторы: схема БД krug, cookie krug_session, ключи krug-* (их переносит слой совместимости).
Запуск: python -m scripts.rebrand_qevi [--dry]"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLOBS = ["static/**/*.js", "static/*.html", "static/*.webmanifest", "app/**/*.py", "README.md"]
SKIP = {"scripts/rebrand_qevi.py", "static/js/brand.js"}

# строки с этими фрагментами — не бренд, а функция «Круги» или геометрическая фигура
KEEP_LINE = ['Круг «', '"Круг не найден"', 'Круг с таким названием', '["circle", "Круг"]', 'c.name : "Круг"']

# фразы, которые после замены звучали бы неестественно
PHRASES = {
    "Соберите свой Круг": "Пригласите друзей в QEVI",
    "Каким будет ваш Круг?": "Каким будет ваш QEVI?",
    "Совет Круга": "Совет QEVI",
    "социальной сети Круг (KRUG)": "платформы QEVI",
    "мост между Telegram и Кругом": "мост между Telegram и QEVI",
    "KRUG Coin": "QEVI Coin",
    "Круг — социальная сеть": "QEVI — социальная сеть нового поколения",
}

RU_QUOTED = re.compile(r"«Круг(?:а|е|у|ом)?»")
RU = re.compile(r"(?<![А-Яа-яЁё])Круг(?:а|е|у|ом)?(?![А-Яа-яЁё-])")
LAT = re.compile(r"(?<![A-Za-z_])(?<!const )KRUG(?![A-Za-z_.])")


def convert(text: str) -> tuple[str, int]:
    n = 0
    for a, b in PHRASES.items():
        n += text.count(a)
        text = text.replace(a, b)
    out = []
    for line in text.split("\n"):
        if any(k in line for k in KEEP_LINE):
            out.append(line)
            continue
        line, a = RU_QUOTED.subn("QEVI", line)
        line, b = RU.subn("QEVI", line)
        line, c = LAT.subn("QEVI", line)
        n += a + b + c
        out.append(line)
    return "\n".join(out), n


def main():
    dry = "--dry" in sys.argv
    total = 0
    for g in GLOBS:
        for p in sorted(ROOT.glob(g)):
            rel = str(p.relative_to(ROOT))
            if rel in SKIP or "__pycache__" in rel or "/vendor/" in rel:
                continue
            src = p.read_text(encoding="utf-8")
            new, n = convert(src)
            if n:
                total += n
                print(f"{n:4d}  {rel}")
                if not dry:
                    p.write_text(new, encoding="utf-8")
    print(f"итого замен: {total}")


if __name__ == "__main__":
    main()
