// Эквалайзер Yarko: 10 полос с готовыми настройками и живой спектр в большом плеере.
// Звук обрабатывается в браузере (Web Audio) — сервер не нагружается. Работает для треков с нашего сервера
// (песни Yarko и музыка из раздела); радио с чужих сайтов браузер обрабатывать не даёт, оно играет как есть.
import { h, icon } from "../dom.js";
import { modal } from "../ui.js";

export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const LABELS = ["32", "64", "125", "250", "500", "1к", "2к", "4к", "8к", "16к"];
export const PRESETS = [
  ["flat", "Обычный", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ["bass", "Бас", [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]],
  ["bassplus", "Много баса", [9, 8, 6, 3, 0, -1, -1, 0, 0, 0]],
  ["rock", "Рок", [5, 4, 2, -1, -2, -1, 2, 4, 5, 5]],
  ["pop", "Поп", [-1, 1, 3, 4, 4, 2, 0, -1, -1, -1]],
  ["dance", "Электроника", [6, 5, 1, 0, -2, 1, 3, 4, 5, 4]],
  ["hiphop", "Хип-хоп", [6, 5, 2, 3, -1, -1, 1, -1, 2, 3]],
  ["vocal", "Вокал", [-2, -2, -1, 1, 3, 4, 4, 3, 1, 0]],
  ["jazz", "Джаз", [3, 2, 1, 2, -1, -1, 0, 1, 2, 3]],
  ["classic", "Классика", [4, 3, 2, 1, -1, -1, 0, 2, 3, 4]],
  ["acoustic", "Акустика", [4, 3, 2, 1, 1, 1, 2, 3, 3, 2]],
  ["night", "Тихо ночью", [-3, -2, 0, 1, 2, 2, 1, -1, -3, -4]],
  ["treble", "Звонкий", [-2, -2, -1, 0, 0, 1, 3, 5, 6, 7]],
];
const KEY = "krug-eq";

let el = null;            // основной аудиоэлемент плеера
let ac = null, src = null, filters = [], pre = null, analyser = null;
let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.gains) && s.gains.length === BANDS.length) return { on: !!s.on, preset: s.preset || "custom", gains: s.gains.map((g) => clamp(+g || 0)) };
  } catch { /* повреждено — по умолчанию */ }
  return { on: false, preset: "flat", gains: BANDS.map(() => 0) };
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* приватный режим */ } }
const clamp = (g) => Math.max(-12, Math.min(12, Math.round(g)));

export const eqState = () => state;
export function eqActive() { return state.on && state.gains.some((g) => g !== 0); }

/** Плеер сообщает свой основной элемент; если эквалайзер был включён раньше — подключаемся сразу */
export function bindEq(audioEl) {
  el = audioEl;
  el.addEventListener("play", () => { if (ac && ac.state === "suspended") ac.resume().catch(() => {}); });
  if (eqActive()) ensureGraph();
}

/** Цепочка обработки создаётся один раз и только по просьбе человека (включил эквалайзер или открыл спектр) */
function ensureGraph() {
  if (ac || !el) return !!ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ac = new AC();
    src = ac.createMediaElementSource(el);
    pre = ac.createGain();
    filters = BANDS.map((f, i) => {
      const b = ac.createBiquadFilter();
      b.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    let node = src.connect(pre);
    for (const f of filters) node = node.connect(f);
    node.connect(analyser);
    analyser.connect(ac.destination);
    apply();
    if (!el.paused) ac.resume().catch(() => {});
    return true;
  } catch {
    ac = null;
    return false;
  }
}

function apply() {
  if (!ac) return;
  const on = state.on;
  filters.forEach((f, i) => { f.gain.value = on ? state.gains[i] : 0; });
  // запас по громкости, чтобы подъём частот не «хрипел»
  const peak = on ? Math.max(0, ...state.gains) : 0;
  pre.gain.value = Math.pow(10, -peak * 0.6 / 20);
}

export function setEq(patch) {
  state = { ...state, ...patch };
  persist();
  if (eqActive()) ensureGraph();
  apply();
  window.dispatchEvent(new CustomEvent("krug:eq"));
}

/** Спектр для живой полоски в плеере: массив 0..1 или null, если обработка недоступна */
const bins = new Uint8Array(128);
export function spectrum(out, opts = {}) {
  if (!ac && opts.connect) ensureGraph();
  if (!analyser) return false;
  analyser.getByteFrequencyData(bins);
  const n = out.length;
  // полосы на логарифмической шкале — басы и верха видны одинаково хорошо
  for (let i = 0; i < n; i++) {
    const a = Math.floor(Math.pow(i / n, 1.7) * 100), b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * 100));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, bins[k]);
    out[i] = m / 255;
  }
  return true;
}

// ---------------------------------------------------------------- окно эквалайзера
export function openEqualizer({ crossOrigin = false } = {}) {
  const presetRow = h("div.eq-presets");
  const sliders = h("div.eq-bands");
  const onBox = h("input", { type: "checkbox", role: "switch", checked: state.on, "aria-label": "Эквалайзер включён" });
  const paint = () => {
    presetRow.replaceChildren(...PRESETS.map(([id, name]) => h(`button.eq-chip${state.preset === id ? ".on" : ""}`, { type: "button",
      onclick: () => { setEq({ on: id !== "flat" || state.on, preset: id, gains: PRESETS.find((p) => p[0] === id)[2].slice() }); onBox.checked = state.on; paint(); } }, name)),
      state.preset === "custom" ? h("button.eq-chip.on", { type: "button" }, "Своя") : null);
    sliders.querySelectorAll("input").forEach((r, i) => { r.value = state.gains[i]; r.closest(".eq-band").querySelector("b").textContent = fmt(state.gains[i]); });
    sliders.classList.toggle("off", !state.on);
  };
  const fmt = (g) => (g > 0 ? `+${g}` : String(g));
  sliders.append(...BANDS.map((_, i) => {
    const r = h("input.eq-range", { type: "range", min: -12, max: 12, step: 1, value: state.gains[i], "aria-label": `Полоса ${LABELS[i]} Гц`, orient: "vertical" });
    r.addEventListener("input", () => {
      const gains = state.gains.slice(); gains[i] = clamp(+r.value);
      setEq({ gains, preset: "custom", on: true }); onBox.checked = true;
      r.closest(".eq-band").querySelector("b").textContent = fmt(gains[i]);
      sliders.classList.remove("off");
      presetRow.querySelectorAll(".eq-chip").forEach((c) => c.classList.remove("on"));
    });
    return h("label.eq-band", h("b", fmt(state.gains[i])), h("span.eq-track", r), h("small", LABELS[i]));
  }));
  onBox.addEventListener("change", () => { setEq({ on: onBox.checked }); paint(); });
  paint();
  const m = modal({
    title: "Эквалайзер",
    body: h("div.stack.eq-box",
      h("label.setting-row.eq-onrow", h("div.label-block", h("b", "Эквалайзер"), h("small", "Настройка сохранится на этом устройстве")), onBox),
      presetRow, sliders,
      crossOrigin ? h("p.field-hint", icon("alert", "sm"), " Радиостанции играют без эквалайзера — их звук браузер изменять не разрешает.") : null),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => { setEq({ preset: "flat", gains: BANDS.map(() => 0) }); paint(); } }, "Сбросить"),
      h("button.btn.primary", { type: "button", onclick: () => m.close() }, "Готово")],
  });
  m.dialog?.classList?.add("eq-modal");
  return m;
}
