// Ярко Плеер — офлайн-плеер для своей музыки. Всё хранится в IndexedDB на устройстве, сеть не нужна.
const $ = (id) => document.getElementById(id);
const audio = $("audio");
const LS = {
  get(k, d) { try { const v = localStorage.getItem("yp:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("yp:" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

/* ---------- хранилище ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("yarko-player", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("tracks", { keyPath: "id" });
      d.createObjectStore("blobs");
      d.createObjectStore("lists", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const all = (store) => tx(store, "readonly", (s) => s.getAll());
const put = (store, v, k) => tx(store, "readwrite", (s) => (k === undefined ? s.put(v) : s.put(v, k)));
const get = (store, k) => tx(store, "readonly", (s) => s.get(k));
const del = (store, k) => tx(store, "readwrite", (s) => s.delete(k));

/* ---------- теги ID3 ---------- */
const dec = (enc, b) => {
  try {
    if (enc === 1 || enc === 2) return new TextDecoder(enc === 2 ? "utf-16be" : "utf-16").decode(b);
    if (enc === 3) return new TextDecoder("utf-8").decode(b);
    // старые русские mp3 часто записаны в cp1251 под видом latin1
    return new TextDecoder(b.some((x) => x >= 0xc0) ? "windows-1251" : "latin1").decode(b);
  } catch { return ""; }
};
const clean = (s) => (s || "").replace(/\0/g, "").trim();
async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out; // "ID3"
    const ver = head[3];
    const size = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
    const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 4 << 20)).arrayBuffer());
    let p = 0;
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    while (p + hdr < buf.length) {
      const id = String.fromCharCode(...buf.slice(p, p + idLen));
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      let len;
      if (ver === 2) len = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      else if (ver === 4) len = ((buf[p + 4] & 127) << 21) | ((buf[p + 5] & 127) << 14) | ((buf[p + 6] & 127) << 7) | (buf[p + 7] & 127);
      else len = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
      const body = buf.slice(p + hdr, p + hdr + len);
      p += hdr + len;
      if (!len) break;
      const T = { TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TALB: "album", TAL: "album" }[id];
      if (T) out[T] = clean(dec(body[0], body.slice(1)));
      else if ((id === "APIC" || id === "PIC") && !out.cover) {
        const enc = body[0];
        let i = 1, mime = "image/jpeg";
        if (id === "APIC") { const e = body.indexOf(0, i); mime = dec(0, body.slice(i, e)) || mime; i = e + 1; }
        else { const f = dec(0, body.slice(1, 4)).toLowerCase(); mime = f === "png" ? "image/png" : "image/jpeg"; i = 4; }
        i += 1; // тип картинки
        if (enc === 1 || enc === 2) { while (i + 1 < body.length && (body[i] || body[i + 1])) i += 2; i += 2; }
        else { while (i < body.length && body[i]) i++; i++; }
        if (!mime.includes("/")) mime = "image/" + mime.toLowerCase();
        out.cover = new Blob([body.slice(i)], { type: mime });
      }
    }
  } catch { /* битый тег — возьмём имя файла */ }
  return out;
}
function fromName(name) {
  const base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/^\d{1,3}[\s.\-)]+/, "").trim();
  const m = base.split(/\s+[-–—]\s+/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(" - ").trim() } : { title: base };
}
function duration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const u = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(-1);
    setTimeout(() => done(0), 8000);
    a.src = u;
  });
}

