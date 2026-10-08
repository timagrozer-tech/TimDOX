// Проверка звонков: доступны ли микрофон и камера и может ли сеть соединить звонок (STUN — напрямую, TURN — через ретранслятор).
// Ничего не записывает и никуда не отправляет, кроме служебных запросов к серверам соединения.
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { setTitle, busy } from "../ui.js";
import { setCleanup } from "../router.js";

const ROWS = [
  ["media", "Микрофон и камера", "Браузер даёт доступ к устройствам"],
  ["signal", "Связь с сервером Yarko", "Через неё участники находят друг друга"],
  ["host", "Локальная сеть", "Прямой звонок внутри одной сети"],
  ["stun", "Прямое соединение (STUN)", "Звонок напрямую между устройствами через интернет"],
  ["turn", "Ретранслятор (TURN)", "Запасной путь, когда сеть или оператор не пропускают прямой звонок"],
];

/** Собирает ICE-кандидатов и возвращает их типы: host / srflx / relay */
async function gather(iceServers, timeout = 7000) {
  const pc = new RTCPeerConnection({ iceServers });
  const types = new Set();
  pc.createDataChannel("probe");
  const done = new Promise((resolve) => {
    const t = setTimeout(resolve, timeout);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(t); resolve(); return; }
      const m = / typ (\w+)/.exec(e.candidate.candidate);
      if (m) types.add(m[1]);
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } };
  });
  await pc.setLocalDescription(await pc.createOffer());
  await done;
  pc.close();
  return types;
}

export async function callTestPage() {
  setTitle("Проверка звонков");
  const marks = {};
  const list = h("div.ct-list", ...ROWS.map(([id, title, hint]) => {
    marks[id] = h("span.ct-mark", "·");
    return h("div.ct-row", { dataset: { id } }, marks[id], h("div.label-block", h("b", title), h("small", hint)));
  }));
  const verdict = h("div.ct-verdict", { hidden: true });
  const run = h("button.btn.primary", { type: "button" }, icon("phone", "sm"), "Проверить");
  const set = (id, st, note) => {
    const row = list.querySelector(`[data-id="${id}"]`);
    row.className = `ct-row ${st}`;
    marks[id].textContent = { ok: "✓", bad: "✕", warn: "!", wait: "…", skip: "—" }[st];
    const small = row.querySelector("small");
    if (note) small.textContent = note;
  };
  let stream = null;
  setCleanup(() => stream?.getTracks().forEach((t) => t.stop()));

  async function test() {
    verdict.hidden = true;
    ROWS.forEach(([id, , hint]) => set(id, "wait", hint));
    // 1. устройства
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      set("media", "ok", stream.getVideoTracks().length ? "Микрофон и камера доступны" : "Микрофон доступен, камеры нет или она занята");
    } catch {
      set("media", "bad", "Нет доступа — разрешите микрофон и камеру для сайта в настройках браузера");
    } finally { stream?.getTracks().forEach((t) => t.stop()); }
    // 2. сервер
    let ice = [];
    try {
      ice = (await api.get("/api/calls/ice")).ice_servers;
      set("signal", "ok", "Сервер Yarko отвечает");
    } catch {
      set("signal", "bad", "Сервер недоступен — проверьте интернет");
    }
    // 3. сеть
    const stunOnly = ice.map((s) => ({ urls: [].concat(s.urls).filter((u) => u.startsWith("stun:")) })).filter((s) => s.urls.length);
    const turn = ice.filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
    const [a, b] = await Promise.all([
      gather(stunOnly).catch(() => new Set()),
      turn.length ? gather(turn, 9000).catch(() => new Set()) : Promise.resolve(null),
    ]);
    set("host", a.has("host") ? "ok" : "warn", a.has("host") ? "Работает" : "Браузер скрывает локальные адреса — это нормально");
    const stunOk = a.has("srflx");
    set("stun", stunOk ? "ok" : "bad", stunOk ? "Работает — звонок может пройти напрямую" : "Не работает — сеть или оператор блокируют прямые звонки");
    const turnOk = b?.has("relay");
    if (b === null) set("turn", "skip", "Не настроен на сервере");
    else set("turn", turnOk ? "ok" : "bad", turnOk ? "Работает — звонок пройдёт даже через строгую сеть" : "Не отвечает");

    verdict.hidden = false;
    if (turnOk) verdict.replaceChildren(h("b", "✅ Звонки будут работать"), h("p", "Даже если прямое соединение заблокировано, звонок пойдёт через ретранслятор."));
    else if (stunOk) verdict.replaceChildren(h("b", "🟡 Звонки скорее всего будут работать"),
      h("p", "Прямое соединение доступно. Но если у собеседника строгая сеть (часто мобильный интернет), звонок может не соединиться — для этого нужен ретранслятор."));
    else verdict.replaceChildren(h("b", "🔴 Звонки из этой сети не пройдут"),
      h("p", "Ваша сеть не пропускает прямые звонки, а ретранслятор не настроен. Попробуйте Wi-Fi вместо мобильного интернета или сообщите администратору."));
  }
  run.addEventListener("click", () => busy(run, test));

  return h("div.stack.calltest",
    h("div.page-head", h("h1", "Проверка звонков")),
    h("section.card.card-pad.stack",
      h("p.muted", "За 10 секунд проверим, пройдёт ли голосовой или видеозвонок из вашей сети. Ничего не записывается."),
      list, verdict, h("div.row", run)));
}
