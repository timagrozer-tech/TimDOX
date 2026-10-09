// Музыкальный плеер Yarko: один на всё приложение, продолжает играть при переходах между страницами.
// Мини-плеер над нижней панелью и полноэкранный плеер «Орбита» с очередью, перемешиванием и повтором.
import { api, state, on as onApp } from "../api.js";
import { h, icon } from "../dom.js";
import { toast, toastError, showMenu } from "../ui.js";
import { pushOverlay, navigate } from "../router.js";
import { fmtDur, pauseLocalMedia } from "../components/mediakit.js";

const STORE = "krug-player";
const audio = new Audio();
audio.preload = "metadata";

let queue = [];        // треки в порядке воспроизведения
let original = null;   // порядок до перемешивания
let index = -1;
let ctx = "";          // откуда играет: «Волна Yarko», «Жанр: Поп»…
let shuffle = false;
let repeat = "off";    // off | all | one
let errors = 0;
let loadSeq = 0, failedSeq = -1, skipTimer = 0; // одна ошибка на одну загрузку: иначе «ошибка + отказ play()» крутили очередь по кругу
let buffering = false;
const liked = new Set();
let likesLoaded = false;
const listeners = new Set();

export const current = () => queue[index] || null;
export const isPlaying = () => !audio.paused && !!current();
// аудио и обложки идут через наш сервер: в России Audius и многие сайты с картинками напрямую не открываются
export const streamUrl = (t) => (t.source === "audius" ? `/api/music/play/${encodeURIComponent(t.id)}` : t.stream);
export const artUrl = (u) => (u && /^https:\/\//.test(u) ? `/api/music/art?u=${encodeURIComponent(u)}` : u || "");

// ---------------------------------------------------------------- подписки
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() {
  const t = current();
  window.__krugMusicPlaying = isPlaying();
  // подсветка строк с текущим треком во всех списках на странице
  document.querySelectorAll("[data-track].is-current").forEach((el) => {
    if (!t || el.dataset.track !== t.key) el.classList.remove("is-current", "is-playing");
  });
  if (t) document.querySelectorAll(`[data-track="${CSS.escape(t.key)}"]`).forEach((el) => {
    el.classList.add("is-current");
    el.classList.toggle("is-playing", isPlaying());
  });
  listeners.forEach((fn) => { try { fn(t); } catch (e) { console.error(e); } });
  paintUi();
}

// ---------------------------------------------------------------- любимые треки
export async function loadLikes(force = false) {
  if (!state.me || (likesLoaded && !force)) return liked;
  try {
    const d = await api.get("/api/music/likes");
    liked.clear();
    d.items.forEach((t) => liked.add(t.key));
    likesLoaded = true;
    paintLikes();
  } catch { /* не страшно — сердечки подтянутся позже */ }
  return liked;
}
export function setLiked(keys) { liked.clear(); keys.forEach((k) => liked.add(k)); likesLoaded = true; paintLikes(); }
export const isLiked = (key) => liked.has(key);
export async function toggleLike(t) {
  if (!t) return;
  const was = liked.has(t.key);
  if (was) liked.delete(t.key); else liked.add(t.key);
  paintLikes();
  try {
    if (was) await api.del("/api/music/likes", { key: t.key });
    else await api.post("/api/music/likes", { key: t.key });
    toast(was ? "Убрано из «Моей музыки»" : "Добавлено в «Мою музыку»", { icon: was ? "x" : "heart" });
  } catch (e) {
    if (was) liked.add(t.key); else liked.delete(t.key);
    paintLikes();
    toastError(e);
  }
}
function paintLikes() {
  document.querySelectorAll("[data-like]").forEach((b) => {
    const on = liked.has(b.dataset.like);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Убрать из моей музыки" : "В мою музыку");
  });
}
/** Кнопка-сердечко для трека (обновляется сама при любом изменении) */
export function likeButton(t, cls = "") {
  const b = h(`button.mu-like${cls ? "." + cls : ""}`, { type: "button", dataset: { like: t.key }, title: "Моя музыка" }, icon("heart"));
  b.addEventListener("click", (e) => { e.stopPropagation(); toggleLike(t); });
  const on = liked.has(t.key);
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Убрать из моей музыки" : "В мою музыку");
  return b;
}

// ---------------------------------------------------------------- управление
export function playQueue(tracks, start = 0, context = "") {
  const list = (tracks || []).filter((t) => t && !t.preview && (t.source !== "radio" || t.stream));
  if (!list.length) return;
  queue = list.slice(0, 300);
  original = null;
  index = Math.max(0, Math.min(start, queue.length - 1));
  ctx = context;
  if (shuffle) shuffleRest();
  load(true);
}
/** Нажали на трек в списке: если он уже в очереди — просто переключиться, иначе играть список с него */
export function playFrom(list, t, context = "") {
  const cur = current();
  if (cur && cur.key === t.key) { toggle(); return; }
  errors = 0;
  const i = list.findIndex((x) => x.key === t.key);
  playQueue(list, Math.max(0, i), context);
}
export function playNext(t) {
  if (!current()) { playQueue([t], 0); return; }
  queue.splice(index + 1, 0, t);
  toast("Сыграет следующим", { icon: "check" });
  save(); notify();
}
export function toggle() {
  if (!current()) return;
  if (audio.paused) errors = 0; // человек сам нажал «Играть» — даём трекам новую попытку
  if (audio.paused) play(); else audio.pause();
}
function play() {
  pauseLocalMedia();
  const seq = loadSeq;
  audio.play().catch((e) => {
    if (e.name === "NotAllowedError") { notify(); return; }
    if (e.name !== "AbortError") onError(seq);
  });
}
export function next(auto = false, fromError = false) {
  if (!queue.length) return;
  if (!auto && !fromError) errors = 0;
  if (auto && repeat === "one") { audio.currentTime = 0; play(); return; }
  if (index < queue.length - 1) index += 1;
  else if (repeat === "all" || !auto) index = 0;
  else { audio.pause(); audio.currentTime = 0; notify(); return; }
  load(true);
}
export function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 4 || index === 0) { audio.currentTime = 0; play(); return; }
  index -= 1;
  load(true);
}
export function jump(i) { if (i >= 0 && i < queue.length) { index = i; load(true); } }
export function seek(sec) { if (Number.isFinite(sec) && !current()?.live) audio.currentTime = Math.max(0, sec); }
export function setShuffle(on) {
  shuffle = on;
  if (on) shuffleRest();
  else if (original) {
    const cur = current();
    queue = original; original = null;
    index = Math.max(0, queue.findIndex((t) => t.key === cur?.key));
  }
  save(); notify();
}
function shuffleRest() {
  original = original || queue.slice();
  const rest = queue.slice(index + 1);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  queue = [...queue.slice(0, index + 1), ...rest];
}
export function cycleRepeat() {
  repeat = { off: "all", all: "one", one: "off" }[repeat];
  toast({ off: "Повтор выключен", all: "Повтор очереди", one: "Повтор трека" }[repeat], { icon: "repeat" });
  save(); notify();
}
export function stop() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  queue = []; index = -1; original = null; ctx = "";
  save(); notify();
  closeFull();
}

