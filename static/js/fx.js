// Эффекты «Орбиты»: фоновая сцена с параллаксом, 3D-наклон, световое пятно, появление при прокрутке,
// рябь и «магнит» у кнопок, взрыв эмодзи, параллакс обложек, прогресс прокрутки.
// Всё построено на transform/opacity и requestAnimationFrame; отключается настройкой «Анимации».

const FINE_POINTER = matchMedia("(hover: hover) and (pointer: fine)").matches;
// Облегчённый режим для телефонов и планшетов: без параллакса, 3D-орбит и анимации звёзд —
// фон рисуется один раз и не нагружает процессор при прокрутке.
export const LITE = !FINE_POINTER || matchMedia("(max-width: 719px)").matches;
if (LITE) document.documentElement.classList.add("lite");
const lerp = (a, b, t) => a + (b - a) * t;

export function motionEnabled() {
  if (document.documentElement.dataset.motion === "reduced") return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function setMotion(mode) {
  try { localStorage.setItem("krug-motion", mode); } catch { /* приватный режим */ }
  document.documentElement.dataset.motion = mode;
}
export function currentMotion() {
  try { return localStorage.getItem("krug-motion") || "full"; } catch { return "full"; }
}

// ---------------------------------------------------------------- Фоновая сцена
const pointer = { x: 0, y: 0, tx: 0, ty: 0 }; // нормализовано в [-1, 1]
let scrollY = 0;
let layers = [];

function buildScene() {
  if (document.getElementById("scene")) return;
  const scene = document.createElement("div");
  scene.id = "scene";
  scene.setAttribute("aria-hidden", "true");
  scene.innerHTML = `
    <div class="scene-layer scene-photo" data-depth="10" data-scroll="0.02"></div>
    <div class="scene-layer scene-mesh" data-depth="14" data-scroll="0.03"></div>
    <div class="scene-layer aurora" data-depth="18" data-scroll="0.04">
      <span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="blob b4"></span>
    </div>
    ${LITE ? "" : `<div class="scene-layer orbits" data-depth="40" data-scroll="0.12">
      <div class="tilt"><div class="ring"><i></i></div><div class="ring"><i></i></div><div class="ring"><i></i></div></div>
    </div>`}
    <canvas class="scene-layer stars" data-depth="70" data-scroll="0.22"></canvas>
    <div class="grain"></div>`;
  document.body.prepend(scene);
  const bar = document.createElement("div");
  bar.id = "scroll-progress";
  document.body.append(bar);
  layers = [...scene.querySelectorAll(".scene-layer")].map((el) => ({ el, depth: +el.dataset.depth, scroll: +el.dataset.scroll }));
  initStars(scene.querySelector(".stars"));
}

// Звёзды: мерцающие точки на canvas, перерисовка ~30 кадров/с
function initStars(canvas) {
  const ctx = canvas.getContext("2d");
  let stars = [];
  let w = 0, h = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(LITE ? 70 : 160, (w * h) / (LITE ? 12000 : 9000)));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.4 + .3,
      p: Math.random() * Math.PI * 2, s: Math.random() * .02 + .005, v: Math.random() * .08 + .02,
    }));
  };
  resize();
  let last = 0;
  if (LITE) {
    // на телефоне — статичная картинка, перерисовка только при изменении размера или смене фона
    const still = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--star").trim() || "220,210,255";
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color},${(.3 + Math.random() * .5).toFixed(2)})`;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    let rt = 0;
    addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); still(); }, 200); });
    new MutationObserver(still).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    still();
    return;
  }
  addEventListener("resize", resize);
  const draw = (t) => {
    requestAnimationFrame(draw);
    if (t - last < 33 || document.hidden) return;
    const bgMode = document.documentElement.dataset.bg || "orbit";
    if (bgMode !== "orbit" && bgMode !== "stars") return;
    last = t;
    const color = getComputedStyle(document.documentElement).getPropertyValue("--star").trim() || "220,210,255";
    ctx.clearRect(0, 0, w, h);
    const moving = motionEnabled();
    for (const s of stars) {
      if (moving) { s.p += s.s * 2; s.y -= s.v; if (s.y < -4) { s.y = h + 4; s.x = Math.random() * w; } }
      const a = .25 + (Math.sin(s.p) + 1) * .35;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${color},${a.toFixed(3)})`;
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  requestAnimationFrame(draw);
}

