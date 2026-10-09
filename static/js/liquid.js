// Yarko Liquid Glass: живое стекло навигации и элементов управления.
// 1) Режим (liquid | classic) — на устройство, до отрисовки ставит theme-init.js.
// 2) Блик, который следует за курсором (на телефоне — за наклоном).
// 3) «Жидкая» капсула активной вкладки: перетекает между пунктами меню пружиной.
// 4) Преломление краёв стекла (SVG feDisplacementMap) там, где браузер это умеет (Chromium).
import { lowPower } from "./motion.js";

const root = document.documentElement;
const KEY = "krug-glass";
const FINE = matchMedia("(pointer: fine)").matches;
const reduceMotion = () => root.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;

export function glassMode() {
  try { return localStorage.getItem(KEY) || "liquid"; } catch { return "liquid"; }
}
export function setGlassMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* приватный режим */ }
  applyMode(true);
}
function applyMode(explicit = false) {
  let mode = glassMode();
  // «меньше прозрачности» в системе — матовое стекло; на слабых устройствах стекло остаётся, но без преломления
  if (root.dataset.transparency === "reduce" && !explicit) mode = "classic";
  if (root.dataset.skin === "retro") mode = "classic"; // стиль «Ретро 2010» — без стекла
  root.dataset.glass = mode;
  requestAnimationFrame(() => { syncPills(false); refreshRefraction(); });
}

// ---------------------------------------------------------------- блик
let raf = 0, lx = 0, ly = 0;
function flush() {
  raf = 0;
  root.style.setProperty("--lx", lx);
  root.style.setProperty("--ly", ly);
}
function initSpecular() {
  if (FINE) {
    root.classList.add("lg-fixed");
    addEventListener("pointermove", (e) => {
      lx = `${e.clientX}px`; ly = `${e.clientY}px`;
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });
  } else if (!lowPower()) { // на телефонах выключено: смена переменной у корня пересчитывает стили всей страницы ~60 раз в секунду
    addEventListener("deviceorientation", (e) => {
      if (e.gamma == null || reduceMotion()) return;
      const x = Math.max(0, Math.min(100, 50 + e.gamma * 1.6));
      const y = Math.max(0, Math.min(100, 20 + (e.beta - 45) * 0.9));
      lx = `${x.toFixed(1)}%`; ly = `${y.toFixed(1)}%`;
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });
  }
}

// ---------------------------------------------------------------- жидкая капсула
const pills = new Map(); // контейнер → { pill, sel, last }

function rectIn(el, box) {
  const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  return { x: a.left - b.left + box.scrollLeft, y: a.top - b.top + box.scrollTop, w: a.width, h: a.height };
}

function placePill(box, rec, animate) {
  const { pill, sel, inset } = rec;
  const active = [...box.querySelectorAll(sel)].find((a) => a.offsetParent !== null);
  if (!active || root.dataset.glass !== "liquid") { pill.classList.remove("on"); rec.last = null; return; }
  const r0 = rectIn(active, box);
  const r = { x: r0.x + inset.x, y: r0.y + inset.y, w: r0.w - inset.x * 2, h: r0.h - inset.y * 2 };
  const to = { transform: `translate(${r.x}px, ${r.y}px)`, width: `${r.w}px`, height: `${r.h}px` };
  const from = rec.last;
  Object.assign(pill.style, to);
  pill.classList.add("on");
  rec.last = r;
  if (!animate || !from || reduceMotion() || !pill.animate) return;
  if (Math.abs(from.x - r.x) < 1 && Math.abs(from.y - r.y) < 1) return;
  // капля вытягивается от старого места к новому, потом собирается — как ртуть
  const horiz = Math.abs(r.x - from.x) > Math.abs(r.y - from.y);
  const mid = horiz
    ? { x: Math.min(from.x, r.x) + Math.abs(r.x - from.x) * 0.15, y: r.y + r.h * 0.08, w: Math.abs(r.x - from.x) * 0.7 + Math.max(r.w, from.w), h: r.h * 0.84 }
    : { x: r.x + r.w * 0.04, y: Math.min(from.y, r.y) + Math.abs(r.y - from.y) * 0.15, w: r.w * 0.92, h: Math.abs(r.y - from.y) * 0.7 + Math.max(r.h, from.h) };
  const kf = (q) => ({ transform: `translate(${q.x}px, ${q.y}px)`, width: `${q.w}px`, height: `${q.h}px` });
  pill.animate([kf(from), { ...kf(mid), offset: 0.38 }, kf(r)], { duration: 560, easing: "cubic-bezier(.3, 1.35, .45, 1)" });
}

export function syncPills(animate = true) {
  for (const [box, rec] of pills) {
    if (!box.isConnected) { pills.delete(box); continue; }
    placePill(box, rec, animate);
  }
}

