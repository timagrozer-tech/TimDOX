// Motion-система QEVI: физические пружины → CSS linear(), чтобы анимации шли на компоновщике без JS в каждом кадре.
// Три пружины на весь продукт: snappy (кнопки, переключатели), gentle (листы, окна, страницы), bouncy (лайки, достижения).
// Плюс определение слабых устройств: на них стекло без размытия и без «живого» фона.

/** Пружина → { easing: "linear(...)", duration } по жёсткости, затуханию и начальной скорости */
export function spring({ stiffness = 300, damping = 26, mass = 1, velocity = 0 } = {}) {
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const pos = (t) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 - velocity) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + (w0 - velocity) * t); // критическое затухание
  };
  let dur = 0.1;
  for (let t = 0; t < 4; t += 1 / 120) if (Math.abs(1 - pos(t)) > 0.001) dur = t;
  const n = Math.min(64, Math.max(12, Math.ceil(dur * 50)));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(+pos((i / n) * dur).toFixed(4));
  pts[n] = 1;
  return { easing: `linear(${pts.join(", ")})`, duration: Math.round(dur * 1000) };
}

export const SPRINGS = {
  snappy: spring({ stiffness: 420, damping: 30 }),
  gentle: spring({ stiffness: 220, damping: 26 }),
  bouncy: spring({ stiffness: 320, damping: 15 }),
};

const supportsLinear = (() => { try { return CSS.supports("transition-timing-function", "linear(0, 1)"); } catch { return false; } })();

/** Слабое устройство: мало памяти/ядер, экономия трафика или пользователь просит меньше прозрачности */
export function lowPower() {
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  const save = navigator.connection?.saveData;
  return mem <= 3 || cores <= 3 || !!save;
}

export function initMotion() {
  const root = document.documentElement;
  if (supportsLinear) {
    for (const [name, s] of Object.entries(SPRINGS)) {
      root.style.setProperty(`--spring-${name}`, s.easing);
      root.style.setProperty(`--spring-${name}-ms`, `${s.duration}ms`);
    }
  }
  if (lowPower()) { root.dataset.perf = "low"; root.classList.add("lite"); }
  if (matchMedia("(prefers-reduced-transparency: reduce)").matches) root.dataset.transparency = "reduce";
  // шапка уплотняется при прокрутке: стекло становится менее прозрачным, когда под ним контент
  let scrolled = false;
  const onScroll = () => {
    const s = window.scrollY > 8;
    if (s !== scrolled) { scrolled = s; root.classList.toggle("is-scrolled", s); }
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/** Анимация элемента пружиной (Web Animations API); при reduced-motion — мгновенно */
export function animate(el, keyframes, kind = "gentle", extra = {}) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced") return null;
  const s = SPRINGS[kind] || SPRINGS.gentle;
  return el.animate(keyframes, { duration: s.duration, easing: supportsLinear ? s.easing : "cubic-bezier(.2,.9,.3,1.2)", fill: "both", ...extra });
}
