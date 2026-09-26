// Оформление: палитры, готовые темы, фоны (включая своё фото), шрифты и форма углов.
// Всё применяется через CSS-переменные на <html>; результат кэшируется в localStorage,
// чтобы theme-init.js отрисовал нужный вид ещё до загрузки приложения (без «вспышки»).

export const PALETTES = {
  violet:   { name: "Фиолетовый", pl: "#5b3df5", pd: "#a48dff", al: "#d6246e", ad: "#ff5fa2", c: ["#6d4bff", "#ff5fa2", "#22d3ee", "#a78bfa"] },
  ocean:    { name: "Океан",      pl: "#1d4ed8", pd: "#7aa2ff", al: "#0e7490", ad: "#22d3ee", c: ["#2563eb", "#06b6d4", "#6366f1", "#38bdf8"] },
  mint:     { name: "Мята",       pl: "#0f766e", pd: "#2dd4bf", al: "#0369a1", ad: "#38bdf8", c: ["#14b8a6", "#0ea5e9", "#22c55e", "#5eead4"] },
  forest:   { name: "Лес",        pl: "#15803d", pd: "#4ade80", al: "#4d7c0f", ad: "#a3e635", c: ["#16a34a", "#84cc16", "#0d9488", "#86efac"] },
  sakura:   { name: "Сакура",     pl: "#be185d", pd: "#f472b6", al: "#7c3aed", ad: "#c084fc", c: ["#ec4899", "#f9a8d4", "#a855f7", "#fda4af"] },
  ruby:     { name: "Рубин",      pl: "#b91c1c", pd: "#f87171", al: "#9d174d", ad: "#fb7185", c: ["#dc2626", "#e11d48", "#7c3aed", "#f43f5e"] },
  lavender: { name: "Лаванда",    pl: "#7c3aed", pd: "#c4b5fd", al: "#db2777", ad: "#f9a8d4", c: ["#8b5cf6", "#f0abfc", "#818cf8", "#c4b5fd"] },
  midnight: { name: "Полночь",    pl: "#3730a3", pd: "#818cf8", al: "#0891b2", ad: "#67e8f9", c: ["#4338ca", "#06b6d4", "#312e81", "#a5b4fc"] },
  graphite: { name: "Графит",     pl: "#334155", pd: "#cbd5e1", al: "#475569", ad: "#94a3b8", c: ["#64748b", "#94a3b8", "#475569", "#cbd5e1"] },
};

export const BACKGROUNDS = {
  orbit:    "Космос",
  aurora:   "Аврора",
  stars:    "Звёзды",
  gradient: "Градиент",
  pattern:  "Узор",
  plain:    "Однотонный",
  image:    "Своё фото",
};

const GF = "https://fonts.googleapis.com/css2?display=swap&family=";
export const FONTS = {
  manrope:    { name: "Manrope",     body: "Manrope",        display: "Unbounded",        q: "Manrope:wght@400;500;600;700;800&family=Unbounded:wght@500;600;700" },
  inter:      { name: "Inter",       body: "Inter",          display: "Inter",            q: "Inter:wght@400;500;600;700;800" },
  nunito:     { name: "Nunito",      body: "Nunito",         display: "Nunito",           q: "Nunito:wght@400;600;700;800" },
  rubik:      { name: "Rubik",       body: "Rubik",          display: "Rubik",            q: "Rubik:wght@400;500;600;700" },
  montserrat: { name: "Montserrat",  body: "Montserrat",     display: "Montserrat",       q: "Montserrat:wght@400;500;600;700;800" },
  comfortaa:  { name: "Comfortaa",   body: "Nunito",         display: "Comfortaa",        q: "Nunito:wght@400;600;700;800&family=Comfortaa:wght@500;600;700" },
  serif:      { name: "Классика",    body: "PT Serif",       display: "Playfair Display", q: "PT+Serif:wght@400;700&family=Playfair+Display:wght@500;600;700" },
  mono:       { name: "Техно",       body: "Inter",          display: "JetBrains Mono",   q: "Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700" },
  system:     { name: "Системный",   body: null,             display: null,               q: null },
};

export const SHAPES = { soft: "Мягкие", medium: "Средние", sharp: "Строгие" };

// Готовые темы: палитра + фон + шрифт + углы + светлая/тёмная
export const PRESETS = {
  orbit:    { name: "Орбита",   palette: "violet",   bg: "orbit",    font: "manrope",    shape: "soft",   mode: "dark" },
  dawn:     { name: "Рассвет",  palette: "lavender", bg: "aurora",   font: "manrope",    shape: "soft",   mode: "light" },
  ocean:    { name: "Океан",    palette: "ocean",    bg: "aurora",   font: "inter",      shape: "medium", mode: "light" },
  forest:   { name: "Лес",      palette: "forest",   bg: "gradient", font: "nunito",     shape: "soft",   mode: "light" },
  sakura:   { name: "Сакура",   palette: "sakura",   bg: "pattern",  font: "comfortaa",  shape: "soft",   mode: "light" },
  midnight: { name: "Полночь",  palette: "midnight", bg: "stars",    font: "rubik",      shape: "medium", mode: "dark" },
  neon:     { name: "Неон",     palette: "mint",     bg: "orbit",    font: "mono",       shape: "sharp",  mode: "dark" },
  graphite: { name: "Графит",   palette: "graphite", bg: "plain",    font: "inter",      shape: "sharp",  mode: "light" },
  classic:  { name: "Классика", palette: "ruby",     bg: "gradient", font: "serif",      shape: "medium", mode: "light" },
};

