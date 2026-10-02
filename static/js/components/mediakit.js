// Видео и музыка: сведения о файле (длительность, кадр-обложка), плееры для чата.
import { h, icon } from "../dom.js";

export function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtSize(bytes) {
  if (!bytes) return "";
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Длительность, размеры и кадр-обложка видео (кадр берётся на ~1-й секунде). */
export function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "metadata"; v.src = url;
    const done = (poster) => {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight, poster };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    const timer = setTimeout(() => done(null), 8000);
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = Math.min(1, (v.duration || 1) / 3);
    }, { once: true });
    v.addEventListener("seeked", () => {
      try {
        const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => { clearTimeout(timer); done(b); }, "image/jpeg", .82);
      } catch { clearTimeout(timer); done(null); }
    }, { once: true });
    v.addEventListener("error", () => { clearTimeout(timer); done(null); }, { once: true });
  });
}

export function audioMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = "metadata"; a.src = url;
    const done = () => { URL.revokeObjectURL(url); resolve({ duration: a.duration }); };
    a.addEventListener("loadedmetadata", done, { once: true });
    a.addEventListener("error", done, { once: true });
    setTimeout(done, 6000);
  });
}

/** «Исполнитель — Название.mp3» → { artist, title } */
export function parseTrackName(filename) {
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { artist: "", title: base };
}

// ---------------------------------------------------------------- Плеер музыки
let playing = null; // одновременно играет только один трек
/** Сообщить музыкальному плееру Круга, что заиграло что-то другое, — он встанет на паузу */
const announce = () => window.dispatchEvent(new Event("krug:local-play"));
/** Поставить на паузу вложения (музыка, голосовые, видео в чатах) — когда включается плеер Круга */
export function pauseLocalMedia() { try { playing?.pause(); } catch { /* ничего */ } }

/** Остановить музыку, голосовые и видео — при уходе со страницы */
export function stopAllMedia() {
  try { playing?.pause(); } catch { /* ничего */ }
  playing = null;
  document.querySelectorAll("video").forEach((v) => { if (!v.closest(".reels")) v.pause(); });
}

// ---------------------------------------------------------------- голосовые и аудио: один красивый плеер
const RING = 2 * Math.PI * 21;

/** Столбики «псевдо-волны» для старых аудио без настоящей: свои у каждого файла, а не одинаковые у всех */
function pseudoWave(seed, n = 44) {
  let x = 0;
  for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: n }, (_, i) => {
    x = (x * 1103515245 + 12345) >>> 0;
    const r = (x >>> 16) / 65535;
    return Math.round(22 + r * 58 + Math.sin(i / 3 + (seed.length % 5)) * 14);
  });
}

/** Настоящая волна файла: громкость по 48 отрезкам (для аудио до 15 МБ) */
export async function audioWaveform(file, n = 48) {
  if (!file || file.size > 15 * 1024 * 1024) return [];
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 44100, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / n));
    const out = [];
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const a = i * step, b = Math.min(ch.length, a + step);
      for (let j = a; j < b; j += 8) sum += ch[j] * ch[j];
      out.push(Math.sqrt(sum / Math.max(1, (b - a) / 8)));
    }
    const max = Math.max(...out) || 1;
    return out.map((v) => Math.round(Math.max(8, (v / max) * 100)));
  } catch { return []; }
}

/** Блок текста под голосовым: готовая расшифровка, «расшифровываю…» или кнопка «Текст» */
function sttBlock(m, mid, auto) {
  if (!mid) return null;
  if (m.transcript) {
    const full = m.transcript;
    const long = full.length > 260;
    const p = h("p.stt-text", long ? `${full.slice(0, 240).trimEnd()}…` : full);
    const box = h("div.stt", h("span.stt-ic", icon("quote", "sm")), p);
    if (long) box.append(h("button.stt-more", { type: "button", onclick: (e) => { p.textContent = full; e.currentTarget.remove(); } }, "Показать всё"));
    return box;
  }
  if (m.transcript_state === "pending") return h("div.stt.pending", h("span.stt-dots", h("i"), h("i"), h("i")), h("span", "Расшифровываю голос…"));
  if (m.transcript_state === "empty") return h("div.stt.muted", "Речь не распознана");
  if (!m.stt) return null;
  const failed = m.transcript_state === "failed";
  const btn = h("button.stt-btn", { type: "button", "aria-label": "Показать текст голосового" }, h("span.stt-aa", "Аа"), failed ? "Повторить" : "Текст");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.replaceChildren(h("span.stt-dots", h("i"), h("i"), h("i")));
    try {
      const { api } = await import("../api.js");
      await api.post(`/api/messages/${mid}/transcribe`);   // готовый текст придёт через message_update
    } catch (e) {
      btn.disabled = false;
      btn.replaceChildren(h("span.stt-aa", "Аа"), "Текст");
      const { toastError } = await import("../ui.js");
      toastError(e);
    }
  });
  if (auto) return null;
  return h("div.stt-row", btn);
}

