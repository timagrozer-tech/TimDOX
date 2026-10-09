// Звонки Yarko: голос и видео один на один и в группе до 4 человек (WebRTC, P2P-сетка).
// Сигналинг — через поток событий и короткие POST. «Идеальные переговоры» (perfect negotiation) разруливают
// одновременные предложения; демонстрация экрана, реакции, запись, шумо- и эхоподавление, подстройка под слабую сеть.
import { api, state, on } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { toast, toastError } from "../ui.js";

let cur = null;        // активный звонок
let incomingUi = null; // окно входящего звонка
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" };
const REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "🎉"];

// ---------------------------------------------------------------- звуки
let actx = null;
function tone(freqs, dur = 0.35, gap = 0.05, vol = 0.07) {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  } catch { /* без звука */ }
}
let ringTimer = 0;
function ring(kind) {
  stopRing();
  const play = () => {
    if (kind === "in") { tone([880, 660, 880, 660], 0.18, 0.04); try { navigator.vibrate?.([300, 200, 300]); } catch { /* нет */ } }
    else tone([440, 480], 0.9, 0, 0.04);
  };
  play();
  ringTimer = setInterval(play, kind === "in" ? 2600 : 3200);
}
function stopRing() { clearInterval(ringTimer); ringTimer = 0; try { navigator.vibrate?.(0); } catch { /* нет */ } }

// ---------------------------------------------------------------- медиа
async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: video ? VIDEO : false });
  } catch (e) {
    if (video) { // нет камеры или доступ запрещён — звоним хотя бы голосом
      toast("Камера недоступна — звонок будет голосовым", { icon: "alert" });
      return navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false });
    }
    throw new Error(e.name === "NotAllowedError" ? "Разрешите доступ к микрофону в настройках браузера" : "Микрофон недоступен");
  }
}

const sig = (to, type, data) => api.post(`/api/calls/${cur.id}/signal`, { to, type, data }).catch(() => {});

// ---------------------------------------------------------------- участники (P2P)
function addPeer(uid, card) {
  if (!cur || cur.peers.has(uid)) return cur?.peers.get(uid);
  const pc = new RTCPeerConnection({ iceServers: cur.ice, bundlePolicy: "max-bundle", iceCandidatePoolSize: 2 });
  const peer = { uid, card: card || { id: uid, name: "Участник" }, pc, polite: state.me.id < uid, makingOffer: false, ignoreOffer: false,
    stream: new MediaStream(), iceQueue: [], iceTimer: 0, state: { mic: true, cam: true } };
  cur.peers.set(uid, peer);
  for (const t of cur.local.getTracks()) pc.addTrack(t, cur.local);
  if (!cur.local.getVideoTracks().length) pc.addTransceiver("video", { direction: "recvonly" }); // чтобы собеседник мог включить камеру
  pc.ontrack = (e) => {
    if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
    e.track.onunmute = () => paintTiles();
    paintTiles();
  };
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    peer.iceQueue.push(candidate.toJSON());
    clearTimeout(peer.iceTimer);
    peer.iceTimer = setTimeout(() => { const c = peer.iceQueue.splice(0); if (c.length) sig(uid, "ice", c); }, 80);
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sig(uid, "offer", pc.localDescription.toJSON());
    } catch (e) { console.warn(e); } finally { peer.makingOffer = false; }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      peer.fails = (peer.fails || 0) + 1;
      if (peer.fails === 1) {
        // свежие логины ретрансляторов и повторный поиск пути (ICE restart)
        api.get("/api/calls/ice").then((d) => { try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: d.ice_servers }); } catch { /* старые браузеры */ } })
          .catch(() => {}).finally(() => pc.restartIce?.());
      }
      else setStatus("Не удаётся соединиться: сеть не пропускает звонок. Попробуйте Wi‑Fi или «Настройки» → «Проверка звонков»");
    }
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      if (!cur.connectedAt) { cur.connectedAt = Date.now(); stopRing(); }
      setStatus("");
    }
    if (pc.iceConnectionState === "disconnected") setStatus("Соединение прерывается…");
    paintTiles();
  };
  paintTiles();
  return peer;
}