function load(autoplay) {
  const t = current();
  if (!t) return;
  buffering = true;
  clearTimeout(skipTimer);
  loadSeq += 1;
  audio.preload = "auto";
  audio.src = streamUrl(t);
  audio.currentTime = 0;
  mediaSession(t);
  if (autoplay) play();
  save(); notify();
}

function onError(seq = loadSeq) {
  const t = current();
  if (!t || seq !== loadSeq || failedSeq === seq) return; // эта загрузка уже обработана или устарела
  failedSeq = seq;
  errors += 1;
  buffering = false;
  if (errors >= Math.min(3, queue.length) || queue.length < 2) {
    toast(t.live ? "Станция сейчас не вещает" : "Не получается воспроизвести трек", { error: true, icon: "x" });
    audio.pause(); notify();
    return; // счётчик сбросится только после удачного запуска — повторной карусели не будет
  }
  toast(t.live ? "Станция не отвечает — включаю следующую" : "Трек недоступен — включаю следующий", { icon: "skipForward" });
  skipTimer = setTimeout(() => { if (seq === loadSeq) next(false, true); }, 700);
}

let countedKey = "";
audio.addEventListener("playing", () => {
  errors = 0; buffering = false; notify();
  const t = current();
  // песни людей Yarko: счётчик прослушиваний (раз за включение трека)
  if (t?.source === "yarko" && countedKey !== t.key) { countedKey = t.key; api.post(`/api/music/songs/${t.id}/play`).catch(() => {}); }
});
audio.addEventListener("pause", notify);
audio.addEventListener("waiting", () => { buffering = true; paintUi(); });
audio.addEventListener("canplay", () => { buffering = false; paintUi(); });
audio.addEventListener("ended", () => next(true));
audio.addEventListener("error", () => { if (audio.getAttribute("src")) onError(); });
audio.addEventListener("timeupdate", () => { paintTime(); if (Math.floor(audio.currentTime) % 5 === 0) save(); });
audio.addEventListener("loadedmetadata", paintTime);
audio.addEventListener("volumechange", () => save());