/** Добавить капсулу в контейнер меню; sel — селектор активного пункта */
export function attachPill(box, sel, inset = { x: 0, y: 0 }) {
  if (!box || pills.has(box)) return;
  const pill = document.createElement("span");
  pill.className = "lg-pill";
  pill.setAttribute("aria-hidden", "true");
  box.prepend(pill);
  const rec = { pill, sel, inset, last: null };
  pills.set(box, rec);
  // нажатие: капля чуть «набухает», как в iOS
  box.addEventListener("pointerdown", (e) => {
    const a = e.target.closest("a");
    if (a && a.matches(sel)) pill.classList.add("press");
  });
  const up = () => pill.classList.remove("press");
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);
  box.addEventListener("pointerleave", up);
  box.addEventListener("toggle", () => placePill(box, rec, false), true);
  if (window.ResizeObserver) new ResizeObserver(() => placePill(box, rec, false)).observe(box);
}

// ---------------------------------------------------------------- преломление краёв
const CAN_REFRACT = (() => {
  const brands = navigator.userAgentData?.brands || [];
  return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
})();
const refracted = new Map(); // элемент → { id, w, h }
let svgHost = null;

function displacementMap(w, h, radius, bezel) {
  // карта смещений: в центре нейтрально (128,128), у краёв стекло «тянет» фон внутрь, как линза
  const c = document.createElement("canvas");
  const s = 0.5; // половинное разрешение: карта гладкая, а считается в 4 раза быстрее
  const W = Math.max(2, Math.round(w * s)), H = Math.max(2, Math.round(h * s));
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  const R = Math.min(radius, w / 2, h / 2) * s, B = bezel * s;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // расстояние до края скруглённого прямоугольника и нормаль
      const qx = Math.max(R - x, 0, x - (W - 1 - R)), qy = Math.max(R - y, 0, y - (H - 1 - R));
      let d, nx, ny;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        d = R - len;
        nx = (x < W / 2 ? -1 : 1) * qx / (len || 1); ny = (y < H / 2 ? -1 : 1) * qy / (len || 1);
      } else {
        const dl = x, dr = W - 1 - x, dt = y, db = H - 1 - y;
        d = Math.min(dl, dr, dt, db);
        nx = d === dl ? -1 : d === dr ? 1 : 0; ny = nx ? 0 : (d === dt ? -1 : 1);
      }
      const t = Math.max(0, 1 - d / B);
      const m = t * t * (3 - 2 * t); // плавный скос
      const i = (y * W + x) * 4;
      img.data[i] = 128 + nx * m * 127;
      img.data[i + 1] = 128 + ny * m * 127;
      img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function refractEl(el, { radius, bezel = 18, scale = 34 }) {
  if (!svgHost) {
    svgHost = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgHost.setAttribute("aria-hidden", "true");
    svgHost.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    document.body.appendChild(svgHost);
  }
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
  if (!w || !h) return;
  let rec = refracted.get(el);
  if (rec && rec.w === w && rec.h === h) return;
  const id = rec?.id || `lg-r${refracted.size + 1}`;
  const r = radius ?? parseFloat(getComputedStyle(el).borderTopLeftRadius) ?? 24;
  const ns = "http://www.w3.org/2000/svg";
  let f = svgHost.querySelector(`#${id}`);
  if (!f) {
    f = document.createElementNS(ns, "filter");
    f.id = id;
    f.setAttribute("color-interpolation-filters", "sRGB");
    f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", "100%"); f.setAttribute("height", "100%");
    f.setAttribute("filterUnits", "userSpaceOnUse");
    const im = document.createElementNS(ns, "feImage");
    im.setAttribute("result", "map"); im.setAttribute("preserveAspectRatio", "none");
    const dm = document.createElementNS(ns, "feDisplacementMap");
    dm.setAttribute("in", "SourceGraphic"); dm.setAttribute("in2", "map");
    dm.setAttribute("xChannelSelector", "R"); dm.setAttribute("yChannelSelector", "G");
    f.append(im, dm);
    svgHost.appendChild(f);
  }
  f.setAttribute("width", w); f.setAttribute("height", h);
  const im = f.querySelector("feImage");
  im.setAttribute("width", w); im.setAttribute("height", h);
  im.setAttribute("href", displacementMap(w, h, r, bezel));
  f.querySelector("feDisplacementMap").setAttribute("scale", String(-scale));
  el.style.setProperty("--lg-refract", `url(#${id})`);
  el.classList.add("lg-refract");
  refracted.set(el, { id, w, h, opts: { radius, bezel, scale } });
}

const refractTargets = [];
export function refract(el, opts = {}) {
  if (root.dataset.refract !== "1" || !el) return;
  refractTargets.push([el, opts]);
  if (window.ResizeObserver) new ResizeObserver(() => { if (root.dataset.glass === "liquid") refractEl(el, opts); }).observe(el);
  if (root.dataset.glass === "liquid") refractEl(el, opts);
}
function refreshRefraction() {
  if (root.dataset.glass !== "liquid") return;
  for (const [el, opts] of refractTargets) if (el.isConnected) refractEl(el, opts);
}

export function initLiquid() {
  applyMode();
  let force = null;
  try { force = localStorage.getItem("krug-refract"); } catch { /* */ }
  if (CAN_REFRACT && force !== "0" && (force === "1" || !lowPower())) root.dataset.refract = "1";
  initSpecular();
  addEventListener("resize", () => syncPills(false), { passive: true });
}