async function onSignal({ call_id: cid, from, type, data }) {
  if (!cur || cid !== cur.id) return;
  const peer = cur.peers.get(from) || addPeer(from, cur.cards.get(from));
  const pc = peer.pc;
  try {
    if (type === "offer" || type === "answer") {
      const collision = type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data);
      if (type === "offer") { await pc.setLocalDescription(); sig(from, "answer", pc.localDescription.toJSON()); }
    } else if (type === "ice") {
      for (const c of data || []) { try { await pc.addIceCandidate(c); } catch (e) { if (!peer.ignoreOffer) console.warn(e); } }
    } else if (type === "state") {
      peer.state = { ...peer.state, ...data }; paintTiles();
    } else if (type === "reaction") {
      floatReaction(from, data?.emoji);
    } else if (type === "recording") {
      cur.remoteRecording = !!data?.on; paintHeader();
      if (data?.on) toast(`${peer.card.name.split(" ")[0]} записывает звонок`, { icon: "alert" });
    }
  } catch (e) { console.warn("signal", e); }
}

function removePeer(uid) {
  const p = cur?.peers.get(uid);
  if (!p) return;
  p.pc.close();
  cur.peers.delete(uid);
  paintTiles();
}

// ---------------------------------------------------------------- начало, приём, завершение
export async function startCall(conversationId, video = false) {
  if (cur) return expand();
  let local;
  try { local = await getMedia(video); } catch (e) { return toastError(e); }
  try {
    const r = await api.post("/api/calls", { conversation_id: conversationId, video });
    await enter(r.call, r.ice_servers, local, r.existing);
    if (!r.existing) { ring("out"); setStatus("Вызов…"); cur.ringTimeout = setTimeout(() => { if (cur && !cur.connectedAt) { toast("Нет ответа"); hangup(); } }, 45000); }
  } catch (e) { local.getTracks().forEach((t) => t.stop()); toastError(e); }
}

async function enter(call, ice, local, joinExisting = true) {
  cur = { id: call.id, conv: call.conversation_id, video: call.video, ice, local, peers: new Map(), cards: new Map(),
    startedAt: Date.now(), connectedAt: 0, muted: false, camOff: !local.getVideoTracks().length, screen: null, recorder: null, minimized: false };
  for (const p of call.participants || []) cur.cards.set(p.id, p);
  if (call.caller) cur.cards.set(call.caller.id, call.caller);
  buildUi();
  if (joinExisting) {
    const j = await api.post(`/api/calls/${call.id}/join`);
    for (const p of j.call.participants) cur.cards.set(p.id, p);
    for (const uid of j.peers) addPeer(uid, cur.cards.get(uid));
  }
  watchQuality();
}

function incoming(call) {
  if (cur || incomingUi) { api.post(`/api/calls/${call.id}/decline`).catch(() => {}); return; } // уже в звонке — «занято»
  ring("in");
  const accept = async (video) => {
    closeIncoming();
    let local;
    try { local = await getMedia(video); } catch (e) { api.post(`/api/calls/${call.id}/decline`).catch(() => {}); return toastError(e); }
    try { await enter(call, (await api.post(`/api/calls/${call.id}/join`)).ice_servers, local, true); setStatus("Соединяем…"); }
    catch (e) { local.getTracks().forEach((t) => t.stop()); toastError(e); cleanup(); }
  };
  const decline = () => { closeIncoming(); api.post(`/api/calls/${call.id}/decline`).catch(() => {}); };
  incomingUi = h("div.call-incoming", { role: "alertdialog", "aria-label": `Входящий звонок от ${call.caller?.name}` },
    h("div.ci-card",
      h("div.ci-av", h("i"), h("i"), avatar(call.caller, "xl", { presence: false })),
      h("b", call.caller?.name || "Звонок"),
      h("small", call.video ? "Входящий видеозвонок" : "Входящий звонок"),
      h("div.ci-actions",
        h("button.call-btn.red", { type: "button", "aria-label": "Отклонить", onclick: decline }, icon("phoneOff")),
        h("button.call-btn.green", { type: "button", "aria-label": "Ответить голосом", onclick: () => accept(false) }, icon("phone")),
        call.video ? h("button.call-btn.green", { type: "button", "aria-label": "Ответить с видео", onclick: () => accept(true) }, icon("video")) : null)));
  document.body.append(incomingUi);
  incomingUi._timeout = setTimeout(() => { if (incomingUi) { closeIncoming(); toast(`Пропущенный звонок от ${call.caller?.name || "друга"}`, { icon: "phone" }); } }, 45000);
  incomingUi._id = call.id;
}
function closeIncoming() {
  stopRing();
  if (!incomingUi) return;
  clearTimeout(incomingUi._timeout);
  incomingUi.remove();
  incomingUi = null;
}