// чужое видео или голосовое со звуком — музыка на паузу
window.addEventListener("krug:local-play", () => { if (!audio.paused) audio.pause(); });
document.addEventListener("play", (e) => {
  const el = e.target;
  if (el instanceof HTMLMediaElement && el !== audio && !el.muted && !audio.paused) audio.pause();
}, true);

// ---------------------------------------------------------------- экран блокировки и наушники
function mediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist || "", album: ctx || "Yarko",
      artwork: t.artwork ? [{ src: artUrl(t.artwork), sizes: "480x480", type: "image/jpeg" }] : [{ src: "/static/img/icon-192.png", sizes: "192x192", type: "image/png" }],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => play());
    ms.setActionHandler("pause", () => audio.pause());
    ms.setActionHandler("previoustrack", () => prev());
    ms.setActionHandler("nexttrack", () => next());
    ms.setActionHandler("seekto", t.live ? null : (d) => seek(d.seekTime));
  } catch { /* старые браузеры */ }
}

// ---------------------------------------------------------------- сохранение между перезагрузками
function save() {
  try {
    if (!current()) { localStorage.removeItem(STORE); return; }
    const from = Math.max(0, index - 20);
    localStorage.setItem(STORE, JSON.stringify({
      queue: queue.slice(from, index + 80), index: index - from, t: Math.floor(audio.currentTime || 0),
      vol: audio.volume, shuffle, repeat, ctx,
    }));
  } catch { /* приватный режим */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!s || !Array.isArray(s.queue) || !s.queue[s.index] || s.queue[s.index].preview) return;
    const keep = s.queue.filter((t) => !t.preview); // 30-секундные фрагменты больше не играем
    s.index = keep.indexOf(s.queue[s.index]);
    s.queue = keep;
    queue = s.queue; index = s.index; shuffle = !!s.shuffle; repeat = s.repeat || "off"; ctx = s.ctx || "";
    audio.volume = typeof s.vol === "number" ? Math.min(1, Math.max(0, s.vol)) : 1;
    const t = current();
    audio.preload = "none"; // не тянем звук, пока человек не нажмёт «Играть»
    audio.src = streamUrl(t);
    if (s.t && !t.live) audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.min(s.t, (audio.duration || s.t) - 1); }, { once: true });
    mediaSession(t);
    notify();
  } catch { /* повреждённые данные — начнём с чистого листа */ }
}

