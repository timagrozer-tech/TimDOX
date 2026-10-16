// «Звуковое рукопожатие»: два телефона рядом «пересвистываются» и находят друг друга в Ярко —
// без QR-кодов, Bluetooth и поиска по имени. Звук кодирует и распознаёт наш модем (sound/modem.js).
import { api } from "../api.js";
import { h, icon, avatar, pl } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";
import { setCleanup } from "../router.js";
import { openChat } from "../components/people.js";
import { playNotifySound } from "../notifysound.js";
import { encode, Decoder } from "../sound/modem.js";

const F_LO = 1200, F_HI = 5000;

export async function soundPage() {
  setTitle("Звуковое рукопожатие");
  if (!document.querySelector("link[data-sound]")) {
    document.head.append(h("link", { rel: "stylesheet", href: "/static/css/sound.css?v=1", dataset: { sound: "1" } }));
  }
  let me = null;
  try { me = await api.fresh("/api/soundlink/me"); } catch (e) { toastError(e); }

  const spec = h("canvas.snd-spec", { width: 640, height: 220, "aria-hidden": "true" });
  const sg = spec.getContext("2d");
  const ring = h("div.snd-ring", h("span"), h("span"), h("span"));
  const mainBtn = h("button.snd-main", { type: "button" }, ring, h("b", "Обменяться"), h("small", "нажмите на обоих телефонах"));
  const sendBtn = h("button.btn.soft", { type: "button" }, icon("volume", "sm"), "Только передать");
  const listenBtn = h("button.btn.soft", { type: "button" }, icon("mic", "sm"), "Только слушать");
  const status = h("p.snd-status", { role: "status" }, "Поднесите телефоны друг к другу и нажмите «Обменяться» на обоих.");
  const meter = h("div.snd-meter", h("i"));
  const found = h("div.snd-found");
  const root = h("div.stack.snd",
    h("div.page-head", h("h1", "Звуковое рукопожатие")),
    found,
    h("div.card.snd-card",
      h("p.snd-lead", "Телефоны передадут друг другу ваши страницы ", h("b", "звуком"), " — как старый модем, только за секунду. Между телефонами не нужны ни интернет, ни Bluetooth, ни QR-код."),
      h("div.snd-stage", mainBtn),
      h("div.snd-row", sendBtn, listenBtn),
      status, meter, spec,
      h("p.snd-hint", "Громкость — повыше. Работает и в шумной комнате: можно «поймать» сразу нескольких человек рядом.")));

  let ac = null, stream = null, node = null, src = null, analyser = null, raf = 0, timer = 0, mode = null, stopped = false;
  const seen = new Set();
  const dec = { d: null };
  // код меняется каждые 5 минут — обновляем заранее
  const refresh = setInterval(async () => { try { me = await api.fresh("/api/soundlink/me"); } catch { /* сеть */ } }, 4 * 60 * 1000);
  setCleanup(() => { stopped = true; clearInterval(refresh); stopAll(); });

  function paint() {
    root.dataset.mode = mode || "";
    mainBtn.classList.toggle("on", mode === "both");
    sendBtn.classList.toggle("on", mode === "send");
    listenBtn.classList.toggle("on", mode === "listen");
    mainBtn.querySelector("b").textContent = mode === "both" ? "Остановить" : "Обменяться";
  }
  function stopAll() {
    clearTimeout(timer); cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    try { node?.disconnect(); src?.disconnect(); } catch { /* */ }
    ac?.close().catch(() => {}); ac = null; mode = null;
    if (!stopped) paint();
  }
  async function ensureAudio(withMic) {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC({ latencyHint: "interactive" });
    }
    await ac.resume().catch(() => {});
    if (withMic && !stream) {
      // без шумодава и автогромкости: они вырезают «писк» как помеху
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      src = ac.createMediaStreamSource(stream);
      analyser = ac.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
      src.connect(analyser);
      dec.d = new Decoder(ac.sampleRate);
      const onSamples = (x) => { for (const code of dec.d.push(x)) onCode(code); };
      if (ac.audioWorklet) {
        await ac.audioWorklet.addModule("/static/js/sound/mic-worklet.js");
        node = new AudioWorkletNode(ac, "yarko-tap");
        node.port.onmessage = (e) => onSamples(e.data);
        src.connect(node);
      } else { // старые браузеры
        node = ac.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(node); node.connect(ac.destination);
      }
      drawSpec();
    }
  }
  function beep() {
    if (!ac || !me) return 0;
    const x = encode(me.code, ac.sampleRate, { repeats: 1, gap: 0.05, amp: 0.7 });
    const b = ac.createBuffer(1, x.length, ac.sampleRate); b.copyToChannel(x, 0);
    const s = ac.createBufferSource(); s.buffer = b; s.connect(ac.destination); s.start();
    root.classList.add("sending"); setTimeout(() => root.classList.remove("sending"), x.length / ac.sampleRate * 1000);
    return x.length / ac.sampleRate;
  }
  // передача по кругу: в режиме обмена между своими «посылками» слушаем случайное время, чтобы телефоны не перекрикивали друг друга
  function loop() {
    if (!mode || mode === "listen") return;
    const dur = beep();
    const pause = mode === "both" ? 900 + Math.random() * 1400 : 450;
    timer = setTimeout(loop, dur * 1000 + pause);
  }
  async function start(m) {
    if (mode === m) { stopAll(); status.textContent = "Остановлено."; return; }
    if (!me && m !== "listen") { toast("Не удалось получить ваш код — обновите страницу"); return; }
    stopAll();
    try {
      await ensureAudio(m !== "send");
    } catch (e) {
      stopAll();
      status.textContent = e?.name === "NotAllowedError" ? "Нужен доступ к микрофону — разрешите его в настройках браузера." : "Микрофон недоступен на этом устройстве.";
      return;
    }
    mode = m; paint();
    status.textContent = m === "send" ? "Передаю вашу страницу звуком… поднесите телефон к другому, где включено «Слушать»."
      : m === "listen" ? "Слушаю… пусть второй телефон нажмёт «Обменяться» или «Только передать»."
        : "Обмениваемся… держите телефоны рядом несколько секунд.";
    loop();
  }
  mainBtn.onclick = () => start("both");
  sendBtn.onclick = () => start("send");
  listenBtn.onclick = () => start("listen");

  async function onCode(code) {
    if (me && code === me.code) return; // своё же эхо
    if (seen.has(code)) return;
    seen.add(code);
    try {
      const r = await api.fresh(`/api/soundlink/${code}`);
      if (r.self) return;
      navigator.vibrate?.([30, 40, 30]);
      playNotifySound({ force: true });
      found.prepend(personCard(r));
      found.scrollIntoView({ behavior: "smooth", block: "start" });
      status.textContent = `Найден${r.user.name ? ": " + r.user.name : ""}! Можно слушать дальше — рядом может быть кто-то ещё.`;
    } catch { seen.delete(code); /* старый или чужой код — тихо пропускаем */ }
  }

  function personCard(r) {
    const u = r.user;
    const rel = h("div.snd-acts");
    const paintRel = (st) => {
      rel.replaceChildren();
      if (st === "friends") rel.append(h("span.snd-tag", icon("check", "sm"), "Вы друзья"));
      else if (st === "request_sent") rel.append(h("span.snd-tag", icon("check", "sm"), "Заявка отправлена"));
      else {
        const accept = st === "request_received";
        const b = h("button.btn.primary", { type: "button" }, icon("userAdd", "sm"), accept ? "Принять в друзья" : "Добавить в друзья");
        b.onclick = async () => {
          b.disabled = true;
          try {
            const res = await api.post(`/api/people/${u.id}/friend${accept ? "/accept" : ""}`);
            paintRel(res.relation?.status || "request_sent");
          } catch (e) { b.disabled = false; toastError(e); }
        };
        rel.append(b);
      }
      rel.append(h("a.btn.soft", { href: `/u/${u.username}` }, "Профиль"),
        h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Написать", title: "Написать", onclick: () => openChat(u.id) }, icon("message")));
    };
    paintRel(r.relation.status);
    return h("div.card.snd-person",
      avatar(u, "lg"),
      h("div.snd-who",
        h("a.snd-name", { href: `/u/${u.username}` }, u.name),
        h("div.snd-sub", [`@${u.username}`, u.city, r.mutual ? pl(r.mutual, ["общий друг", "общих друга", "общих друзей"]) : null].filter(Boolean).join(" · ")),
        u.bio ? h("div.snd-bio", u.bio) : null,
        rel));
  }

  // живая спектрограмма: видно, как «звучит» ваша страница
  function drawSpec() {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const nyq = ac.sampleRate / 2, lo = Math.floor(F_LO / nyq * bins.length), hi = Math.ceil(F_HI / nyq * bins.length);
    const W = spec.width, H = spec.height;
    const col = sg.createImageData(1, H);
    const tick = () => {
      if (!analyser || stopped) return;
      analyser.getByteFrequencyData(bins);
      sg.drawImage(spec, -2, 0); // сдвиг влево
      for (let y = 0; y < H; y++) {
        const b = bins[Math.round(hi - (y / H) * (hi - lo))] / 255;
        const v = Math.pow(b, 2.2);
        col.data[y * 4] = 20 + v * 120; col.data[y * 4 + 1] = 30 + v * 200; col.data[y * 4 + 2] = 60 + v * 195; col.data[y * 4 + 3] = 255;
      }
      sg.putImageData(col, W - 1, 0); sg.putImageData(col, W - 2, 0);
      meter.firstChild.style.width = `${Math.round((dec.d?.level || 0) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    sg.fillStyle = "#0e1726"; sg.fillRect(0, 0, W, H);
    tick();
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    listenBtn.disabled = true; mainBtn.disabled = true;
    status.textContent = "Этот браузер не даёт доступ к микрофону — можно только передавать.";
  }
  paint();
  return root;
}
