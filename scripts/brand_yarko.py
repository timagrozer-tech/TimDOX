"""Генератор фирменной графики Yarko: символ «вспышка в орбите», логотипы (тёмный/светлый/моно), иконки приложения.

Символ: четырёхлучевая звезда-вспышка с белым ядром, наклонная орбита (задняя половина под звездой, передняя — над),
спутник на орбите и маленькая искра. Анимированная версия (SMIL): звезда «дышит», орбита переливается, спутник
летит по орбите, искра мерцает. Работает и как файл, и встроенным в страницу.

Запуск: python -m scripts.brand_yarko  → static/img/brand/*.svg и static/js/brand.js"""
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "static" / "img" / "brand"
NAVY, BLUE, VIOLET, CYAN, WHITE = "#0A0F2C", "#2563FF", "#B277FF", "#88FFF2", "#FFFFFF"

CX, CY = 100, 100
RX, RY, ROT = 88, 28, -22          # орбита — наклонный эллипс
STAR = "M0 -68 Q8 -8 60 0 Q8 8 0 68 Q-8 8 -60 0 Q-8 -8 0 -68Z"   # вспышка вокруг (0,0)
SPARK = "M0 -15 Q2 -2 13 0 Q2 2 0 15 Q-2 2 -13 0 Q-2 -2 0 -15Z"
SPARK_AT = (156, 44)


def _pt(t):
    a = math.radians(t)
    x, y = RX * math.cos(a), RY * math.sin(a)
    c, s = math.cos(math.radians(ROT)), math.sin(math.radians(ROT))
    return CX + x * c - y * s, CY + x * s + y * c


def _arc(t0, t1, n=48):
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in (_pt(t0 + (t1 - t0) * i / n) for i in range(n + 1)))


def _ellipse_path():
    return _arc(0, 360, 96) + "Z"


SAT = _pt(60)   # положение спутника в статичной версии


def mark(prefix="yk", mono=None, animated=False):
    """Символ. mono — один цвет без градиентов и анимации; animated — живая версия (SMIL)."""
    if mono:
        return f'''<path d="{_arc(180, 360)}" fill="none" stroke="{mono}" stroke-width="5" stroke-linecap="round" opacity=".45"/>
  <path transform="translate({CX} {CY})" d="{STAR}" fill="{mono}"/>
  <path d="{_arc(0, 180)}" fill="none" stroke="{mono}" stroke-width="5" stroke-linecap="round"/>
  <path transform="translate({SPARK_AT[0]} {SPARK_AT[1]})" d="{SPARK}" fill="{mono}"/>
  <circle cx="{SAT[0]:.1f}" cy="{SAT[1]:.1f}" r="7" fill="{mono}"/>'''
    p = prefix
    ease = 'calcMode="spline" keyTimes="0;.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"'
    breathe = (f'<animateTransform attributeName="transform" type="scale" values="1;1.08;1" dur="3.4s" repeatCount="indefinite" {ease}/>'
               if animated else "")
    halo = (f'<animate attributeName="opacity" values=".55;1;.55" dur="3.4s" repeatCount="indefinite" {ease}/>' if animated else "")
    twinkle = (f'<animate attributeName="opacity" values=".25;1;.25" dur="2.6s" repeatCount="indefinite" {ease}/>'
               f'<animateTransform attributeName="transform" type="scale" values=".6;1.15;.6" dur="2.6s" repeatCount="indefinite" {ease}/>'
               if animated else "")
    shimmer = (f'<animate attributeName="x1" values="0;120;0" dur="6s" repeatCount="indefinite"/>'
               f'<animate attributeName="x2" values="200;320;200" dur="6s" repeatCount="indefinite"/>' if animated else "")
    if animated:
        sat = (f'<circle r="6.5" fill="{WHITE}" filter="url(#{p}-blur)"><animateMotion dur="9s" repeatCount="indefinite" '
               f'path="{_ellipse_path()}"/></circle>'
               f'<circle r="4" fill="{WHITE}"><animateMotion dur="9s" repeatCount="indefinite" path="{_ellipse_path()}"/></circle>')
    else:
        sat = f'<circle cx="{SAT[0]:.1f}" cy="{SAT[1]:.1f}" r="6" fill="{WHITE}"/>'
    return f'''<defs>
    <linearGradient id="{p}-star" x1="-60" y1="-68" x2="60" y2="68" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{CYAN}"/><stop offset=".45" stop-color="{BLUE}"/><stop offset="1" stop-color="{VIOLET}"/>
    </linearGradient>
    <linearGradient id="{p}-orbit" x1="0" y1="130" x2="200" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{VIOLET}"/><stop offset=".5" stop-color="{CYAN}"/><stop offset="1" stop-color="{VIOLET}"/>{shimmer}
    </linearGradient>
    <radialGradient id="{p}-halo" cx="{CX}" cy="{CY}" r="78" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{BLUE}" stop-opacity=".55"/><stop offset=".55" stop-color="{VIOLET}" stop-opacity=".18"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="{p}-core" cx="0" cy="0" r="26" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WHITE}"/><stop offset=".35" stop-color="{WHITE}" stop-opacity=".9"/><stop offset="1" stop-color="{CYAN}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="{p}-shine" x1="0" y1="-68" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WHITE}" stop-opacity=".75"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/>
    </linearGradient>
    <filter id="{p}-blur" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <circle cx="{CX}" cy="{CY}" r="78" fill="url(#{p}-halo)">{halo}</circle>
  <path d="{_arc(180, 360)}" fill="none" stroke="url(#{p}-orbit)" stroke-width="3.2" stroke-linecap="round" opacity=".5"/>
  <g transform="translate({CX} {CY})"><g>{breathe}
    <path d="{STAR}" fill="url(#{p}-star)"/>
    <path d="M0 -68 Q8 -8 60 0 L0 0Z" fill="url(#{p}-shine)" opacity=".55"/>
    <circle r="26" fill="url(#{p}-core)"/>
    <circle r="7" fill="{WHITE}"/>
  </g></g>
  <path d="{_arc(0, 180)}" fill="none" stroke="url(#{p}-orbit)" stroke-width="3.2" stroke-linecap="round"/>
  <g transform="translate({SPARK_AT[0]} {SPARK_AT[1]})"><g>{twinkle}<path d="{SPARK}" fill="{CYAN}"/></g></g>
  {sat}'''