// ---------------------------------------------------------------- мини-плеер
let mini = null, full = null, releaseOverlay = null, queueOpen = false;

function cover(t, cls = "") {
  return t?.artwork
    ? h(`img.mu-cover${cls ? "." + cls : ""}`, { src: artUrl(t.artwork), alt: "", loading: "lazy" })
    : h(`span.mu-cover.mu-cover-empty${cls ? "." + cls : ""}`, { "aria-hidden": "true", style: { "--hue": String(hue(t?.key || "")) } },
      t?.live ? icon("radio") : icon("music"));
}
export const coverOf = cover;
export function hue(s) { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360; return x; }

function buildMini() {
  const el = h("div.mp", { role: "region", "aria-label": "Музыкальный плеер" },
    h("div.mp-progress", h("i")),
    h("button.mp-open", { type: "button", "aria-label": "Открыть плеер", onclick: () => openFull() },
      h("span.mp-art"), h("span.mp-meta", h("b.mp-title"), h("span.mp-artist"))),
    h("div.mp-ctrls",
      h("span.mp-like-slot"),
      h("button.mp-btn.mp-prev", { type: "button", "aria-label": "Предыдущий", onclick: () => prev() }, icon("skipBack")),
      h("button.mp-btn.mp-play", { type: "button", "aria-label": "Играть", onclick: () => toggle() }, icon("play")),
      h("button.mp-btn.mp-next", { type: "button", "aria-label": "Следующий", onclick: () => next() }, icon("skipForward")),
      h("button.mp-btn.mp-close", { type: "button", "aria-label": "Закрыть плеер", title: "Закрыть", onclick: () => stop() }, icon("x"))));
  // жесты: вверх — открыть большой плеер, вниз — скрыть, влево/вправо — следующий/предыдущий трек
  let x0 = null, y0 = null;
  el.addEventListener("touchstart", (e) => { if (e.target.closest(".mp-ctrls")) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (x0 == null) return;
    const dx = e.touches[0].clientX - x0;
    if (Math.abs(dx) > 12) el.querySelector(".mp-open").style.transform = `translateX(${Math.max(-80, Math.min(80, dx * 0.5))}px)`;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    el.querySelector(".mp-open").style.transform = "";
    if (dy < -40 && Math.abs(dy) > Math.abs(dx)) openFull();
    else if (dy > 45 && Math.abs(dy) > Math.abs(dx)) { stop(); toast("Плеер закрыт", { icon: "x" }); } // смахнуть вниз — скрыть
    else if (Math.abs(dx) > 70 && !current()?.live) { if (dx < 0) next(); else prev(); }
    x0 = null;
  });
  document.body.append(el);
  return el;
}

