"""Ребрендинг QEVI → Yarko в видимых людям текстах (однократный инструмент, оставлен для истории).

Не трогает служебные идентификаторы: палитру и пресет "qevi", классы и ключи localStorage qevi:*,
имена констант QEVI_*, историю ребрендинга (scripts/rebrand_qevi.py и его тест).
Запуск: python -m scripts.rebrand_yarko [--dry]"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLOBS = ["static/**/*.js", "static/*.html", "static/*.webmanifest", "static/sw.js", "app/**/*.py", "tests/*.py",
         "docs/**/*.md", "README.md"]
SKIP = {"scripts/rebrand_qevi.py", "scripts/rebrand_yarko.py", "tests/test_rebrand.py", "static/js/brand.js"}

PHRASES = {"#qevi": "#yarko", "@qevi": "@yarko"}
BRAND = re.compile(r"(?<![A-Za-z_])QEVI(?![A-Za-z_])")


def convert(text: str) -> tuple[str, int]:
    n = 0
    for a, b in PHRASES.items():
        n += text.count(a)
        text = text.replace(a, b)
    text, k = BRAND.subn("Yarko", text)
    return text, n + k


def main():
    dry = "--dry" in sys.argv
    total = 0
    seen = set()
    for g in GLOBS:
        for p in sorted(ROOT.glob(g)):
            rel = str(p.relative_to(ROOT))
            if rel in SKIP or rel in seen or "__pycache__" in rel or "/vendor/" in rel:
                continue
            seen.add(rel)
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