/* ---------- звук: эквалайзер, стерео, спектр ---------- */
const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  "Ровно": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Мощный бас": [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  "Рок": [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  "Поп": [-1, 1, 3, 4, 3, 1, -1, -1, 0, 1],
  "Электроника": [6, 5, 1, 0, -2, 1, 0, 1, 4, 5],
  "Хип-хоп": [6, 5, 2, 3, -1, -1, 1, 0, 2, 3],
  "Голос и подкасты": [-3, -2, -1, 1, 4, 5, 4, 2, 0, -2],
  "Классика": [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  "Джаз": [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  "Наушники": [3, 2, 0, -1, -1, 0, 1, 3, 4, 3],
  "Маленький динамик": [-6, -4, 0, 3, 3, 2, 3, 3, 2, 0],
  "Ночь (тише бас)": [-5, -4, -2, 0, 1, 1, 0, -1, -2, -3],
};
const eqState = LS.get("eq", { on: false, preset: "Ровно", gains: PRESETS["Ровно"], preamp: 0, stereo: 100 });
let ctx, filters = [], preamp, analyser, fade, stereoGains;
function graph() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  const src = ctx.createMediaElementSource(audio);
  preamp = ctx.createGain();
  filters = BANDS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
    b.frequency.value = f; b.Q.value = 1.1;
    return b;
  });
  // ширина стерео: L' = L·(1+w)/2 + R·(1−w)/2, R' — зеркально
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  stereoGains = [0, 1, 2, 3].map(() => ctx.createGain());
  const [ll, rl, rr, lr] = stereoGains;
  split.connect(ll, 0); split.connect(rl, 1); split.connect(rr, 1); split.connect(lr, 0);
  ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); rr.connect(merge, 0, 1); lr.connect(merge, 0, 1);
  fade = ctx.createGain();
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.75;
  let node = src.connect(preamp);
  for (const f of filters) node = node.connect(f);
  node.connect(split);
  merge.connect(fade).connect(analyser).connect(ctx.destination);
  applyEq();
  return ctx;
}
function applyEq() {
  if (!ctx) return;
  const on = eqState.on;
  filters.forEach((f, i) => f.gain.setTargetAtTime(on ? eqState.gains[i] : 0, ctx.currentTime, 0.03));
  // при подъёме полос немного убавляем вход, чтобы не было хрипа
  const peak = on ? Math.max(0, ...eqState.gains) : 0;
  const db = on ? eqState.preamp - peak * 0.6 : 0;
  preamp.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 0.03);
  const w = (on ? eqState.stereo : 100) / 100;
  const [ll, rl, rr, lr] = stereoGains;
  ll.gain.value = rr.gain.value = (1 + w) / 2;
  rl.gain.value = lr.gain.value = (1 - w) / 2;
}
function saveEq() { LS.set("eq", eqState); applyEq(); }

/* ---------- состояние ---------- */
let tracks = [];          // все песни
let lists = [];           // плейлисты
let view = { tab: "all", list: null };
let queue = [];           // id по порядку
let cur = null;           // id текущей
let curUrl = null, coverUrl = null;
let shuffle = LS.get("shuffle", false);
let repeat = LS.get("repeat", "all"); // off | all | one
let speed = LS.get("speed", 1);
let sleep = null;         // { end: ms } | { endOfTrack: true }
let icq = LS.get("icq", true);
const history = [];

const byId = (id) => tracks.find((t) => t.id === id);
const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.round(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  t.classList.toggle("top", !$("sheet").hidden); // над открытым листом — показываем сверху
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
let icqAudio;
function icqSound() {
  if (!icq) return;
  try { icqAudio = icqAudio || new Audio("/static/sounds/notify.mp3"); icqAudio.volume = 0.6; icqAudio.currentTime = 0; icqAudio.play().catch(() => {}); } catch { /* нет звука */ }
}

/* ---------- добавление файлов ---------- */
async function addFiles(files) {
  files = [...files].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name));
  if (!files.length) { toast("Это не похоже на музыку — выберите mp3, m4a, ogg, flac или wav"); return; }
  try { await navigator.storage?.persist?.(); } catch { /* браузер может отказать */ }
  let n = 0, skipped = 0;
  const known = new Set(tracks.map((t) => t.name + "|" + t.size));
  for (const f of files) {
    if (known.has(f.name + "|" + f.size)) { skipped++; continue; }
    toast(`Добавляю ${n + 1} из ${files.length}: ${f.name}`, 60000);
    const tags = await readTags(f);
    const d = await duration(f);
    if (d === -1) { skipped++; continue; } // формат не поддерживается этим телефоном
    const guess = fromName(f.name);
    const t = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: f.name, size: f.size, type: f.type || "audio/mpeg",
      title: tags.title || guess.title || f.name, artist: tags.artist || guess.artist || "Неизвестный исполнитель",
      album: tags.album || "", duration: d, added: Date.now(), fav: false, plays: 0,
    };
    try {
      await put("blobs", f, t.id);
      if (tags.cover && tags.cover.size < 3e6) await put("blobs", tags.cover, t.id + ":cover");
      t.cover = !!tags.cover;
      await put("tracks", t);
    } catch (e) {
      toast(e && e.name === "QuotaExceededError" ? "На телефоне закончилось место для музыки" : "Не удалось сохранить " + f.name, 5000);
      break;
    }
    tracks.push(t); known.add(f.name + "|" + f.size); n++;
  }
  render();
  toast(n ? `Добавлено песен: ${n}${skipped ? ` · пропущено: ${skipped}` : ""}` : "Новых песен нет — эти уже в плеере");
  if (n) icqSound();
}