// ---------------------------------------------------------------- большой плеер «Орбита»
function buildFull() {
  const seekInput = h("input.fp-range", { type: "range", min: 0, max: 1000, value: 0, step: 1, "aria-label": "Перемотка" });
  let dragging = false;
  seekInput.addEventListener("input", () => {
    dragging = true;
    const d = duration();
    full.querySelector(".fp-cur").textContent = fmtDur((seekInput.value / 1000) * d);
    seekInput.style.setProperty("--p", `${seekInput.value / 10}%`);
  });
  seekInput.addEventListener("change", () => { seek((seekInput.value / 1000) * duration()); dragging = false; });
  seekInput.isDragging = () => dragging;
  const vol = h("input.fp-range.fp-vol", { type: "range", min: 0, max: 100, value: Math.round(audio.volume * 100), "aria-label": "Громкость" });
  vol.addEventListener("input", () => { audio.volume = vol.value / 100; vol.style.setProperty("--p", `${vol.value}%`); });
  vol.style.setProperty("--p", `${vol.value}%`);

  const el = h("div.fp", { role: "dialog", "aria-modal": "true", "aria-label": "Плеер", hidden: true },
    h("div.fp-bg", h("img", { alt: "", referrerpolicy: "no-referrer" })),
    h("div.fp-inner",
      h("div.fp-main",
        h("header.fp-top",
          h("button.fp-icon", { type: "button", "aria-label": "Свернуть плеер", onclick: () => closeFull() }, icon("down")),
          h("div.fp-ctx", h("small", "Сейчас играет"), h("b.fp-ctx-name")),
          h("button.fp-icon.fp-more", { type: "button", "aria-label": "Ещё" }, icon("more"))),
        h("div.fp-stage",
          h("div.fp-waves", h("i"), h("i"), h("i")),
          h("div.fp-orbit", h("span.fp-planet")),
          h("div.fp-disc"),
          h("div.fp-hole")),
        h("div.fp-info",
          h("div.fp-titles", h("h2.fp-title"), h("p.fp-artist")),
          h("span.fp-like-slot")),
        h("div.fp-seek", seekInput, h("div.fp-times", h("span.fp-cur", "0:00"), h("span.fp-dur", "0:00"))),
        h("div.fp-live", h("i"), "Прямой эфир"),
        h("div.fp-ctrls",
          h("button.fp-icon.fp-shuffle", { type: "button", "aria-label": "Перемешать", onclick: () => setShuffle(!shuffle) }, icon("shuffle")),
          h("button.fp-icon.fp-big", { type: "button", "aria-label": "Предыдущий", onclick: () => prev() }, icon("skipBack")),
          h("button.fp-play", { type: "button", "aria-label": "Играть", onclick: () => toggle() }, icon("play")),
          h("button.fp-icon.fp-big", { type: "button", "aria-label": "Следующий", onclick: () => next() }, icon("skipForward")),
          h("button.fp-icon.fp-repeat", { type: "button", "aria-label": "Повтор", onclick: () => cycleRepeat() }, icon("repeat"), h("small", "1"))),
        h("div.fp-extra",
          h("label.fp-volume", icon("volume", "sm"), vol),
          h("button.fp-chip", { type: "button", onclick: () => shareTrack(current()) }, icon("share", "sm"), "В ленту"),
          h("button.fp-chip.fp-queue-btn", { type: "button", "aria-expanded": "false", onclick: () => (queueOpen ? closeQueue() : openQueue()) }, icon("list", "sm"), "Очередь"))),
      h("div.fp-scrim", { onclick: () => closeQueue() }),
      h("aside.fp-queue", { "aria-label": "Очередь" },
        h("div.fp-queue-grip", { "aria-hidden": "true" }),
        h("div.fp-queue-head",
          h("div", h("b", "Очередь"), h("small.fp-queue-count")),
          h("button.fp-qbtn.fp-clear", { type: "button", onclick: () => clearUpcoming() }, "Очистить"),
          h("button.fp-icon.fp-qclose", { type: "button", "aria-label": "Закрыть очередь", onclick: () => closeQueue() }, icon("x"))),
        h("div.fp-queue-list"))));
  el.querySelector(".fp-more").addEventListener("click", (e) => trackMenu(e.currentTarget, current(), { inPlayer: true }));
  // очередь на телефоне — шторка: смахнуть вниз за заголовок, чтобы закрыть
  let qy0 = null, qdy = 0;
  const sheet = el.querySelector(".fp-queue");
  sheet.addEventListener("touchstart", (e) => {
    if (!e.target.closest(".fp-queue-head, .fp-queue-grip")) { qy0 = null; return; }
    qy0 = e.touches[0].clientY; qdy = 0;
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (qy0 == null) return;
    qdy = Math.max(0, e.touches[0].clientY - qy0);
    sheet.style.transform = `translateY(${qdy}px)`;
  }, { passive: true });
  sheet.addEventListener("touchend", () => {
    if (qy0 == null) return;
    sheet.style.transform = "";
    if (qdy > 70) closeQueue();
    qy0 = null;
  });
  // свайп вниз — свернуть
  let y0 = null, dy = 0;
  const top = el.querySelector(".fp-main");
  top.addEventListener("touchstart", (e) => { if (e.target.closest("input") || queueOpen) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  top.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    el.style.transform = `translateY(${dy * 0.6}px)`;
  }, { passive: true });
  top.addEventListener("touchend", () => {
    if (y0 == null) return;
    el.style.transform = "";
    if (dy > 110) closeFull();
    y0 = null;
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (queueOpen) closeQueue(); else closeFull(); return; }
    if (e.target.closest("input, textarea")) return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") seek((audio.currentTime || 0) + 10);
    else if (e.key === "ArrowLeft") seek((audio.currentTime || 0) - 10);
  });
  el._seek = seekInput;
  document.body.append(el);
  return el;
}