function mediaPlayer(m, { voice, mid }) {
  const audio = new Audio();
  audio.preload = "none";
  audio.src = m.url;
  const levels = m.waveform && m.waveform.length ? m.waveform : pseudoWave(m.url);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 48 48"); svg.setAttribute("class", "mp-ring"); svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(ns, "circle"); track.setAttribute("cx", 24); track.setAttribute("cy", 24); track.setAttribute("r", 21); track.setAttribute("class", "mp-ring-bg");
  const prog = document.createElementNS(ns, "circle"); prog.setAttribute("cx", 24); prog.setAttribute("cy", 24); prog.setAttribute("r", 21); prog.setAttribute("class", "mp-ring-fg");
  prog.style.strokeDasharray = String(RING); prog.style.strokeDashoffset = String(RING);
  svg.append(track, prog);
  const btn = h("button.mp-play", { type: "button", "aria-label": voice ? "Слушать голосовое" : "Слушать" }, svg, h("span.mp-ic", icon("play")));
  const bars = h("div.mp-wave", { role: "slider", "aria-label": "Перемотка", tabindex: 0, "aria-valuemin": 0, "aria-valuemax": 100 },
    levels.map((v) => h("span", { style: { "--v": `${Math.max(14, Math.min(100, v))}%` } })));
  const spans = [...bars.children];
  const time = h("span.mp-time", fmtDur(m.duration || 0));
  let speed = 0;
  const speedBtn = h("button.mp-speed", { type: "button", "aria-label": "Скорость воспроизведения" }, "1×");
  const title = voice ? null : h("div.mp-title", h("span.mp-note", icon("music", "sm")), h("b", m.title || "Аудио"), m.artist ? h("span.mp-artist", m.artist) : null);
  const foot = h("div.mp-foot", time, voice ? null : h("span.mp-size", fmtSize(m.size)), speedBtn);
  const el = h(`div.media-player${voice ? ".is-voice" : ".is-audio"}`, btn, h("div.mp-main", title, bars, foot));
  const dur = () => (audio.duration && Number.isFinite(audio.duration) ? audio.duration : m.duration || 0);
  const paint = () => {
    const d = dur();
    const p = d ? Math.min(1, audio.currentTime / d) : 0;
    const upto = p * spans.length;
    spans.forEach((s, i) => { s.classList.toggle("on", i < Math.floor(upto)); s.classList.toggle("half", i === Math.floor(upto) && p > 0); });
    prog.style.strokeDashoffset = String(RING * (1 - p));
    bars.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    time.textContent = audio.paused && !audio.currentTime ? fmtDur(d) : `${fmtDur(audio.currentTime)} / ${fmtDur(d)}`;
  };
  btn.addEventListener("click", () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.playbackRate = SPEEDS[speed];
      audio.play().catch(() => {});
    } else audio.pause();
  });
  speedBtn.addEventListener("click", () => {
    speed = (speed + 1) % SPEEDS.length;
    audio.playbackRate = SPEEDS[speed];
    speedBtn.textContent = `${SPEEDS[speed]}×`;
    speedBtn.classList.toggle("on", speed > 0);
  });
  audio.addEventListener("play", () => { btn.querySelector(".mp-ic").replaceChildren(icon("pause")); btn.setAttribute("aria-label", "Пауза"); el.classList.add("playing"); announce(); });
  audio.addEventListener("pause", () => { btn.querySelector(".mp-ic").replaceChildren(icon("play")); btn.setAttribute("aria-label", voice ? "Слушать голосовое" : "Слушать"); el.classList.remove("playing"); });
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("ended", () => { audio.currentTime = 0; paint(); el.classList.add("listened"); });
  const seek = (x) => {
    const r = bars.getBoundingClientRect();
    const d = dur();
    if (!d) return;
    audio.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    paint();
  };
  bars.addEventListener("pointerdown", (e) => { seek(e.clientX); bars.setPointerCapture(e.pointerId); });
  bars.addEventListener("pointermove", (e) => { if (e.buttons) seek(e.clientX); });
  bars.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(dur(), audio.currentTime + 5); paint(); }
    if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 5); paint(); }
  });
  const stt = sttBlock(m, mid, false);
  return stt ? h("div.media-player-wrap", el, stt) : el;
}

export function audioPlayer(m, mid = null) { return mediaPlayer(m, { voice: false, mid }); }
export function voicePlayer(m, mid = null) { return mediaPlayer(m, { voice: true, mid }); }

export function videoPlayer(m) {
  const ratio = m.w && m.h ? `${m.w} / ${m.h}` : "16 / 9";
  const v = h("video.chat-video", { src: m.url, poster: m.poster || "", controls: true, playsinline: true, preload: "none",
    style: { aspectRatio: ratio } });
  v.addEventListener("play", () => { if (playing && playing !== v) playing.pause(); playing = v; announce(); });
  return h("div.video-wrap", v, m.duration ? h("span.video-dur", fmtDur(m.duration)) : null);
}

// ---------------------------------------------------------------- Голосовые сообщения
const SPEEDS = [1, 1.5, 2];

/** Уровни громкости записи → 48 столбиков 0..100 */
export function downsampleLevels(levels, n = 48) {
  if (!levels.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * levels.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * levels.length));
    out.push(Math.max(...levels.slice(a, b)));
  }
  const max = Math.max(...out) || 1;
  return out.map((v) => Math.round(Math.max(6, (v / max) * 100)));
}