# Надпись YARKO — геометрический гротеск ровной толщины со скруглёнными концами, высота букв 60 (y 20..80)
WORD_BOX = "-8 12 338 76"


def wordmark(color, x0=0):
    s = f'stroke="{color}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"'
    return f'''<g transform="translate({x0} 0)" {s}>
    <path d="M0 20 L25 50 L50 20 M25 50 V80"/>
    <path d="M70 80 L95 20 L120 80 M80 60 H110"/>
    <path d="M142 80 V20 H162 C186 20 186 56 162 56 H142 M164 56 L184 80"/>
    <path d="M206 20 V80 M246 20 L208 56 M222 44 L248 80"/>
    <circle cx="292" cy="50" r="30"/>
  </g>'''


def svg(view, body, label="Yarko"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="{label}">\n  {body}\n</svg>\n'


def logo(text_color, mono=None, animated=False):
    # символ 0..200 масштабом 0.5 → 100×100, затем надпись
    m = mark("yl", mono=mono, animated=animated)
    return svg("0 0 456 100", f'<g transform="translate(0 0) scale(.5)">{m}</g>\n  {wordmark(mono or text_color, 120)}')


def app_icon(maskable=False):
    """Иконка приложения: глубокий тёмно-синий фон со свечением и символ. maskable — символ в безопасной зоне 80%."""
    k = .62 if maskable else .8
    size = 200 * k * 2.56
    off = (512 - size) / 2
    bg = f'''<defs>
    <radialGradient id="ai-bg" cx="200" cy="150" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1B2A6B"/><stop offset=".55" stop-color="{NAVY}"/><stop offset="1" stop-color="#060918"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#ai-bg)"/>'''
    return svg("0 0 512 512", f'{bg}\n  <g transform="translate({off:.1f} {off:.1f}) scale({k * 2.56:.3f})">{mark("ai")}</g>')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("qevi-*.svg"):
        old.unlink()
    files = {
        "yarko-mark.svg": svg("0 0 200 200", mark()),
        "yarko-mark-animated.svg": svg("0 0 200 200", mark(animated=True)),
        "yarko-mark-mono.svg": svg("0 0 200 200", mark(mono="currentColor")),
        "yarko-mark-white.svg": svg("0 0 200 200", mark(mono="#FFFFFF")),
        "yarko-logo-dark.svg": logo(WHITE),
        "yarko-logo-dark-animated.svg": logo(WHITE, animated=True),
        "yarko-logo-light.svg": logo(NAVY),
        "yarko-logo-mono.svg": logo(None, mono="currentColor"),
        "yarko-icon.svg": app_icon(),
        "yarko-icon-maskable.svg": app_icon(maskable=True),
    }
    for name, body in files.items():
        (OUT / name).write_text(body, encoding="utf-8")
    # тот же рисунок для интерфейса: id градиентов уникальны для каждого экземпляра (__ID__)
    flat = lambda s: json.dumps(" ".join(s.split()), ensure_ascii=False)  # noqa: E731
    js = ("// Сгенерировано scripts/brand_yarko.py — не редактировать вручную.\n"
          f"export const YARKO_MARK = {flat(mark('__ID__', animated=True))};\n"
          f"export const YARKO_MARK_STATIC = {flat(mark('__ID__'))};\n"
          f"export const YARKO_MARK_MONO = {flat(mark(mono='currentColor'))};\n"
          f"export const YARKO_WORDMARK = {flat(wordmark('currentColor'))};\n"
          f"export const YARKO_WORD_BOX = {json.dumps(WORD_BOX)};\n")
    (OUT.parent.parent / "js" / "brand.js").write_text(js, encoding="utf-8")
    print("\n".join(files))


if __name__ == "__main__":
    main()