/* ---------- воспроизведение ---------- */
function viewIds() {
  let list = tracks;
  if (view.tab === "fav") list = tracks.filter((t) => t.fav);
  if (view.tab === "list" && view.list) {
    const l = lists.find((x) => x.id === view.list);
    list = l ? l.ids.map(byId).filter(Boolean) : [];
    return list.map((t) => t.id);
  }
  return [...list].sort((a, b) => b.added - a.added).map((t) => t.id);
}
async function play(id, fromQueue) {
  const t = byId(id);
  if (!t) return;
  graph(); // создаём звук сразу, пока действует нажатие пользователя
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  if (!fromQueue) queue = viewIds();
  if (cur && cur !== id) history.push(cur);
  cur = id;
  const blob = await get("blobs", id);
  if (!blob) { toast("Файл песни потерялся — удалите её и добавьте снова"); return; }
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = URL.createObjectURL(blob);
  audio.src = curUrl;
  audio.playbackRate = speed;
  graph();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  if (fade) fade.gain.value = 1;
  try { await audio.play(); } catch { /* ждём нажатия */ }
  t.plays = (t.plays || 0) + 1; put("tracks", t).catch(() => {});
  LS.set("last", id);
  await showNow(t);
  render();
}
async function showNow(t) {
  $("npTitle").textContent = t ? t.title : "Ничего не играет";
  $("npArtist").textContent = t ? t.artist + (t.album ? " — " + t.album : "") : "Добавьте песни с телефона";
  $("btnFav").textContent = t && t.fav ? "★" : "☆";
  $("btnFav").disabled = !t;
  $("tDur").textContent = fmt(t ? t.duration : 0);
  $("npBadge").textContent = t ? `${(t.name.split(".").pop() || "").toUpperCase()} · прослушано ${t.plays || 0}` : "";
  const c = $("cover");
  $("coverText").textContent = t ? (t.artist || t.title || "♪").trim().charAt(0).toUpperCase() : "♪";
  if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = null; }
  c.classList.remove("has-img");
  if (t && t.cover) {
    const b = await get("blobs", t.id + ":cover").catch(() => null);
    if (b) { coverUrl = URL.createObjectURL(b); $("coverImg").src = coverUrl; c.classList.add("has-img"); }
  }
  document.title = t ? `${t.title} — ${t.artist} · Ярко Плеер` : "Ярко Плеер";
  if ("mediaSession" in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || "Ярко Плеер",
      artwork: coverUrl ? [{ src: coverUrl, sizes: "512x512" }] : [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    });
  }
}
function nextId(auto) {
  if (!queue.length) queue = viewIds();
  if (!queue.length) return null;
  if (auto && repeat === "one") return cur;
  if (shuffle && queue.length > 1) {
    let n; do { n = queue[Math.floor(Math.random() * queue.length)]; } while (n === cur);
    return n;
  }
  const i = queue.indexOf(cur);
  if (i === -1) return queue[0];
  if (i + 1 < queue.length) return queue[i + 1];
  return auto && repeat === "off" ? null : queue[0];
}
function next(auto) {
  const id = nextId(auto);
  if (id == null) { audio.pause(); return; }
  if (auto && id === cur) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  play(id, true);
}
function prev() {
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  const h = history.pop();
  if (h && byId(h)) { cur = null; play(h, true); return; }
  const i = queue.indexOf(cur);
  if (i > 0) play(queue[i - 1], true);
  else audio.currentTime = 0;
}
function toggle() {
  if (!cur) {
    const ids = viewIds();
    const last = LS.get("last", null);
    if (ids.length) play(ids.includes(last) ? last : ids[0]);
    else $("file").click();
    return;
  }
  graph();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

audio.addEventListener("play", () => { $("btnPlay").textContent = "❚❚"; $("btnPlay").setAttribute("aria-label", "Пауза"); render(); });
audio.addEventListener("pause", () => { $("btnPlay").textContent = "▶"; $("btnPlay").setAttribute("aria-label", "Играть"); render(); });
audio.addEventListener("ended", () => {
  if (sleep && sleep.endOfTrack) { stopSleep(true); return; }
  next(true);
});
audio.addEventListener("error", () => { if (cur) { toast("Этот файл не воспроизводится на устройстве — переключаю дальше"); setTimeout(() => next(true), 900); } });
let seeking = false;
audio.addEventListener("timeupdate", () => {
  if (!seeking) $("seek").value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
  $("tCur").textContent = fmt(audio.currentTime);
  $("tDur").textContent = fmt(audio.duration || byId(cur)?.duration || 0);
  sleepTick();
  if ("mediaSession" in navigator && audio.duration && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate }); } catch { /* */ }
  }
});
$("seek").addEventListener("input", () => { seeking = true; $("tCur").textContent = fmt(($("seek").value / 1000) * (audio.duration || 0)); });
$("seek").addEventListener("change", () => { if (audio.duration) audio.currentTime = ($("seek").value / 1000) * audio.duration; seeking = false; });
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => toggle());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("previoustrack", prev);
  ms.setActionHandler("nexttrack", () => next(false));
  try { ms.setActionHandler("seekto", (e) => { audio.currentTime = e.seekTime; }); } catch { /* */ }
}

