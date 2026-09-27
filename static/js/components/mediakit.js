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

export function audioPlayer(m) {
  const audio = new Audio();
  audio.preload = "none";
  audio.src = m.url;
  const btn = h("button.ap-play", { type: "button", "aria-label": "Слушать" }, icon("play"));
  const fill = h("i.ap-fill");
  const bar = h("div.ap-bar", { role: "slider", "aria-label": "Перемотка", tabindex: 0, "aria-valuemin": 0, "aria-valuemax": 100 }, fill,
    ...Array.from({ length: 28 }, (_, i) => h("span.ap-wave", { style: { "--hgt": `${30 + Math.abs(Math.sin(i * 1.7 + (m.url.length % 7))) * 70}%` } })));
  const time = h("span.ap-time", fmtDur(m.duration || 0));
  const el = h("div.audio-player",
    btn,
    h("div.ap-main",
      h("div.ap-title", h("b", m.title || "Аудио"), m.artist ? h("span", ` — ${m.artist}`) : null),
      bar,
      h("div.ap-foot", time, h("span.ap-size", fmtSize(m.size)))));
  const paint = () => {
    const d = audio.duration || m.duration || 0;
    const pct = d ? (audio.currentTime / d) * 100 : 0;
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    time.textContent = audio.paused && !audio.currentTime ? fmtDur(d) : `${fmtDur(audio.currentTime)} / ${fmtDur(d)}`;
  };
  btn.addEventListener("click", () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => {});
    } else audio.pause();
  });
  audio.addEventListener("play", () => { btn.replaceChildren(icon("pause")); btn.setAttribute("aria-label", "Пауза"); el.classList.add("playing"); announce(); });
  audio.addEventListener("pause", () => { btn.replaceChildren(icon("play")); btn.setAttribute("aria-label", "Слушать"); el.classList.remove("playing"); });
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("ended", () => { audio.currentTime = 0; paint(); });
  const seek = (clientX) => {
    const r = bar.getBoundingClientRect();
    const d = audio.duration || m.duration;
    if (!d) return;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d;
    paint();
  };
  bar.addEventListener("pointerdown", (e) => { seek(e.clientX); bar.setPointerCapture(e.pointerId); });
  bar.addEventListener("pointermove", (e) => { if (e.buttons) seek(e.clientX); });
  bar.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") audio.currentTime += 5;
    if (e.key === "ArrowLeft") audio.currentTime -= 5;
  });
  return el;
}

export function videoPlayer(m) {
  const ratio = m.w && m.h ? `${m.w} / ${m.h}` : "16 / 9";
  const v = h("video.chat-video", { src: m.url, poster: m.poster || "", controls: true, playsinline: true, preload: "none",
    style: { aspectRatio: ratio } });
  v.addEventListener("play", () => { if (playing && playing !== v) playing.pause(); playing = v; announce(); });
  return h("div.video-wrap", v, m.duration ? h("span.video-dur", fmtDur(m.duration)) : null);
}

// ---------------------------------------------------------------- Голосовые сообщения
const SPEEDS = [1, 1.5, 2];

export function voicePlayer(m) {
  const audio = new Audio();
  audio.preload = "none";
  audio.src = m.url;
  const wave = (m.waveform && m.waveform.length ? m.waveform : Array.from({ length: 40 }, (_, i) => 25 + Math.abs(Math.sin(i * 1.3)) * 60));
  const btn = h("button.ap-play", { type: "button", "aria-label": "Слушать голосовое" }, icon("play"));
  const bars = h("div.vp-wave", { role: "slider", "aria-label": "Перемотка", tabindex: 0 },
    wave.map((v) => h("span", { style: { height: `${Math.max(12, v)}%` } })));
  const time = h("span.ap-time", fmtDur(m.duration || 0));
  let speed = 0;
  const speedBtn = h("button.vp-speed", { type: "button", "aria-label": "Скорость воспроизведения" }, "1×");
  const el = h("div.voice-player", btn, h("div.ap-main", bars, h("div.ap-foot", time, speedBtn)));
  const spans = [...bars.children];
  const paint = () => {
    const d = audio.duration && Number.isFinite(audio.duration) ? audio.duration : m.duration || 0;
    const p = d ? audio.currentTime / d : 0;
    const upto = Math.round(p * spans.length);
    spans.forEach((s, i) => s.classList.toggle("on", i < upto));
    time.textContent = audio.paused && !audio.currentTime ? fmtDur(d) : fmtDur(audio.currentTime);
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
  });
  audio.addEventListener("play", () => { btn.replaceChildren(icon("pause")); el.classList.add("playing"); announce(); });
  audio.addEventListener("pause", () => { btn.replaceChildren(icon("play")); el.classList.remove("playing"); });
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("ended", () => { audio.currentTime = 0; paint(); });
  const seek = (x) => {
    const r = bars.getBoundingClientRect();
    const d = audio.duration && Number.isFinite(audio.duration) ? audio.duration : m.duration;
    if (!d) return;
    audio.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    paint();
  };
  bars.addEventListener("pointerdown", (e) => { seek(e.clientX); bars.setPointerCapture(e.pointerId); });
  bars.addEventListener("pointermove", (e) => { if (e.buttons) seek(e.clientX); });
  return el;
}

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