export function openFull() {
  if (!current()) return;
  full = full || buildFull();
  if (!full.hidden) return;
  full.hidden = false;
  document.body.classList.add("fp-open");
  requestAnimationFrame(() => full.classList.add("on"));
  releaseOverlay = pushOverlay(() => closeFull(true));
  paintUi();
  full.querySelector(".fp-play").focus({ preventScroll: true });
}
let releaseQueue = null;
const queueIsSheet = () => window.innerWidth < 900;
export function openQueue() {
  if (!full || full.hidden) return;
  queueOpen = true;
  full.querySelector(".fp-inner").scrollTop = 0;
  if (queueIsSheet()) releaseQueue = pushOverlay(() => closeQueue(true));
  paintUi();
}
export function closeQueue(fromBack = false) {
  if (!queueOpen) return;
  queueOpen = false;
  const r = releaseQueue; releaseQueue = null;
  if (!fromBack) r?.();
  paintUi();
}
export function removeFromQueue(i) {
  if (i === index || i < 0 || i >= queue.length) return;
  const [gone] = queue.splice(i, 1);
  if (original) original = original.filter((t) => t.key !== gone.key);
  if (i < index) index -= 1;
  save(); notify();
}
export function clearUpcoming() {
  if (queue.length <= index + 1) return;
  queue = queue.slice(0, index + 1);
  original = null;
  toast("Очередь очищена", { icon: "check" });
  save(); notify();
}

export function closeFull(fromBack = false) {
  if (!full || full.hidden) return;
  if (queueOpen) { queueOpen = false; const r = releaseQueue; releaseQueue = null; if (!fromBack) r?.(); }
  full.classList.remove("on");
  document.body.classList.remove("fp-open");
  setTimeout(() => { if (!full.classList.contains("on")) full.hidden = true; }, 260);
  const r = releaseOverlay; releaseOverlay = null;
  if (!fromBack) r?.();
}

const duration = () => {
  const t = current();
  return audio.duration && Number.isFinite(audio.duration) ? audio.duration : t?.duration || 0;
};

function paintTime() {
  const d = duration(), cur = audio.currentTime || 0;
  const pct = d ? Math.min(100, (cur / d) * 100) : 0;
  if (mini) mini.querySelector(".mp-progress i").style.width = `${current()?.live ? 100 : pct}%`;
  if (full && !full.hidden && !full._seek.isDragging()) {
    full._seek.value = String(Math.round(pct * 10));
    full._seek.style.setProperty("--p", `${pct}%`);
    full.querySelector(".fp-cur").textContent = fmtDur(cur);
    full.querySelector(".fp-dur").textContent = fmtDur(d);
  }
}

// на компьютере мини-плеер стоит ровно под центральной колонкой страницы
let ro = null, observed = null;
function placeMini() {
  if (!mini) return;
  const main = document.getElementById("main");
  if (!main || window.innerWidth < 720) { mini.style.removeProperty("--mp-x"); mini.style.removeProperty("--mp-w"); return; }
  if (observed !== main && "ResizeObserver" in window) {
    ro = ro || new ResizeObserver(() => placeMini());
    if (observed) ro.unobserve(observed);
    ro.observe(main); observed = main;
  }
  const r = main.getBoundingClientRect();
  mini.style.setProperty("--mp-x", `${Math.round(r.left + r.width / 2)}px`);
  mini.style.setProperty("--mp-w", `${Math.round(Math.min(r.width, 680))}px`);
}
window.addEventListener("resize", () => placeMini());