let lastKey = "";
function loop() {
  if (LITE) return; // на телефоне слои фона неподвижны
  requestAnimationFrame(loop);
  const on = motionEnabled();
  pointer.x = lerp(pointer.x, on ? pointer.tx : 0, .06);
  pointer.y = lerp(pointer.y, on ? pointer.ty : 0, .06);
  const key = `${pointer.x.toFixed(4)}|${pointer.y.toFixed(4)}|${scrollY}`;
  if (key === lastKey) return;
  lastKey = key;
  for (const l of layers) {
    const dx = -pointer.x * l.depth;
    const dy = -pointer.y * l.depth - (on ? scrollY * l.scroll : 0);
    l.el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
  }
  // орбитальная система на странице входа реагирует на курсор
  if (!orbitScene?.isConnected) orbitScene = document.querySelector(".orbit-scene");
  if (orbitScene) {
    orbitScene.style.setProperty("--rx", `${(pointer.x * 14).toFixed(2)}deg`);
    orbitScene.style.setProperty("--ry", `${(-pointer.y * 10).toFixed(2)}deg`);
    orbitScene.style.setProperty("--ox", `${(pointer.x * 14).toFixed(2)}px`);
    orbitScene.style.setProperty("--oy", `${(pointer.y * 10).toFixed(2)}px`);
  }
}
let orbitScene = null;

// ---------------------------------------------------------------- 3D-наклон карточек
const TILT_SELECTOR = ".event-card, .auth-card, .profile-top > div:first-child, .date-badge, .comm-row .comm-avatar, .widget-tilt, [data-tilt]";
let tiltEl = null;

function tiltMove(e) {
  const el = e.target.closest?.(TILT_SELECTOR);
  if (el !== tiltEl) { if (tiltEl) tiltReset(tiltEl); tiltEl = el; }
  if (!el || !motionEnabled()) return;
  if (!el.hasAttribute("data-tilt")) el.setAttribute("data-tilt", "");
  if (!el.querySelector(":scope > .tilt-glare") && getComputedStyle(el).position !== "static") {
    const g = document.createElement("span"); g.className = "tilt-glare"; el.append(g);
  }
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  const max = el.classList.contains("auth-card") ? 6 : el.classList.contains("event-card") ? 10 : 16;
  el.classList.add("tilting");
  el.style.transform = `perspective(900px) rotateX(${((.5 - py) * max).toFixed(2)}deg) rotateY(${((px - .5) * max).toFixed(2)}deg) translateZ(0)`;
  el.style.setProperty("--gx", `${(px * 100).toFixed(1)}%`);
  el.style.setProperty("--gy", `${(py * 100).toFixed(1)}%`);
}
function tiltReset(el) { el.classList.remove("tilting"); el.style.transform = ""; }