export const DEFAULT_LOOK = { preset: "orbit", palette: "violet", custom: null, bg: "orbit", dim: 35, blur: 0, font: "manrope", shape: "soft" };

// ---------------------------------------------------------------- цвет
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgb2hex = (r, g, b) => "#" + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
function lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
/** Подбирает вариант цвета с контрастом не ниже нужного к фону (затемняя или осветляя). */
function fit(rgb, against, target, toward) {
  let c = rgb;
  for (let i = 0; i < 20 && contrast(c, against) < target; i++) c = mix(c, toward, .12);
  return rgb2hex(...c);
}
/** Палитра из любого цвета, выбранного пользователем */
export function paletteFromColor(hex) {
  const rgb = hex2rgb(hex);
  const [h, s] = rgb2hsl(rgb);
  const sat = Math.max(s, 35);
  const acc = hsl2rgb(h + 40, sat, 50);
  const W = [255, 255, 255], D = [14, 14, 24], B = [0, 0, 0];
  return {
    name: "Свой цвет",
    pl: fit(rgb, W, 4.6, B), pd: fit(rgb, D, 6, W),
    al: fit(acc, W, 4.6, B), ad: fit(acc, D, 6, W),
    c: [hex, rgb2hex(...hsl2rgb(h + 40, sat, 60)), rgb2hex(...hsl2rgb(h - 50, sat, 58)), rgb2hex(...hsl2rgb(h + 15, sat * .7, 75))],
  };
}

export function paletteOf(look) {
  if (look.palette === "custom" && /^#[0-9a-f]{6}$/i.test(look.custom || "")) return paletteFromColor(look.custom);
  return PALETTES[look.palette] || PALETTES.violet;
}

export function fontHref(key, text) {
  const f = FONTS[key];
  if (!f?.q) return null;
  return GF + f.q + (text ? `&text=${encodeURIComponent(text)}` : "");
}

// ---------------------------------------------------------------- применение
let current = { ...DEFAULT_LOOK };
let bgImage = null;

export function currentLook() { return { ...current }; }
export function currentBgImage() { return bgImage; }

export function normalizeLook(raw) {
  const l = { ...DEFAULT_LOOK, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!PALETTES[l.palette] && l.palette !== "custom") l.palette = DEFAULT_LOOK.palette;
  if (!BACKGROUNDS[l.bg]) l.bg = DEFAULT_LOOK.bg;
  if (!FONTS[l.font]) l.font = DEFAULT_LOOK.font;
  if (!SHAPES[l.shape]) l.shape = DEFAULT_LOOK.shape;
  l.dim = Math.max(0, Math.min(85, +l.dim || 0));
  l.blur = Math.max(0, Math.min(24, +l.blur || 0));
  return l;
}

/** Применяет оформление к странице и сохраняет в кэш для мгновенной отрисовки при следующем входе. */
export function applyLook(look, image = bgImage) {
  current = normalizeLook(look);
  bgImage = typeof image === "string" && /^\/uploads\/[\w\/.-]+$/.test(image) ? image : null;
  const p = paletteOf(current);
  const bg = current.bg === "image" && !bgImage ? "orbit" : current.bg;
  const vars = {
    "--pl": p.pl, "--pd": p.pd, "--al": p.al, "--ad": p.ad,
    "--c1": p.c[0], "--c2": p.c[1], "--c3": p.c[2], "--c4": p.c[3],
    "--star-l": hex2rgb(p.pl).join(", "), "--star-d": hex2rgb(p.pd).join(", "),
    "--bg-dim": String(current.dim / 100), "--bg-blur": `${current.blur}px`,
    "--bg-image": bg === "image" ? `url("${bgImage}")` : "none",
  };
  const f = FONTS[current.font];
  if (f.body) {
    vars["--font"] = `"${f.body}", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    vars["--font-display"] = `"${f.display}", "${f.body}", system-ui, sans-serif`;
  } else {
    vars["--font"] = vars["--font-display"] = `system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  }
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.bg = bg;
  root.dataset.shape = current.shape;
  const href = fontHref(current.font);
  setFontLink(href);
  updateThemeColor();
  try {
    localStorage.setItem("krug-look", JSON.stringify({ vars, bg, shape: current.shape, font: href, look: current, image: bgImage }));
  } catch { /* приватный режим */ }
  return current;
}

function setFontLink(href) {
  let link = document.getElementById("look-font");
  if (!href) { link?.remove(); return; }
  if (!link) {
    link = document.createElement("link");
    link.id = "look-font";
    link.rel = "stylesheet";
    document.head.append(link);
  }
  if (link.getAttribute("href") !== href) link.href = href;
}

export function updateThemeColor() {
  const dark = document.documentElement.dataset.theme === "dark";
  const p = paletteOf(current);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#08080f" : p.pl);
}

/** Восстановление из кэша (на случай, если theme-init не сработал) */
export function restoreLook() {
  try {
    const c = JSON.parse(localStorage.getItem("krug-look") || "null");
    if (c?.look) { applyLook(c.look, c.image); return; }
  } catch { /* нет кэша */ }
  applyLook(DEFAULT_LOOK, null);
}
