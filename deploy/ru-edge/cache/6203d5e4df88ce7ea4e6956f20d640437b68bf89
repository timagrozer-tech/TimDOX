// Показ любого стикера: WebP/GIF — картинка, TGS — анимация Lottie, WEBM — видео без звука.
// Анимации запускаются только на экране и останавливаются за его пределами; одновременно играет ограниченное число —
// так панель с тысячами стикеров не тормозит даже на слабом телефоне. Lottie грузится, только когда встретился TGS.
import { h } from "../dom.js";

const LOTTIE_URL = "/static/vendor/lottie/lottie_light.min.js";
let lottieMod = null;
const lottie = () => (lottieMod ||= import(LOTTIE_URL).then((m) => m.default || m));

const lite = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced"
      || (navigator.deviceMemory && navigator.deviceMemory < 3) || navigator.connection?.saveData;
  } catch { return false; }
};
const MAX_PLAYING = () => (lite() ? 0 : (navigator.hardwareConcurrency || 4) >= 6 ? 24 : 10);
const playing = new Set();

// разбор TGS: gzip с JSON (браузер распаковывает сам, если сервер уже отдал без сжатия — тоже ок)
const animCache = new Map();
async function loadAnim(url) {
  if (animCache.has(url)) return animCache.get(url);
  const p = (async () => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b && "DecompressionStream" in window) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else text = new TextDecoder().decode(buf);
    return JSON.parse(text);
  })();
  animCache.set(url, p);
  if (animCache.size > 120) animCache.delete(animCache.keys().next().value);
  return p;
}

function start(el) {
  const st = el._st;
  if (!st || st.on || lite()) return;
  if (playing.size >= MAX_PLAYING()) return;
  st.on = true;
  playing.add(el);
  if (st.format === "webm") {
    const v = el.querySelector("video");
    if (v) { if (!v.src) v.src = st.url; v.play().catch(() => {}); }
  } else if (st.format === "tgs") {
    if (st.anim) { st.anim.play(); return; }
    Promise.all([lottie(), loadAnim(st.url)]).then(([L, data]) => {
      if (!st.on || !el.isConnected) return;
      const box = h("div.stv-lottie");
      el.append(box);
      st.anim = L.loadAnimation({ container: box, renderer: "svg", loop: true, autoplay: true, animationData: data,
        rendererSettings: { progressiveLoad: true, hideOnTransparent: true } });
      st.anim.addEventListener("DOMLoaded", () => el.classList.add("live"));
    }).catch(() => { el.classList.add("broken"); });
  }
}

function stop(el) {
  const st = el._st;
  if (!st || !st.on) return;
  st.on = false;
  playing.delete(el);
  if (st.format === "webm") el.querySelector("video")?.pause();
  else st.anim?.pause();
}

const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((entries) => {
  for (const e of entries) (e.isIntersecting ? start : stop)(e.target);
}, { rootMargin: "80px" }) : null;

// когда элемент удалён со страницы — освобождаем анимацию
const gc = setInterval(() => {
  for (const el of [...playing]) if (!el.isConnected) { stop(el); el._st?.anim?.destroy?.(); }
}, 5000);
void gc;

/** Элемент стикера. s: {url, format, thumb, emoji}. size — CSS-размер (по умолчанию заполняет родителя). */
export function stickerEl(s, { size = null, cls = "" } = {}) {
  const format = s.format || "webp";
  const el = h(`span.stv${cls ? "." + cls : ""}.f-${format}`, { role: "img", "aria-label": `Стикер ${s.emoji || ""}`.trim() });
  if (size) el.style.setProperty("--stv", typeof size === "number" ? `${size}px` : size);
  if (format === "webp") {
    el.append(h("img", { src: s.url, alt: "", loading: "lazy", decoding: "async", draggable: false }));
    return el;
  }
  // у анимаций сначала миниатюра (или первый кадр видео), затем живая анимация на экране
  if (s.thumb) el.append(h("img.stv-thumb", { src: s.thumb, alt: "", loading: "lazy", decoding: "async", draggable: false }));
  if (format === "webm") el.append(h("video", { muted: true, loop: true, playsInline: true, preload: "metadata", poster: s.thumb || undefined, ...(s.thumb ? {} : { src: s.url }) }));
  if (format === "tgs" && !s.thumb) el.append(h("span.stv-ph", s.emoji || "✨"));
  el._st = { format, url: s.url, on: false, anim: null };
  if (io) io.observe(el);
  return el;
}

/** Мини-превью для реакций и обложек: анимации тоже играют, но в маленьком размере. */
export const stickerMini = (s, size = 22) => stickerEl(s, { size, cls: "mini" });