/* ---------- таймер сна ---------- */
function setSleep(min) {
  if (min === 0) { stopSleep(false); toast("Таймер сна выключен"); return; }
  sleep = min === "track" ? { endOfTrack: true } : { end: Date.now() + min * 60000 };
  toast(min === "track" ? "Музыка остановится после этой песни" : `Музыка плавно затихнет через ${min} мин`);
  sleepTick();
}
function stopSleep(fired) {
  sleep = null;
  if (fade && ctx) { fade.gain.cancelScheduledValues(ctx.currentTime); fade.gain.value = 1; }
  if (fired) { audio.pause(); toast("Спокойной ночи — таймер сна сработал", 5000); }
  sleepTick();
}
let fadeStarted = false;
function sleepTick() {
  const b = $("sleepBadge");
  $("btnSleep").classList.toggle("on", !!sleep);
  if (!sleep) { b.hidden = true; fadeStarted = false; return; }
  b.hidden = false;
  if (sleep.endOfTrack) { b.textContent = "☾ после песни"; return; }
  const left = sleep.end - Date.now();
  b.textContent = "☾ " + fmt(Math.max(0, left / 1000));
  if (left <= 30000 && !fadeStarted && fade && ctx) {
    fadeStarted = true;
    fade.gain.setValueAtTime(fade.gain.value, ctx.currentTime);
    fade.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + Math.max(1, left / 1000));
  }
  if (left <= 0) stopSleep(true);
}
setInterval(() => { if (sleep && !sleep.endOfTrack) sleepTick(); }, 1000);

/* ---------- спектр ---------- */
const cv = $("viz"), g = cv.getContext("2d");
let peaks = [];
function fit() { const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * devicePixelRatio); cv.height = Math.round(64 * devicePixelRatio); }
addEventListener("resize", fit); fit();
let fbuf;
function draw() {
  requestAnimationFrame(draw);
  const W = cv.width, H = cv.height, N = Math.max(16, Math.min(40, Math.floor(W / (14 * devicePixelRatio))));
  g.clearRect(0, 0, W, H);
  const bw = W / N;
  if (!fbuf && analyser) fbuf = new Uint8Array(analyser.frequencyBinCount);
  const playing = analyser && !audio.paused;
  if (playing) analyser.getByteFrequencyData(fbuf);
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, "#3f6f9e"); grad.addColorStop(0.6, "#6fb0e6"); grad.addColorStop(1, "#c8ecff");
  for (let i = 0; i < N; i++) {
    let v = 0;
    if (playing) {
      // логарифмическая шкала частот, как у настоящих анализаторов
      const lo = Math.floor(Math.pow(fbuf.length, i / N)), hi = Math.max(lo + 1, Math.floor(Math.pow(fbuf.length, (i + 1) / N)));
      for (let k = lo; k < hi && k < fbuf.length; k++) v = Math.max(v, fbuf[k]);
      v /= 255;
    }
    const h = Math.max(2 * devicePixelRatio, v * (H - 6 * devicePixelRatio));
    // «сегментные» столбики
    g.fillStyle = grad;
    const seg = 4 * devicePixelRatio;
    for (let y = H - seg; y > H - h - seg; y -= seg) g.fillRect(i * bw + 1.5 * devicePixelRatio, y, bw - 3 * devicePixelRatio, seg - devicePixelRatio);
    peaks[i] = Math.max((peaks[i] || 0) - 0.012, v);
    g.fillStyle = "#e8f6ff";
    g.fillRect(i * bw + 1.5 * devicePixelRatio, H - peaks[i] * (H - 6 * devicePixelRatio) - seg - devicePixelRatio, bw - 3 * devicePixelRatio, devicePixelRatio * 1.5);
  }
  if (!cur) {
    g.fillStyle = "rgba(200,230,255,.55)"; g.font = `${12 * devicePixelRatio}px Tahoma, sans-serif`; g.textAlign = "center";
    g.fillText("Здесь будет спектр музыки", W / 2, H / 2 + 4 * devicePixelRatio);
  }
}
requestAnimationFrame(draw);