function paintUi() {
  const t = current();
  document.body.classList.toggle("has-player", !!t);
  if (!t) { if (mini) mini.hidden = true; return; }
  mini = mini || buildMini();
  mini.hidden = false;
  placeMini();
  const playing = isPlaying();
  mini.classList.toggle("playing", playing);
  mini.classList.toggle("buffering", buffering && playing);
  mini.classList.toggle("live", !!t.live);
  if (mini.dataset.key !== t.key) {
    mini.dataset.key = t.key;
    mini.querySelector(".mp-art").replaceChildren(cover(t));
    mini.querySelector(".mp-title").textContent = t.title;
    mini.querySelector(".mp-artist").textContent = t.live ? `В эфире · ${t.artist}` : t.artist;
    mini.querySelector(".mp-like-slot").replaceChildren(likeButton(t, "mp-btn"));
  }
  const pb = mini.querySelector(".mp-play");
  pb.replaceChildren(icon(playing ? "pause" : "play"));
  pb.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  paintTime();
  if (!full || full.hidden) return;
  full.classList.toggle("playing", playing);
  full.classList.toggle("buffering", buffering && playing);
  full.classList.toggle("live", !!t.live);
  full.classList.toggle("queue-open", queueOpen);
  full.querySelector(".fp-queue-btn").setAttribute("aria-expanded", String(queueOpen));
  full.classList.toggle("shuffle-on", shuffle);
  full.dataset.repeat = repeat;
  full.querySelector(".fp-ctx-name").textContent = (ctx || (t.live ? "Радио" : "Музыка Yarko")) + (sleepAt ? " · ⏾" : "");
  const fpPlay = full.querySelector(".fp-play");
  fpPlay.replaceChildren(icon(playing ? "pause" : "play"));
  fpPlay.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  if (full.dataset.key !== t.key) {
    full.dataset.key = t.key;
    full.style.setProperty("--hue", String(hue(t.key)));
    const bg = full.querySelector(".fp-bg img");
    if (t.artwork) { bg.src = artUrl(t.artwork); bg.hidden = false; } else bg.hidden = true;
    full.querySelector(".fp-disc").replaceChildren(cover(t, "fp-cover"));
    full.querySelector(".fp-title").textContent = t.title;
    full.querySelector(".fp-artist").textContent = t.artist || "";
    full.querySelector(".fp-like-slot").replaceChildren(likeButton(t, "fp-like"));
  }
  const list = full.querySelector(".fp-queue-list");
  const sig = `${index}:${queue.length}:${queue[0]?.key}:${queue[queue.length - 1]?.key}`;
  if (queueOpen && list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    full.querySelector(".fp-queue-count").textContent = `${index + 1} из ${queue.length}`;
    full.querySelector(".fp-clear").hidden = queue.length <= index + 1;
    list.replaceChildren(...queue.map((q, i) => h(`div.fp-q${i === index ? ".now" : ""}${i < index ? ".past" : ""}`,
      h("button.fp-q-main", { type: "button", onclick: () => jump(i), "aria-label": `Играть «${q.title}»` },
        cover(q), h("span", h("b", q.title), h("small", q.artist)), h("small.fp-q-dur", q.live ? "эфир" : fmtDur(q.duration))),
      i === index ? h("span.fp-q-now", { "aria-label": "Играет сейчас" }, h("i"), h("i"), h("i"))
        : h("button.fp-q-del", { type: "button", "aria-label": `Убрать «${q.title}» из очереди`, onclick: () => removeFromQueue(i) }, icon("x", "sm")))));
    // прокручиваем только сам список (scrollIntoView сдвигал весь плеер, и кнопки уезжали за экран)
    requestAnimationFrame(() => {
      const now = list.querySelector(".now");
      if (now) list.scrollTop = Math.max(0, now.offsetTop - list.offsetTop - list.clientHeight / 2 + now.offsetHeight / 2);
    });
  }
}

