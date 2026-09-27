// Оформление историй: фоны, шрифты, стили текста, стикеры. Общее для редактора и просмотра,
// чтобы история выглядела у зрителя ровно так же, как у автора.
import { h, icon } from "../dom.js";

export const BACKGROUNDS = {
  blue: "linear-gradient(135deg, #1f3fae, #4f7bff)",
  purple: "linear-gradient(135deg, #5b21b6, #c084fc)",
  pink: "linear-gradient(135deg, #be185d, #fb7185)",
  orange: "linear-gradient(135deg, #f5761a, #ffb347)",
  green: "linear-gradient(135deg, #0f7a4a, #3ddc84)",
  dark: "linear-gradient(135deg, #0b101b, #2a3550)",
  sunset: "linear-gradient(160deg, #ff5f6d 0%, #ffc371 100%)",
  ocean: "linear-gradient(160deg, #00c6ff 0%, #0072ff 100%)",
  mint: "linear-gradient(160deg, #a8e063 0%, #11998e 100%)",
  candy: "linear-gradient(160deg, #fbc2eb 0%, #a18cd1 100%)",
  night: "linear-gradient(180deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",
  fire: "linear-gradient(160deg, #f12711 0%, #f5af19 100%)",
  aurora: "linear-gradient(160deg, #43cea2 0%, #185a9d 55%, #6a3093 100%)",
  peach: "linear-gradient(160deg, #ffecd2 0%, #fcb69f 100%)",
  lime: "linear-gradient(160deg, #d4fc79 0%, #96e6a1 100%)",
  mono: "linear-gradient(160deg, #232526 0%, #414345 100%)",
  cream: "linear-gradient(160deg, #fdfbfb 0%, #ebedee 100%)",
  space: "radial-gradient(circle at 30% 20%, #3b2a7a 0%, #120b2e 45%, #05030f 100%)",
};

export const FONTS = {
  sans: { label: "Обычный", css: "'Manrope', system-ui, sans-serif", weight: 800 },
  display: { label: "Заголовок", css: "'Unbounded', 'Manrope', sans-serif", weight: 700 },
  hand: { label: "От руки", css: "'Caveat', cursive", weight: 700, scale: 1.3 },
  retro: { label: "Ретро", css: "'Lobster', cursive", weight: 400, scale: 1.1 },
  serif: { label: "Классика", css: "'PT Serif', Georgia, serif", weight: 700 },
  mono: { label: "Печатная", css: "'JetBrains Mono', ui-monospace, monospace", weight: 700, scale: .92 },
  round: { label: "Округлый", css: "'Comfortaa', 'Manrope', sans-serif", weight: 700 },
};

export const MODES = {
  plain: "Обычный",
  outline: "Контур",
  box: "Плашка",
  glass: "Стекло",
  neon: "Неон",
  shadow: "Тень",
};

export const COLORS = ["#ffffff", "#111111", "#ff3b5c", "#ff8a00", "#ffd60a", "#34c759", "#00c7be", "#0a84ff", "#7c5cff", "#ff5ac8", "#a2845e", "#8e8e93"];

let fontsLoaded = false;
/** Дополнительные шрифты грузим только когда открыты истории */
export function loadStoryFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  document.head.append(h("link", { rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Caveat:wght@700&family=Comfortaa:wght@700&family=JetBrains+Mono:wght@700&family=Lobster&family=PT+Serif:wght@700&display=swap" }));
}

export function defaultStyle(hasPhoto = false) {
  return { font: "sans", mode: "plain", color: "#ffffff", align: "center", size: 30, x: .5, y: hasPhoto ? .8 : .45, stickers: [] };
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
/** Контрастный цвет к выбранному: для обводки, плашки и тени */
export const contrast = (hex) => (luminance(hex) > .45 ? "#111111" : "#ffffff");

/** Применяет шрифт, размер, цвет и стиль к элементу текста (div или textarea) */
export function applyTextStyle(el, st) {
  const f = FONTS[st.font] || FONTS.sans;
  const c = st.color || "#ffffff", k = contrast(c);
  el.className = el.className.replace(/\bst-mode-\w+/g, "").trim() + ` st-mode-${st.mode || "plain"}`;
  Object.assign(el.style, {
    fontFamily: f.css, fontWeight: String(f.weight),
    fontSize: `${((st.size || 30) * (f.scale || 1)) / 3.6}cqw`,
    textAlign: st.align || "center",
    color: st.mode === "box" ? k : c,
  });
  el.style.setProperty("--st-c", c);
  el.style.setProperty("--st-k", k);
}

/** Текст истории: в режиме «Плашка» каждая строка получает свою подложку, как в привычных приложениях */
export function textNode(text, st) {
  const el = h("div.st-text");
  applyTextStyle(el, st);
  if (st.mode === "box" || st.mode === "glass") el.append(h("span.st-line", text));
  else el.textContent = text;
  place(el, st);
  return el;
}

export function place(el, p) {
  el.style.left = `${(p.x ?? .5) * 100}%`;
  el.style.top = `${(p.y ?? .5) * 100}%`;
}

const LINK_VARIANTS = ["light", "dark", "color"];
/** Стикер. interactive=false — в редакторе (ссылки не открываются) */
export function stickerNode(s, { interactive = true, onNavigate } = {}) {
  let el;
  const v = LINK_VARIANTS[s.v || 0] || "light";
  if (s.type === "link") {
    const inner = [icon("link", "sm"), h("span", s.label || s.url)];
    el = interactive
      ? h(`a.st-sticker.st-chip.v-${v}`, { href: s.url, target: "_blank", rel: "noopener noreferrer nofollow", onclick: (e) => e.stopPropagation() }, ...inner)
      : h(`div.st-sticker.st-chip.v-${v}`, ...inner);
  } else if (s.type === "mention") {
    const inner = [h("b", "@"), h("span", s.name || s.username)];
    el = interactive
      ? h(`a.st-sticker.st-chip.v-${v}`, { href: `/u/${s.username}`, onclick: () => onNavigate?.() }, ...inner)
      : h(`div.st-sticker.st-chip.v-${v}`, ...inner);
  } else if (s.type === "tag") {
    const inner = [h("b", "#"), h("span", s.tag)];
    el = interactive
      ? h(`a.st-sticker.st-chip.v-${v}`, { href: `/tag/${encodeURIComponent(s.tag)}`, onclick: () => onNavigate?.() }, ...inner)
      : h(`div.st-sticker.st-chip.v-${v}`, ...inner);
  } else if (s.type === "time" || s.type === "date") {
    el = h(`div.st-sticker.st-clock.v-${v}`, s.text);
  } else {
    el = h(`div.st-sticker.st-emoji.s-${s.v || 0}`, s.e);
  }
  place(el, s);
  return el;
}

/** Рисует историю целиком: фон/фото, текст, стикеры */
export function renderStory(stage, st, opts = {}) {
  const style = st.style || { ...defaultStyle(!!st.media), y: st.media ? .82 : .45, size: st.media ? 20 : 28, mode: st.media ? "glass" : "plain" };
  stage.style.background = st.media ? "#000" : (BACKGROUNDS[st.background] || BACKGROUNDS.blue);
  stage.replaceChildren(
    st.media ? h("img.st-photo", { src: st.media, alt: st.text || "История" }) : null,
    st.text ? textNode(st.text, style) : null,
    ...(style.stickers || []).map((s) => stickerNode(s, opts)));
}