/* ---------- интерфейс ---------- */
function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const ids = viewIds();
  const rows = ids.map(byId).filter((t) => !q || (t.title + " " + t.artist + " " + t.album).toLowerCase().includes(q));
  const head = $("listHead");
  if (view.tab === "list") {
    const l = lists.find((x) => x.id === view.list);
    head.innerHTML = `<span><button class="link" data-act="back">← Плейлисты</button> · <b>${esc(l?.name)}</b></span><span>${rows.length} ${plural(rows.length)}</span>`;
  } else {
    const total = rows.reduce((s, t) => s + Math.max(0, t.duration || 0), 0);
    head.innerHTML = `<span><b>${view.tab === "fav" ? "Избранное" : "Все песни"}</b> · ${rows.length} ${plural(rows.length)}${total ? " · " + hours(total) : ""}</span>` +
      (rows.length > 1 ? `<button class="link" data-act="shuffleall">⤮ Перемешать всё</button>` : "");
  }
  $("tracks").innerHTML = rows.map((t, i) => `
    <li class="tr${t.id === cur ? " cur" : ""}" data-id="${t.id}">
      <button class="tr-play" data-act="play" aria-label="${t.id === cur && !audio.paused ? "Пауза" : "Играть"}">${t.id === cur && !audio.paused ? "❚❚" : "▶"}</button>
      <div class="tr-main" data-act="play">
        <div class="tr-t"><b>${esc(t.artist)}</b> — ${esc(t.title)}</div>
        <div class="tr-sub">${t.fav ? '<span class="star">★</span> ' : ""}${esc(t.album || (t.name.split(".").pop() || "").toUpperCase())}${t.plays ? " · " + t.plays + " раз" : ""}</div>
      </div>
      <span class="tr-dur">${fmt(t.duration)}</span>
      <button class="tr-more" data-act="more" aria-label="Действия с песней">⋮</button>
    </li>`).join("");
  const e = $("empty");
  e.hidden = rows.length > 0;
  $("search").hidden = !tracks.length;
  if (!rows.length) {
    if (q) e.innerHTML = `<h3>Ничего не нашлось</h3><p>Попробуйте другое слово</p>`;
    else if (view.tab === "fav") e.innerHTML = `<div class="big">☆</div><h3>Пока пусто</h3><p>Нажмите звёздочку у песни — она появится здесь</p>`;
    else if (view.tab === "list") e.innerHTML = `<div class="big">≡</div><h3>Плейлист пуст</h3><p>Откройте «Все песни», нажмите ⋮ у песни и выберите «В плейлист»</p>`;
    else e.innerHTML = `<div class="big">♫</div><h3>Ваша музыка — всегда с вами</h3><p>Выберите песни на телефоне. Они сохранятся в плеере и будут играть без интернета.</p><p><button class="btn" data-act="add">＋ Добавить музыку</button></p><p style="font-size:12px">Файлы никуда не загружаются и остаются только на этом устройстве.</p>`;
  }
}
const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? "песня" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "песни" : "песен");
const hours = (s) => (s >= 3600 ? Math.floor(s / 3600) + " ч " : "") + Math.round((s % 3600) / 60) + " мин";
function renderLists() {
  $("lists").innerHTML = lists.length ? lists.map((l) => `
    <li data-list="${l.id}"><span class="ico">≡</span><span class="nm">${esc(l.name)}<span class="ct">${l.ids.length} ${plural(l.ids.length)}</span></span>
    <button class="tr-more" data-act="listmore" aria-label="Действия с плейлистом">⋮</button></li>`).join("")
    : `<li style="cursor:default;color:var(--muted)">Плейлистов пока нет. Создайте первый — например, «В дорогу» или «Для спорта».</li>`;
}
function render() {
  const tab = view.tab === "list" ? "lists" : view.tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("viewList").hidden = !(view.tab === "all" || view.tab === "fav" || view.tab === "list");
  $("viewLists").hidden = view.tab !== "lists";
  $("viewEq").hidden = view.tab !== "eq";
  if (!$("viewList").hidden) renderList();
  if (!$("viewLists").hidden) renderLists();
  $("btnShuffle").classList.toggle("on", shuffle);
  $("btnRepeat").classList.toggle("on", repeat !== "off");
  $("btnRepeat").innerHTML = repeat === "one" ? '↻<span class="one">1</span>' : "↻";
  $("btnRepeat").title = { off: "Повтор выключен", all: "Повторять всё", one: "Повторять одну" }[repeat];
  $("btnSpeed").textContent = speed + "×";
  const t = byId(cur);
  $("btnFav").textContent = t && t.fav ? "★" : "☆";
}