export async function hangup() {
  if (!cur) return;
  const id = cur.id;
  cleanup();
  await api.post(`/api/calls/${id}/leave`).catch(() => {});
}

function cleanup(message) {
  stopRing();
  if (!cur) return;
  clearTimeout(cur.ringTimeout);
  clearInterval(cur.timer); clearInterval(cur.qualityTimer); clearInterval(cur.levelTimer);
  try { cur.recorder?.stop(); } catch { /* уже остановлена */ }
  for (const p of cur.peers.values()) p.pc.close();
  cur.local.getTracks().forEach((t) => t.stop());
  cur.screen?.getTracks().forEach((t) => t.stop());
  cur.ui?.remove();
  cur.pill?.remove();
  document.body.classList.remove("in-call");
  const talked = cur.connectedAt ? fmt((Date.now() - cur.connectedAt) / 1000) : null;
  cur = null;
  if (message) toast(message, { icon: "phone" });
  else if (talked) toast(`Звонок завершён · ${talked}`, { icon: "phone" });
}

// ---------------------------------------------------------------- управление
function setMic(on) {
  cur.muted = !on;
  cur.local.getAudioTracks().forEach((t) => { t.enabled = on; });
  sig(null, "state", { mic: on });
  paintControls(); paintTiles();
}
async function setCam(on) {
  let track = cur.local.getVideoTracks()[0];
  if (on && !track) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
      track = s.getVideoTracks()[0];
      cur.local.addTrack(track);
      for (const p of cur.peers.values()) {
        const tr = p.pc.getTransceivers().find((t) => t.receiver.track.kind === "video" && !t.sender.track);
        if (tr) { tr.direction = "sendrecv"; await tr.sender.replaceTrack(track); } else p.pc.addTrack(track, cur.local);
      }
    } catch { return toast("Камера недоступна", { error: true }); }
  }
  if (track) track.enabled = on;
  cur.camOff = !on;
  sig(null, "state", { cam: on });
  paintControls(); paintTiles();
}
async function flipCamera() {
  const track = cur.local.getVideoTracks()[0];
  if (!track) return;
  const facing = track.getSettings().facingMode === "environment" ? "user" : "environment";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: facing } });
    const nt = s.getVideoTracks()[0];
    for (const p of cur.peers.values()) { const sn = p.pc.getSenders().find((x) => x.track === track); await sn?.replaceTrack(nt); }
    cur.local.removeTrack(track); track.stop(); cur.local.addTrack(nt);
    paintTiles();
  } catch { toast("Не удалось переключить камеру", { error: true }); }
}
async function toggleScreen() {
  if (cur.screen) return stopScreen();
  try {
    cur.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch { return; }
  const st = cur.screen.getVideoTracks()[0];
  st.contentHint = "detail";
  st.onended = () => stopScreen();
  for (const p of cur.peers.values()) {
    const sn = p.pc.getSenders().find((x) => x.track?.kind === "video") ||
      p.pc.getTransceivers().find((t) => t.receiver.track.kind === "video")?.sender;
    if (sn) {
      const tr = p.pc.getTransceivers().find((t) => t.sender === sn);
      if (tr && tr.direction === "recvonly") tr.direction = "sendrecv";
      await sn.replaceTrack(st);
    } else p.pc.addTrack(st, cur.screen);
  }
  sig(null, "state", { screen: true });
  paintControls(); paintTiles();
}
async function stopScreen() {
  if (!cur?.screen) return;
  const cam = cur.local.getVideoTracks()[0] || null;
  for (const p of cur.peers.values()) {
    const sn = p.pc.getSenders().find((x) => x.track === cur.screen.getVideoTracks()[0]);
    await sn?.replaceTrack(cam);
  }
  cur.screen.getTracks().forEach((t) => t.stop());
  cur.screen = null;
  sig(null, "state", { screen: false });
  paintControls(); paintTiles();
}
function react(emoji) {
  sig(null, "reaction", { emoji });
  floatReaction(state.me.id, emoji);
}
async function toggleBlur() {
  const t = cur.local.getVideoTracks()[0];
  if (!t) return;
  const on = !t.getSettings().backgroundBlur;
  try { await t.applyConstraints({ backgroundBlur: on }); toast(on ? "Фон размыт" : "Размытие фона выключено", { icon: "check" }); }
  catch { toast("Размытие фона не поддерживается на этом устройстве", { error: true }); }
}

// запись: все видео плитки на один холст + смешанный звук → webm-файл у записывающего
function toggleRecord() {
  if (cur.recorder) { cur.recorder.stop(); return; }
  if (!window.MediaRecorder) return toast("Запись не поддерживается этим браузером", { error: true });
  const canvas = h("canvas", { width: 1280, height: 720 });
  const ctx = canvas.getContext("2d");
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();
  const streams = [cur.local, ...[...cur.peers.values()].map((p) => p.stream)];
  for (const s of streams) if (s.getAudioTracks().length) ac.createMediaStreamSource(s).connect(dest);
  const draw = () => {
    if (!cur?.recorder) return;
    const vids = [...cur.ui.querySelectorAll(".call-tile video")].filter((v) => v.videoWidth);
    ctx.fillStyle = "#0b0b14"; ctx.fillRect(0, 0, 1280, 720);
    const n = Math.max(1, vids.length), cols = n > 1 ? 2 : 1, rows = Math.ceil(n / cols);
    vids.forEach((v, i) => {
      const w = 1280 / cols, hh = 720 / rows, x = (i % cols) * w, y = Math.floor(i / cols) * hh;
      const k = Math.min(w / v.videoWidth, hh / v.videoHeight);
      ctx.drawImage(v, x + (w - v.videoWidth * k) / 2, y + (hh - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
    });
    requestAnimationFrame(draw);
  };
  const out = new MediaStream([...canvas.captureStream(24).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `krug-call-${new Date().toISOString().slice(0, 16).replace(":", "-")}.webm` });
    document.body.append(a); a.click(); a.remove();
    ac.close();
    if (cur) { cur.recorder = null; sig(null, "recording", { on: false }); paintControls(); paintHeader(); }
    toast("Запись сохранена на устройство", { icon: "download" });
  };
  cur.recorder = rec;
  rec.start(1000);
  draw();
  sig(null, "recording", { on: true });
  paintControls(); paintHeader();
}

// ---------------------------------------------------------------- качество сети: при потерях снижаем битрейт
function watchQuality() {
  cur.qualityTimer = setInterval(async () => {
    if (!cur) return;
    let bad = false;
    for (const p of cur.peers.values()) {
      try {
        const stats = await p.pc.getStats();
        stats.forEach((r) => {
          if (r.type === "remote-inbound-rtp" && ((r.fractionLost || 0) > 0.06 || (r.roundTripTime || 0) > 0.45)) bad = true;
        });
        for (const sn of p.pc.getSenders()) {
          if (sn.track?.kind !== "video") continue;
          const prm = sn.getParameters();
          if (!prm.encodings?.length) continue;
          const want = bad ? 300_000 : cur.peers.size > 1 ? 600_000 : 1_500_000;
          if (prm.encodings[0].maxBitrate !== want) {
            prm.encodings[0].maxBitrate = want;
            prm.encodings[0].scaleResolutionDownBy = bad ? 2 : 1;
            sn.setParameters(prm).catch(() => {});
          }
        }
      } catch { /* соединение ещё не готово */ }
    }
    cur.ui?.classList.toggle("weak", bad);
  }, 3000);
}

// ---------------------------------------------------------------- интерфейс
const ctrl = (cls, ic, label, onClick, on) => h(`button.call-btn${cls ? "." + cls : ""}${on ? ".on" : ""}`, { type: "button", "aria-label": label, title: label, onclick: onClick }, icon(ic));

function buildUi() {
  document.body.classList.add("in-call");
  cur.ui = h("div.call", { role: "dialog", "aria-label": "Звонок" },
    h("div.call-head"), h("div.call-grid"), h("div.call-react"), h("div.call-controls"));
  document.body.append(cur.ui);
  cur.timer = setInterval(paintHeader, 1000);
  // кто говорит — подсвечиваем плитку
  cur.levelTimer = setInterval(updateLevels, 160);
  paintHeader(); paintTiles(); paintControls();
}

function setStatus(text) { if (cur) { cur.status = text; paintHeader(); } }

function names() {
  const ps = [...cur.peers.values()].map((p) => p.card.name.split(" ")[0]);
  if (ps.length) return ps.join(", ");
  return [...cur.cards.values()].filter((c) => c.id !== state.me.id).map((c) => c.name.split(" ")[0]).join(", ") || "Звонок";
}

function paintHeader() {
  if (!cur?.ui) return;
  const t = cur.connectedAt ? fmt((Date.now() - cur.connectedAt) / 1000) : "";
  const head = cur.ui.querySelector(".call-head");
  head.replaceChildren(
    h("button.call-min", { type: "button", "aria-label": "Свернуть звонок", onclick: minimize }, icon("down")),
    h("div.call-title", h("b", names()), h("small", cur.status || t || "Соединяем…")),
    cur.recorder || cur.remoteRecording ? h("span.call-rec", h("i"), "Запись") : h("span"));
  if (cur.pill) cur.pill.querySelector("small").textContent = cur.status || t;
}

function tile(stream, card, { me = false, peer = null } = {}) {
  const hasVideo = stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled && !t.muted) && !(me && cur.camOff && !cur.screen) && !(peer && peer.state.cam === false && !peer.state.screen);
  const v = h("video", { autoplay: true, playsinline: true, muted: me });
  v.srcObject = stream;
  if (me) v.muted = true;
  const el = h(`div.call-tile${me ? ".me" : ""}${hasVideo ? "" : ".novideo"}${me && !cur.screen ? ".mirror" : ""}`, { dataset: { uid: String(card.id) } },
    v, h("div.call-tile-av", avatar(card, "xl", { presence: false })),
    h("span.call-tile-name", me ? "Вы" : card.name.split(" ")[0],
      (me ? cur.muted : peer?.state.mic === false) ? icon("micOff", "sm") : null));
  if (!me && peer && !["connected", "completed"].includes(peer.pc.iceConnectionState)) el.append(h("span.call-tile-wait", "соединяем…"));
  return el;
}

function paintTiles() {
  if (!cur?.ui) return;
  const grid = cur.ui.querySelector(".call-grid");
  const peers = [...cur.peers.values()];
  const tiles = peers.map((p) => tile(p.stream, p.card, { peer: p }));
  if (!peers.length) {
    const other = [...cur.cards.values()].find((c) => c.id !== state.me.id);
    if (other) tiles.push(h("div.call-tile.novideo.calling", h("div.call-tile-av.pulse", h("i"), h("i"), avatar(other, "xl", { presence: false })), h("span.call-tile-name", other.name.split(" ")[0])));
  }
  const local = cur.screen ? new MediaStream([...cur.screen.getVideoTracks(), ...cur.local.getAudioTracks()]) : cur.local;
  const mine = tile(local, state.me, { me: true });
  grid.dataset.n = String(tiles.length);
  grid.replaceChildren(...tiles, mine);
  dragPip(mine);
}

function paintControls() {
  if (!cur?.ui) return;
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia && matchMedia("(pointer: fine)").matches;
  const vt = cur.local.getVideoTracks()[0];
  const canBlur = !!vt?.getCapabilities?.().backgroundBlur;
  const reacts = h("div.call-reacts", REACTIONS.map((e) => h("button", { type: "button", "aria-label": `Реакция ${e}`, onclick: () => react(e) }, e)));
  cur.ui.querySelector(".call-controls").replaceChildren(
    reacts,
    h("div.call-row",
      ctrl("", cur.muted ? "micOff" : "mic", cur.muted ? "Включить микрофон" : "Выключить микрофон", () => setMic(cur.muted), cur.muted),
      ctrl("", cur.camOff ? "videoOff" : "video", cur.camOff ? "Включить камеру" : "Выключить камеру", () => setCam(cur.camOff), cur.camOff),
      vt && !canScreen ? ctrl("", "refresh", "Сменить камеру", flipCamera) : null,
      canScreen ? ctrl(cur.screen ? "accent" : "", "monitor", cur.screen ? "Остановить демонстрацию" : "Показать экран", toggleScreen, !!cur.screen) : null,
      canBlur ? ctrl("", "sparkle", "Размыть фон", toggleBlur) : null,
      ctrl(cur.recorder ? "rec" : "", "record", cur.recorder ? "Остановить запись" : "Записать звонок", toggleRecord, !!cur.recorder),
      ctrl("red", "phoneOff", "Завершить звонок", hangup)));
}

function floatReaction(uid, emoji) {
  if (!cur?.ui || !REACTIONS.includes(emoji)) return;
  const t = cur.ui.querySelector(`.call-tile[data-uid="${uid}"]`) || cur.ui;
  const r = t.getBoundingClientRect();
  const el = h("span.call-float", { style: { left: `${r.left + r.width / 2 + (Math.random() * 60 - 30)}px`, top: `${r.top + r.height * 0.7}px` } }, emoji);
  cur.ui.querySelector(".call-react").append(el);
  setTimeout(() => el.remove(), 2200);
}

const meters = new WeakMap();
function updateLevels() {
  if (!cur?.ui || !actx) { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
  const check = (stream, uid) => {
    if (!stream.getAudioTracks().length) return;
    let m = meters.get(stream);
    if (!m) {
      try {
        const src = actx.createMediaStreamSource(stream);
        const an = actx.createAnalyser(); an.fftSize = 256;
        src.connect(an);
        m = { an, buf: new Uint8Array(an.frequencyBinCount) };
        meters.set(stream, m);
      } catch { return; }
    }
    m.an.getByteFrequencyData(m.buf);
    const lvl = m.buf.reduce((a, b) => a + b, 0) / m.buf.length;
    cur.ui.querySelector(`.call-tile[data-uid="${uid}"]`)?.classList.toggle("speaking", lvl > 18);
  };
  if (!cur.muted) check(cur.local, state.me.id);
  for (const p of cur.peers.values()) check(p.stream, p.uid);
}

function dragPip(el) {
  if (!cur || cur.peers.size !== 1) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  el.addEventListener("pointerdown", (e) => { drag = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; el.setPointerCapture(e.pointerId); });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, ox + e.clientX - sx))}px`;
    el.style.top = `${Math.max(8, Math.min(innerHeight - el.offsetHeight - 8, oy + e.clientY - sy))}px`;
    el.style.right = "auto"; el.style.bottom = "auto";
  });
  el.addEventListener("pointerup", () => { drag = false; });
}

function minimize() {
  if (!cur) return;
  cur.minimized = true;
  cur.ui.hidden = true;
  document.body.classList.remove("in-call");
  cur.pill = h("button.call-pill", { type: "button", onclick: expand }, icon("phone", "sm"), h("span", h("b", names()), h("small", "")), h("span.call-pill-end", { onclick: (e) => { e.stopPropagation(); hangup(); } }, icon("phoneOff", "sm")));
  document.body.append(cur.pill);
  paintHeader();
}
function expand() {
  if (!cur) return;
  cur.minimized = false;
  cur.ui.hidden = false;
  cur.pill?.remove(); cur.pill = null;
  document.body.classList.add("in-call");
}

// ---------------------------------------------------------------- события
export function initCalls() {
  on("call_invite", incoming);
  on("call_signal", onSignal);
  on("call_join", ({ call_id: cid, user }) => {
    if (!cur || cid !== cur.id) return;
    cur.cards.set(user.id, user);
    addPeer(user.id, user);
    tone([660, 880], 0.12, 0.03, 0.05);
  });
  on("call_leave", ({ call_id: cid, user_id: uid }) => {
    if (!cur || cid !== cur.id) return;
    removePeer(uid);
    tone([660, 440], 0.12, 0.03, 0.05);
  });
  on("call_decline", ({ call_id: cid }) => {
    if (cur && cid === cur.id && !cur.connectedAt && cur.peers.size === 0) cleanup("Собеседник отклонил звонок");
  });
  on("call_end", ({ call_id: cid }) => {
    if (incomingUi && incomingUi._id === cid) closeIncoming();
    if (cur && cid === cur.id) cleanup();
  });
  addEventListener("pagehide", () => { if (cur) fetch(`/api/calls/${cur.id}/leave`, { method: "POST", keepalive: true, headers: { "X-CSRF-Token": state.csrf || "" } }).catch(() => {}); });
}

export const callActive = () => !!cur;