// ---------------------------------------------------------------- действия с треком
export async function shareTrack(t) {
  if (!t) return;
  const { openComposerModal } = await import("../components/composer.js");
  closeFull();
  openComposerModal({ music: t });
}

const openUrl = (url) => window.open(url, "_blank", "noopener");

// ---------------------------------------------------------------- таймер сна
let sleepTimer = null, sleepAt = 0;
export function setSleep(min) {
  clearTimeout(sleepTimer); sleepTimer = null; sleepAt = 0;
  if (min === "track") {
    const left = Math.max(1, duration() - (audio.currentTime || 0));
    min = left / 60;
  }
  if (min) {
    sleepAt = Date.now() + min * 60000;
    sleepTimer = setTimeout(() => { audio.pause(); sleepAt = 0; toast("Таймер сна: музыка остановлена", { icon: "moon" }); paintUi(); }, min * 60000);
    toast(`Музыка выключится через ${Math.round(min)} мин`, { icon: "moon" });
  } else toast("Таймер сна выключен", { icon: "x" });
  paintUi();
}
function sleepMenu(anchor) {
  const left = sleepAt ? Math.max(1, Math.round((sleepAt - Date.now()) / 60000)) : 0;
  showMenu(anchor, [
    { label: "Через 15 минут", icon: "moon", onClick: () => setSleep(15) },
    { label: "Через 30 минут", icon: "moon", onClick: () => setSleep(30) },
    { label: "Через час", icon: "moon", onClick: () => setSleep(60) },
    current() && !current().live ? { label: "В конце трека", icon: "moon", onClick: () => setSleep("track") } : null,
    left ? { label: `Выключить (осталось ${left} мин)`, icon: "x", danger: true, onClick: () => setSleep(0) } : null,
  ], { title: "Таймер сна" });
}

export function trackMenu(anchor, t, { inPlayer = false } = {}) {
  if (!t) return;
  const liked = isLiked(t.key);
  showMenu(anchor, [
    !inPlayer && !t.live ? { label: "Играть следующим", icon: "queueAdd", onClick: () => playNext(t) } : null,
    { label: liked ? "Убрать из «Моей музыки»" : "В «Мою музыку»", icon: "heart", onClick: () => toggleLike(t) },
    { label: "Поделиться в ленте", icon: "share", onClick: () => shareTrack(t) },
    t.author ? { label: `Автор: ${t.author.name}`, icon: "user", onClick: () => { closeFull(); navigate(`/u/${t.author.username}`); } } : null,
    t.permalink ? { label: t.source === "audius" ? "Открыть на Audius" : "Сайт станции", icon: "external", onClick: () => openUrl(t.permalink) } : null,
    inPlayer ? "-" : null,
    inPlayer ? { label: sleepAt ? `Таймер сна · ${Math.max(1, Math.round((sleepAt - Date.now()) / 60000))} мин` : "Таймер сна", icon: "moon", onClick: () => setTimeout(() => sleepMenu(anchor), 50) } : null,
    inPlayer ? { label: "Раздел «Музыка»", icon: "music", onClick: () => { closeFull(); navigate("/music"); } } : null,
  ], { title: t.title });
}

// ---------------------------------------------------------------- запуск
onApp("logged-out", () => { stop(); liked.clear(); likesLoaded = false; try { localStorage.removeItem(STORE); } catch { /* ничего */ } });
export function initPlayer() {
  if (!state.me) return;
  restore();
  if (current()) loadLikes();
}