/* нижний лист */
function sheet(html, onClick) {
  const s = $("sheet");
  s.innerHTML = html; s.hidden = false; $("sheetBg").hidden = false;
  s.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) onClick(b.dataset.v, b); };
  const f = s.querySelector("input[type=text]"); if (f) setTimeout(() => f.focus(), 50);
}
function closeSheet() { $("sheet").hidden = true; $("sheetBg").hidden = true; $("sheet").innerHTML = ""; }
$("sheetBg").onclick = closeSheet;
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
  if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); toggle(); }
});
function ask(title, value, okText, cb) {
  sheet(`<h4>${esc(title)}</h4><div class="body"><input type="text" id="askIn" maxlength="60" value="${esc(value)}">
    <div class="acts"><button class="btn gray" data-v="cancel">Отмена</button><button class="btn" data-v="ok">${esc(okText)}</button></div></div>`, (v) => {
    const val = $("askIn")?.value.trim();
    closeSheet();
    if (v === "ok" && val) cb(val);
  });
  $("askIn").addEventListener("keydown", (e) => { if (e.key === "Enter") $("sheet").querySelector('[data-v="ok"]').click(); });
}
async function newList(cb) {
  ask("Новый плейлист", "", "Создать", async (name) => {
    const l = { id: "l" + Date.now().toString(36), name, ids: [], created: Date.now() };
    lists.push(l); await put("lists", l);
    toast(`Плейлист «${name}» создан`);
    if (cb) cb(l); else render();
  });
}
async function toggleFav(t) {
  t.fav = !t.fav; await put("tracks", t);
  toast(t.fav ? "Добавлено в избранное" : "Убрано из избранного", 1500);
  render();
}
function trackMenu(t) {
  const inList = view.tab === "list" && view.list;
  sheet(`<h4>${esc(t.artist)} — ${esc(t.title)}</h4>
    <button class="row" data-v="play">▶ Играть</button>
    <button class="row" data-v="next">⤵ Играть следующей</button>
    <button class="row" data-v="fav">${t.fav ? "★ Убрать из избранного" : "☆ В избранное"}</button>
    <button class="row" data-v="tolist">≡ В плейлист</button>
    <button class="row" data-v="rename">✎ Изменить название</button>
    ${inList ? '<button class="row" data-v="unlist">− Убрать из плейлиста</button>' : ""}
    <button class="row danger" data-v="del">✕ Удалить из плеера<span class="r">${(t.size / 1048576).toFixed(1)} МБ</span></button>`, async (v) => {
    if (v === "play") { closeSheet(); play(t.id); }
    if (v === "next") {
      closeSheet();
      if (!cur) { play(t.id); return; }
      queue = queue.filter((x) => x !== t.id); queue.splice(queue.indexOf(cur) + 1, 0, t.id);
      toast("Сыграет следующей");
    }
    if (v === "fav") { closeSheet(); toggleFav(t); }
    if (v === "rename") ask("Название песни", t.title, "Сохранить", async (title) => { t.title = title; await put("tracks", t); if (t.id === cur) showNow(t); render(); });
    if (v === "tolist") pickList(t);
    if (v === "unlist") {
      const l = lists.find((x) => x.id === view.list);
      l.ids = l.ids.filter((x) => x !== t.id); await put("lists", l); closeSheet(); render();
    }
    if (v === "del") {
      sheet(`<h4>Удалить песню?</h4><div class="body"><div>«${esc(t.title)}» исчезнет из плеера. Файл в памяти телефона (в «Загрузках» или «Музыке») останется.</div>
        <div class="acts"><button class="btn gray" data-v="no">Отмена</button><button class="btn danger" data-v="yes">Удалить</button></div></div>`, async (a) => {
        closeSheet();
        if (a !== "yes") return;
        await removeTrack(t);
        toast("Песня удалена из плеера");
      });
    }
  });
}
async function removeTrack(t) {
  if (t.id === cur) { audio.pause(); audio.removeAttribute("src"); cur = null; showNow(null); }
  await del("blobs", t.id); await del("blobs", t.id + ":cover"); await del("tracks", t.id);
  tracks = tracks.filter((x) => x !== t);
  for (const l of lists) if (l.ids.includes(t.id)) { l.ids = l.ids.filter((x) => x !== t.id); await put("lists", l); }
  queue = queue.filter((x) => x !== t.id);
  render();
}
function pickList(t) {
  sheet(`<h4>Добавить в плейлист</h4>
    ${lists.map((l) => `<button class="row" data-v="${l.id}">≡ ${esc(l.name)}<span class="r">${l.ids.includes(t.id) ? "уже есть" : l.ids.length}</span></button>`).join("")}
    <button class="row" data-v="new">＋ Новый плейлист</button>`, async (v) => {
    const add = async (l) => {
      if (!l.ids.includes(t.id)) { l.ids.push(t.id); await put("lists", l); }
      toast(`Добавлено в «${l.name}»`); render();
    };
    if (v === "new") { closeSheet(); newList(add); return; }
    closeSheet(); add(lists.find((l) => l.id === v));
  });
}
function listMenu(l) {
  sheet(`<h4>${esc(l.name)}</h4>
    <button class="row" data-v="play">▶ Слушать</button>
    <button class="row" data-v="rename">✎ Переименовать</button>
    <button class="row danger" data-v="del">✕ Удалить плейлист</button>`, async (v) => {
    closeSheet();
    if (v === "play") { view = { tab: "list", list: l.id }; render(); const ids = viewIds(); if (ids.length) play(ids[0]); }
    if (v === "rename") ask("Название плейлиста", l.name, "Сохранить", async (name) => { l.name = name; await put("lists", l); render(); });
    if (v === "del") { lists = lists.filter((x) => x !== l); await del("lists", l.id); toast("Плейлист удалён, песни остались"); render(); }
  });
}
async function settingsMenu() {
  let used = "";
  try { const e = await navigator.storage.estimate(); used = `${(e.usage / 1048576).toFixed(0)} МБ из ~${(e.quota / 1073741824).toFixed(1)} ГБ`; } catch { /* */ }
  const theme = LS.get("theme", "auto");
  sheet(`<h4>Настройки</h4>
    <button class="row" data-v="add">＋ Добавить музыку<span class="r">mp3, m4a, ogg, flac, wav</span></button>
    <button class="row" data-v="icq">${icq ? "🔔" : "🔕"} Звук «ICQ» при добавлении<span class="r">${icq ? "вкл" : "выкл"}</span></button>
    <button class="row" data-v="theme">◐ Тема оформления<span class="r">${{ auto: "как в системе", light: "светлая", dark: "тёмная" }[theme]}</span></button>
    <button class="row" data-v="none">▤ Занято памяти<span class="r">${used || "—"}</span></button>
    <button class="row danger" data-v="wipe">✕ Удалить всю музыку из плеера</button>
    <div class="body" style="font-size:12px;color:var(--muted)">Ярко Плеер — часть <a href="/">Ярко</a>. Песни хранятся только на вашем устройстве и никуда не отправляются. Работает без интернета.</div>`, async (v) => {
    if (v === "add") { closeSheet(); $("file").click(); }
    if (v === "icq") { icq = !icq; LS.set("icq", icq); if (icq) icqSound(); settingsMenu(); }
    if (v === "theme") { const n = { auto: "light", light: "dark", dark: "auto" }[theme]; LS.set("theme", n); applyTheme(); settingsMenu(); }
    if (v === "wipe") {
      sheet(`<h4>Удалить всю музыку?</h4><div class="body"><div>Из плеера исчезнут все ${tracks.length} ${plural(tracks.length)} и плейлисты. Исходные файлы на телефоне не пострадают.</div>
        <div class="acts"><button class="btn gray" data-v="no">Отмена</button><button class="btn danger" data-v="yes">Удалить всё</button></div></div>`, async (a) => {
        closeSheet();
        if (a !== "yes") return;
        for (const t of [...tracks]) await removeTrack(t);
        for (const l of lists) await del("lists", l.id);
        lists = []; render(); toast("Плеер очищен");
      });
    }
  });
}
function applyTheme() {
  const t = LS.get("theme", "auto");
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#2b3f55" : "#4a6d93";
}

