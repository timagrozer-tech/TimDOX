"""Картинка для превью ссылок (Open Graph / Twitter, 1200×630) из фирменного символа QEVI.

Запуск: python -m scripts.brand_og  (нужен Playwright с Chromium) → static/img/og.png"""
import asyncio
import random
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "static" / "img" / "brand"


def html() -> str:
    mark = (BRAND / "yarko-mark.svg").read_text().replace("<svg ", '<svg width="420" height="420" ', 1)
    word = (BRAND / "yarko-logo-dark.svg").read_text()
    # только надпись из полного логотипа
    word = word.replace('viewBox="0 0 456 100"', 'viewBox="112 12 338 76" width="470" height="106"', 1)
    rnd = random.Random(7)
    stars = "".join(f'<i style="left:{rnd.random() * 100:.1f}%;top:{rnd.random() * 100:.1f}%;opacity:{.2 + rnd.random() * .6:.2f};'
                    f'transform:scale({.5 + rnd.random():.2f})"></i>' for _ in range(70))
    return f"""<html><head><style>
body{{margin:0;width:1200px;height:630px;overflow:hidden;font-family:'DejaVu Sans',sans-serif;color:#fff;
background:radial-gradient(60% 80% at 22% 45%,#1b2a6b 0%,#0A0F2C 55%,#060918 100%)}}
.s i{{position:absolute;width:3px;height:3px;border-radius:50%;background:#88FFF2}}
.mark{{position:absolute;left:70px;top:105px}}
.text{{position:absolute;left:560px;top:205px}}
.text p{{margin:26px 0 0 4px;font-size:34px;line-height:1.3;color:#c9d4ff;letter-spacing:.01em}}
.glass{{position:absolute;right:-120px;bottom:-160px;width:520px;height:520px;border-radius:50%;
background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}}
</style></head><body><div class="s">{stars}</div><div class="glass"></div>
<div class="mark">{mark}</div><div class="text">{word}<p>Социальная сеть,<br>где каждый день — яркий</p></div></body></html>"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 1200, "height": 630})).new_page()
        await pg.set_content(html())
        await pg.screenshot(path=str(ROOT / "static" / "img" / "og.png"))
        await b.close()


if __name__ == "__main__":
    asyncio.run(main())