// ---------------------------------------------------------------- Световое пятно на карточках
let spotEl = null;
function spotMove(e) {
  const el = e.target.closest?.(".card");
  if (spotEl && spotEl !== el) { spotEl.style.removeProperty("--mx"); spotEl.style.removeProperty("--my"); }
  spotEl = el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${(e.clientX - r.left).toFixed(0)}px`);
  el.style.setProperty("--my", `${(e.clientY - r.top).toFixed(0)}px`);
}

// ---------------------------------------------------------------- Магнитные кнопки
const MAGNET = ".btn.primary, .btn.accent, .tabbar .create, .create-btn";
let magnetEl = null;
function magnetMove(e) {
  const el = e.target.closest?.(MAGNET);
  if (magnetEl && magnetEl !== el) { magnetEl.style.transform = ""; }
  magnetEl = el;
  if (!el || !motionEnabled() || el.disabled) return;
  const r = el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  el.classList.add("magnetic");
  el.style.transform = `translate(${(dx * .18).toFixed(1)}px, ${(dy * .28).toFixed(1)}px)`;
}

// ---------------------------------------------------------------- Рябь при нажатии
function ripple(e) {
  const el = e.target.closest?.(".btn:not(.icon-btn), .action, .tabs button, .segmented button, .menu button");
  if (!el || !motionEnabled()) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = `${size}px`;
  s.style.left = `${e.clientX - r.left - size / 2}px`;
  s.style.top = `${e.clientY - r.top - size / 2}px`;
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.style.overflow = "hidden";
  el.append(s);
  setTimeout(() => s.remove(), 650);
}

// ---------------------------------------------------------------- Взрыв эмодзи (реакции)
export function burst(target, emoji = "❤️", count = 14) {
  if (!motionEnabled()) return;
  const r = target.getBoundingClientRect();
  const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
  const pool = Array.isArray(emoji) ? emoji : [emoji, emoji, "✨"];
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "burst";
    s.textContent = pool[i % pool.length];
    const a = (Math.PI * 2 * i) / count + Math.random() * .5;
    const d = 50 + Math.random() * 70;
    s.style.setProperty("--x0", `${x0 - 10}px`);
    s.style.setProperty("--y0", `${y0 - 12}px`);
    s.style.setProperty("--dx", `${(Math.cos(a) * d).toFixed(0)}px`);
    s.style.setProperty("--dy", `${(Math.sin(a) * d - 30).toFixed(0)}px`);
    s.style.setProperty("--r", `${(Math.random() * 90 - 45).toFixed(0)}deg`);
    s.style.fontSize = `${14 + Math.random() * 12}px`;
    document.body.append(s);
    setTimeout(() => s.remove(), 950);
  }
}

// ---------------------------------------------------------------- Появление при прокрутке
const REVEAL = ".card, .post, .event-card, .person, .notif, .conv, .trend, .story-item, .mini-person";
const io = new IntersectionObserver((entries) => {
  let i = 0;
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const el = en.target;
    el.style.setProperty("--rv-delay", `${Math.min(i++, 8) * 55}ms`);
    el.classList.add("rv-in");
    io.unobserve(el);
    setTimeout(() => { el.classList.remove("rv", "rv-in"); el.style.removeProperty("--rv-delay"); }, 1400);
  }
}, { rootMargin: "0px 0px -6% 0px" });

function prepareReveal(root) {
  if (!motionEnabled()) return;
  const nodes = root.matches?.(REVEAL) ? [root] : [];
  nodes.push(...(root.querySelectorAll?.(REVEAL) || []));
  for (const el of nodes) {
    if (el.dataset.rv || el.closest(".modal, .menu, .toast, .story-viewer, .chat-body")) continue;
    el.dataset.rv = "1";
    el.classList.add("rv");
    io.observe(el);
  }
}

// ---------------------------------------------------------------- Параллакс обложек и прогресс
function onScroll() {
  scrollY = window.scrollY;
  const max = document.documentElement.scrollHeight - innerHeight;
  const bar = document.getElementById("scroll-progress");
  if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  if (!motionEnabled() || LITE) return;
  document.querySelectorAll(".cover").forEach((c) => {
    const r = c.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    c.style.setProperty("--py", `${(-r.top * .35).toFixed(1)}px`);
  });
}

// ---------------------------------------------------------------- Запуск
export function initFx() {
  document.documentElement.dataset.motion = currentMotion();
  buildScene();
  addEventListener("pointermove", (e) => {
    pointer.tx = (e.clientX / innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / innerHeight) * 2 - 1;
    if (!FINE_POINTER) return;
    tiltMove(e); spotMove(e); magnetMove(e);
  }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.tx = 0; pointer.ty = 0; });
  document.addEventListener("pointerdown", ripple, { passive: true });
  // на телефоне фон слегка следует за наклоном устройства
  if (!LITE) addEventListener("deviceorientation", (e) => {
    if (FINE_POINTER || e.gamma == null) return;
    pointer.tx = Math.max(-1, Math.min(1, e.gamma / 30));
    pointer.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
  }, { passive: true });
  addEventListener("scroll", onScroll, { passive: true });
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) prepareReveal(n);
    onScroll();
  }).observe(document.getElementById("app"), { childList: true, subtree: true });
  requestAnimationFrame(loop);
}