/* эквалайзер */
function buildEq() {
  $("eqPreset").innerHTML = Object.keys(PRESETS).map((p) => `<option>${esc(p)}</option>`).join("") + `<option value="__own">Свой</option>`;
  $("eq").innerHTML = BANDS.map((f, i) => `<div class="band"><output id="bo${i}">0</output>
    <input type="range" min="-12" max="12" step="1" data-band="${i}" aria-label="${f} Гц"><span>${f >= 1000 ? f / 1000 + "к" : f}</span></div>`).join("");
  syncEq();
  $("eq").addEventListener("input", (e) => {
    const i = e.target.dataset.band; if (i == null) return;
    eqState.gains[i] = +e.target.value; eqState.preset = "__own";
    if (!eqState.on) eqState.on = true;
    syncEq(); saveEq();
  });
  $("eqPreset").onchange = () => {
    const p = $("eqPreset").value;
    if (PRESETS[p]) eqState.gains = [...PRESETS[p]];
    eqState.preset = p; eqState.on = true; syncEq(); saveEq();
  };
  $("eqOn").onchange = () => { eqState.on = $("eqOn").checked; syncEq(); saveEq(); };
  $("preamp").oninput = () => { eqState.preamp = +$("preamp").value; syncEq(); saveEq(); };
  $("stereo").oninput = () => { eqState.stereo = +$("stereo").value; syncEq(); saveEq(); };
}
function syncEq() {
  $("eqOn").checked = eqState.on;
  $("eq").classList.toggle("off", !eqState.on);
  $("eqPreset").value = PRESETS[eqState.preset] ? eqState.preset : "__own";
  eqState.gains.forEach((v, i) => {
    const el = $("eq").querySelector(`[data-band="${i}"]`); if (el) el.value = v;
    $("bo" + i).textContent = (v > 0 ? "+" : "") + v;
  });
  $("preamp").value = eqState.preamp; $("preampOut").textContent = (eqState.preamp > 0 ? "+" : "") + eqState.preamp + " дБ";
  $("stereo").value = eqState.stereo; $("stereoOut").textContent = eqState.stereo + "%";
}

