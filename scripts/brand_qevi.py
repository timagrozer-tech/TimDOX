"""Генератор фирменной графики QEVI: символ Q, логотипы (тёмный/светлый/моно), иконки приложения.

Запуск: python -m scripts.brand_qevi  → static/img/brand/*.svg
Растровые иконки (PNG) собираются из этих SVG отдельно (см. scripts/brand_png.py)."""
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "static" / "img" / "brand"
NAVY, BLUE, VIOLET, CYAN, WHITE = "#0A0F2C", "#2563FF", "#B277FF", "#88FFF2", "#FFFFFF"

CX, CY, R = 100, 98, 54            # кольцо Q — «стеклянная планета»
RX, RY, ROT = 88, 24, -24           # орбита — наклонный эллипс через кольцо


def _pt(t):
    a = math.radians(t)
    x, y = RX * math.cos(a), RY * math.sin(a)
    c, s = math.cos(math.radians(ROT)), math.sin(math.radians(ROT))
    return CX + x * c - y * s, CY + x * s + y * c


def _arc(t0, t1, n=40):
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in (_pt(t0 + (t1 - t0) * i / n) for i in range(n + 1)))


TX, TY = CX + R * math.cos(math.radians(45)), CY + R * math.sin(math.radians(45))
TAIL_END = (TX + 48, TY + 20)
TAIL = f"M{TX:.1f} {TY:.1f} C {TX + 12:.1f} {TY + 13:.1f}, {TX + 28:.1f} {TY + 22:.1f}, {TAIL_END[0]:.1f} {TAIL_END[1]:.1f}"
N1, N2 = _pt(205), _pt(318)


def mark(prefix="qv", mono=None, glow=True):
    """Символ Q. mono — один цвет (например, currentColor) без градиентов и свечения."""
    if mono:
        return f'''<path d="{_arc(180, 360)}" fill="none" stroke="{mono}" stroke-width="3" stroke-linecap="round" opacity=".5"/>
  <circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="{mono}" stroke-width="20"/>
  <path d="{TAIL}" fill="none" stroke="{mono}" stroke-width="18" stroke-linecap="round"/>
  <path d="{_arc(0, 180)}" fill="none" stroke="{mono}" stroke-width="3" stroke-linecap="round"/>
  <circle cx="{CX}" cy="{CY}" r="8" fill="{mono}"/>
  <circle cx="{N1[0]:.1f}" cy="{N1[1]:.1f}" r="5.5" fill="{mono}"/><circle cx="{N2[0]:.1f}" cy="{N2[1]:.1f}" r="5" fill="{mono}"/>'''
    p = prefix
    return f'''<defs>
    <linearGradient id="{p}-ring" x1="40" y1="36" x2="168" y2="172" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{CYAN}"/><stop offset=".42" stop-color="{BLUE}"/><stop offset="1" stop-color="{VIOLET}"/>
    </linearGradient>
    <linearGradient id="{p}-orbit" x1="12" y1="120" x2="188" y2="76" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{VIOLET}"/><stop offset="1" stop-color="{CYAN}"/>
    </linearGradient>
    <radialGradient id="{p}-core" cx="{CX}" cy="{CY}" r="30" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WHITE}"/><stop offset=".3" stop-color="{CYAN}" stop-opacity=".85"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="{p}-shine" x1="56" y1="46" x2="104" y2="76" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WHITE}" stop-opacity=".8"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="{_arc(180, 360)}" fill="none" stroke="url(#{p}-orbit)" stroke-width="2.6" stroke-linecap="round" opacity=".45"/>
  <circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="url(#{p}-ring)" stroke-width="20"/>
  <path d="M{CX - 44} {CY - 26} A 51 51 0 0 1 {CX + 6} {CY - 50}" fill="none" stroke="url(#{p}-shine)" stroke-width="5" stroke-linecap="round"/>
  <path d="{TAIL}" fill="none" stroke="url(#{p}-ring)" stroke-width="18" stroke-linecap="round"/>
  <path d="{_arc(0, 180)}" fill="none" stroke="url(#{p}-orbit)" stroke-width="2.6" stroke-linecap="round" opacity=".95"/>
  {f'<circle cx="{CX}" cy="{CY}" r="30" fill="url(#{p}-core)"/>' if glow else ''}
  <circle cx="{CX}" cy="{CY}" r="6.5" fill="{WHITE}"/>
  <circle cx="{N1[0]:.1f}" cy="{N1[1]:.1f}" r="5" fill="{VIOLET}"/>
  <circle cx="{N2[0]:.1f}" cy="{N2[1]:.1f}" r="4.5" fill="{CYAN}"/>
  <circle cx="{TAIL_END[0]:.1f}" cy="{TAIL_END[1]:.1f}" r="5.5" fill="{WHITE}"/>'''


