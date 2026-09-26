// Небольшие утилиты для построения интерфейса без фреймворков.
// Весь пользовательский текст вставляется через textContent — это защищает от XSS.

const SVG_NS = "http://www.w3.org/2000/svg";

/** h("div.card.pad", {onclick}, child1, [child2, child3], "текст") */
export function h(tag, props, ...children) {
  if (props == null || typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") throw new Error("html запрещён");
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

// ---------------------------------------------------------------- Иконки
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 20z"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><line x1="21" y1="21" x2="16.4" y2="16.4"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  thumb: '<path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H7V10l4-8a3 3 0 0 1 4 3.9z"/><path d="M3 10h4v11H3z"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  more: '<circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checks: '<polyline points="16 6 6.5 16.5 2 12"/><polyline points="22 6 12.5 16.5 11 15"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  block: '<circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 13 2 6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><line x1="1" y1="1" x2="23" y2="23"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h3c0 3-1 4-4 5z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h3c0 3-1 4-4 5z"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  heartRel: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};

export function icon(name, cls = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || ""; // только константы из этого файла
  return svg;
}

export function logo(withText = true) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<rect width="64" height="64" rx="18" fill="#1f3fae"/><circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-width="7"/><circle cx="45.5" cy="18.5" r="6.5" fill="#f5761a" stroke="#1f3fae" stroke-width="3"/>';
  return h("a.logo", { href: "/", "aria-label": "Круг — на главную" }, svg, withText ? h("span", "Круг") : null);
}

// ---------------------------------------------------------------- Аватар
const PALETTE = ["#1f3fae", "#c2560c", "#1a8a4a", "#7c3aed", "#be185d", "#0e7490", "#a16207", "#4338ca"];
export function thumb(url) { return url ? url.replace(/\.webp$/, "_t.webp") : url; }

export function avatar(user, size = "", opts = {}) {
  const el = h(`span.avatar${size ? "." + size : ""}`, { dataset: { userId: user?.id ?? "" } });
  if (user?.online && opts.presence !== false) el.dataset.online = "true";
  if (user?.avatar) {
    el.append(h("img", { src: ["xl", "lg"].includes(size) ? user.avatar : thumb(user.avatar), alt: "", loading: "lazy" }));
  } else {
    const name = user?.name || "?";
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    el.textContent = initials || "?";
    el.classList.add("initials");
    el.style.setProperty("--av", PALETTE[(user?.id || 0) % PALETTE.length]);
  }
  return el;
}

// ---------------------------------------------------------------- Текст
export function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
export const pl = (n, forms) => `${n} ${plural(n, forms)}`;

const TOKEN_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{1,50})|(^|[^\w@])@([A-Za-z0-9_]{3,30})/gu;

/** Текст с кликабельными ссылками, #хэштегами и @упоминаниями (без innerHTML). */
export function richText(text, cls = "rich") {
  const el = h(`div.${cls}`);
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    let start = m.index;
    if (m[1]) {
      el.append(text.slice(last, start));
      el.append(h("a", { href: m[1], target: "_blank", rel: "noopener noreferrer nofollow" }, m[1].length > 60 ? m[1].slice(0, 57) + "…" : m[1]));
      last = start + m[1].length;
    } else if (m[3]) {
      start += m[2].length;
      el.append(text.slice(last, start));
      el.append(h("a", { href: `/tag/${encodeURIComponent(m[3].toLowerCase())}` }, `#${m[3]}`));
      last = start + 1 + m[3].length;
    } else if (m[5]) {
      start += m[4].length;
      el.append(text.slice(last, start));
      el.append(h("a", { href: `/u/${m[5]}` }, `@${m[5]}`));
      last = start + 1 + m[5].length;
    }
  }
  el.append(text.slice(last));
  return el;
}

// ---------------------------------------------------------------- Время
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const pad = (n) => String(n).padStart(2, "0");
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

export function timeAgo(iso) {
  const d = new Date(iso), now = new Date();
  const s = Math.round((now - d) / 1000);
  if (s < 45) return "только что";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} мин назад`;
  if (sameDay(d, now)) return `${Math.round(s / 3600)} ч назад`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `вчера в ${hm(d)}`;
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? `${base} в ${hm(d)}` : `${base} ${d.getFullYear()}`;
}

export function shortTime(iso) {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return hm(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "вчера";
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return "Сегодня";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Вчера";
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : ""}`;
}

export function fullDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()} в ${hm(d)}`;
}

export function birthDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS_FULL[m - 1]} ${y}`;
}

export function joinedDate(iso) {
  const d = new Date(iso);
  const months = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
  return `в ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** Автоматическая высота textarea */
export function autosize(ta) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * 0.5) + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return fit;
}