/* события */
document.querySelector(".tabs").onclick = (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  view = { tab: b.dataset.tab, list: null }; $("search").value = ""; render();
};
$("pane").addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  const li = e.target.closest(".tr");
  const ll = e.target.closest("[data-list]");
  if (a?.dataset.act === "add") { $("file").click(); return; }
  if (a?.dataset.act === "back") { view = { tab: "lists", list: null }; render(); return; }
  if (a?.dataset.act === "shuffleall") { shuffle = true; LS.set("shuffle", true); queue = viewIds(); play(queue[Math.floor(Math.random() * queue.length)], true); return; }
  if (ll && a?.dataset.act === "listmore") { listMenu(lists.find((l) => l.id === ll.dataset.list)); return; }
  if (ll) { view = { tab: "list", list: ll.dataset.list }; render(); return; }
  if (!li) return;
  const t = byId(li.dataset.id);
  if (a?.dataset.act === "more") { trackMenu(t); return; }
  if (a?.dataset.act === "play") { if (t.id === cur) toggle(); else play(t.id); }
});
$("search").oninput = renderList;
$("btnNewList").onclick = () => newList();
$("btnAdd").onclick = () => $("file").click();
$("btnMenu").onclick = settingsMenu;
$("file").onchange = () => { const f = $("file").files; if (f.length) addFiles(f); $("file").value = ""; };
$("btnPlay").onclick = toggle;
$("btnNext").onclick = () => next(false);
$("btnPrev").onclick = prev;
$("btnShuffle").onclick = () => { shuffle = !shuffle; LS.set("shuffle", shuffle); toast(shuffle ? "Перемешивание включено" : "По порядку", 1400); render(); };
$("btnRepeat").onclick = () => { repeat = { off: "all", all: "one", one: "off" }[repeat]; LS.set("repeat", repeat); toast({ off: "Повтор выключен", all: "Повторять весь список", one: "Повторять одну песню" }[repeat], 1400); render(); };
$("btnFav").onclick = () => { const t = byId(cur); if (t) toggleFav(t); };
$("btnSpeed").onclick = () => { const s = [1, 1.25, 1.5, 2, 0.75]; speed = s[(s.indexOf(speed) + 1) % s.length]; audio.playbackRate = speed; LS.set("speed", speed); render(); };
$("btnSleep").onclick = () => {
  const left = sleep && !sleep.endOfTrack ? Math.ceil((sleep.end - Date.now()) / 60000) : null;
  sheet(`<h4>Таймер сна${left ? ` · осталось ${left} мин` : ""}</h4>
    ${[15, 30, 45, 60, 90].map((m) => `<button class="row" data-v="${m}">☾ Через ${m} минут</button>`).join("")}
    <button class="row" data-v="track">☾ После этой песни</button>
    ${sleep ? '<button class="row danger" data-v="0">Выключить таймер</button>' : ""}`, (v) => { closeSheet(); setSleep(v === "track" ? "track" : +v); });
};
const vol = LS.get("vol", 90);
$("vol").value = vol; audio.volume = vol / 100;
$("vol").oninput = () => { audio.volume = $("vol").value / 100; LS.set("vol", +$("vol").value); };
$("yarkoLink").textContent = "ярко.space";

// перетаскивание файлов на компьютере
addEventListener("dragover", (e) => { e.preventDefault(); $("app").classList.add("drop"); });
addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("app").classList.remove("drop"); });
addEventListener("drop", (e) => { e.preventDefault(); $("app").classList.remove("drop"); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
// «Поделиться» → Ярко Плеер (Android, если установлен как приложение)
document.addEventListener("visibilitychange", () => { if (!document.hidden) fit(); });

/* запуск */
(async function init() {
  applyTheme();
  buildEq();
  try {
    tracks = await all("tracks");
    lists = (await all("lists")).sort((a, b) => a.created - b.created);
  } catch {
    toast("Браузер не дал сохранить музыку (приватный режим?) — песни будут только до закрытия вкладки", 6000);
  }
  render();
  const last = byId(LS.get("last", null));
  if (last) { cur = last.id; queue = viewIds(); await showNow(last); const b = await get("blobs", last.id).catch(() => null); if (b) { curUrl = URL.createObjectURL(b); audio.src = curUrl; } render(); }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