def wordmark(color, x0=0):
    """Надпись QEVI — геометрический гротеск ровной толщины со скруглёнными концами, высота 64."""
    s = f'stroke="{color}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"'
    return f'''<g transform="translate({x0} 0)" {s}>
    <circle cx="36" cy="50" r="30"/><path d="M54 68 L70 82"/>
    <path d="M134 20 H96 V80 H134 M96 50 H128"/>
    <path d="M156 20 L182 80 L208 20"/>
    <path d="M232 20 V80"/>
  </g>'''


def svg(view, body, label="QEVI"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="{label}">\n  {body}\n</svg>\n'


def logo(text_color, mono=None):
    # символ 0..200 масштабом 0.5 → 100×100, затем надпись
    m = mark("ql", mono=mono)
    return svg("0 0 368 100", f'<g transform="translate(0 1) scale(.5)">{m}</g>\n  {wordmark(mono or text_color, 122)}')


def app_icon(maskable=False):
    """Иконка приложения: глубокий тёмно-синий фон со свечением и символ. maskable — символ в безопасной зоне 80%."""
    k = .56 if maskable else .74
    off = 256 - 100 * k * 2.56
    bg = f'''<defs>
    <radialGradient id="ai-bg" cx="190" cy="150" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1B2A6B"/><stop offset=".55" stop-color="{NAVY}"/><stop offset="1" stop-color="#060918"/>
    </radialGradient>
    <radialGradient id="ai-glow" cx="256" cy="256" r="230" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{BLUE}" stop-opacity=".35"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#ai-bg)"/>
  <rect width="512" height="512" fill="url(#ai-glow)"/>'''
    return svg("0 0 512 512", f'{bg}\n  <g transform="translate({off:.1f} {off - 6:.1f}) scale({k * 2.56:.3f})">{mark("ai")}</g>')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        "qevi-mark.svg": svg("0 0 200 200", mark()),
        "qevi-mark-mono.svg": svg("0 0 200 200", mark(mono="currentColor")),
        "qevi-mark-white.svg": svg("0 0 200 200", mark(mono="#FFFFFF")),
        "qevi-logo-dark.svg": logo(WHITE),
        "qevi-logo-light.svg": logo(NAVY),
        "qevi-logo-mono.svg": logo(None, mono="currentColor"),
        "qevi-icon.svg": app_icon(),
        "qevi-icon-maskable.svg": app_icon(maskable=True),
    }
    for name, body in files.items():
        (OUT / name).write_text(body, encoding="utf-8")
    # тот же рисунок для интерфейса: id градиентов уникальны для каждого экземпляра (__ID__)
    flat = lambda s: json.dumps(" ".join(s.split()), ensure_ascii=False)  # noqa: E731
    js = ("// Сгенерировано scripts/brand_qevi.py — не редактировать вручную.\n"
          f"export const QEVI_MARK = {flat(mark('__ID__'))};\n"
          f"export const QEVI_MARK_MONO = {flat(mark(mono='currentColor'))};\n"
          f"export const QEVI_WORDMARK = {flat(wordmark('currentColor'))};\n")
    (OUT.parent.parent / "js" / "brand.js").write_text(js, encoding="utf-8")
    print("\n".join(files))


if __name__ == "__main__":
    main()
