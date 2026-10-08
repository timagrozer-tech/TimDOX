// Чат 2.0: оформление чата (обои, акцент, пузыри, размер текста), капсулы времени, колесо решений и касания «тук-тук».
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, toast, toastError, busy, showMenu } from "../ui.js";

// ---------------------------------------------------------------- оформление
export const WALLS = [
  ["none", "Без обоев"], ["aurora", "Северное сияние"], ["cosmos", "Космос"], ["ocean", "Океан"], ["sunset", "Закат"],
  ["mint", "Мята"], ["forest", "Лес"], ["candy", "Конфета"], ["neon", "Неон"], ["matrix", "Матрица"],
  ["hearts", "Сердечки"], ["bubbles", "Пузыри"], ["snow", "Снегопад"], ["paper", "Бумага"],
];
export const ACCENTS = [
  ["default", "Как на сайте", "var(--grad)"], ["violet", "Фиолетовый", "linear-gradient(135deg,#8b5cf6,#6d28d9)"],
  ["blue", "Синий", "linear-gradient(135deg,#3b82f6,#1d4ed8)"], ["cyan", "Бирюзовый", "linear-gradient(135deg,#22d3ee,#0891b2)"],
  ["green", "Зелёный", "linear-gradient(135deg,#34d399,#059669)"], ["lime", "Лайм", "linear-gradient(135deg,#a3e635,#4d7c0f)"],
  ["amber", "Янтарь", "linear-gradient(135deg,#fbbf24,#d97706)"], ["orange", "Апельсин", "linear-gradient(135deg,#fb923c,#ea580c)"],
  ["red", "Красный", "linear-gradient(135deg,#f87171,#dc2626)"], ["pink", "Розовый", "linear-gradient(135deg,#f472b6,#db2777)"],
  ["mono", "Графит", "linear-gradient(135deg,#52525b,#18181b)"],
];
export const BUBBLES = [["round", "Круглые"], ["sharp", "Строгие"], ["glass", "Стекло"], ["cloud", "Облачка"], ["outline", "Контур"]];
const DEFAULT = { wall: "none", accent: "default", bubble: "round", size: 15, anim: true };

export function applyChatTheme(pane, theme) {
  const t = { ...DEFAULT, ...(theme || {}) };
  [...pane.classList].filter((c) => /^(cw|ca|cb)-/.test(c)).forEach((c) => pane.classList.remove(c));
  pane.classList.add(`cw-${t.wall}`, `ca-${t.accent}`, `cb-${t.bubble}`);
  pane.classList.toggle("cw-still", !t.anim);
  pane.style.setProperty("--chat-fs", `${t.size}px`);
}

export function openThemeEditor({ id, conv, pane, isGroup }) {
  const start = { ...DEFAULT, ...(conv.theme || {}) };
  const t = { ...start };
  let shared = !conv.own && !!conv.shared;
  const live = () => applyChatTheme(pane, t);
  const sw = (list, key, render) => h(`div.ct-grid.ct-${key}`, list.map(([v, label, extra]) => {
    const b = h(`button.ct-opt${t[key] === v ? ".on" : ""}`, { type: "button", title: label, "aria-label": label, "aria-pressed": String(t[key] === v),
      onclick: () => { t[key] = v; b.parentElement.querySelectorAll(".ct-opt").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); live(); } },
    render(v, label, extra));
    return b;
  }));
  const size = h("input", { type: "range", min: 13, max: 20, value: t.size, "aria-label": "Размер текста", oninput: (e) => { t.size = +e.target.value; sizeVal.textContent = `${t.size}px`; live(); } });
  const sizeVal = h("b", `${t.size}px`);
  const anim = h("input.switch", { type: "checkbox", role: "switch", checked: t.anim, onchange: (e) => { t.anim = e.target.checked; live(); } });
  const who = h("div.segmented.ct-who",
    h("button", { type: "button", "aria-pressed": String(!shared), onclick: (e) => { shared = false; mark(e.currentTarget); } }, "Только у меня"),
    h("button", { type: "button", "aria-pressed": String(shared), onclick: (e) => { shared = true; mark(e.currentTarget); } }, isGroup ? "У всех в беседе" : "У нас обоих"));
  const mark = (btn) => who.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
  const save = h("button.btn.primary", { type: "button" }, icon("check", "sm"), "Сохранить");
  const reset = h("button.btn.ghost", { type: "button" }, "Сбросить");
  let saved = false;
  const m = modal({
    title: "Оформление чата", wide: true,
    body: h("div.stack.ct",
      h("h4", "Обои"), sw(WALLS, "wall", (v, label) => h("span.ct-wall", h(`span.ct-wall-prev.cw-${v}`), h("small", label))),
      h("h4", "Цвет ваших сообщений"), sw(ACCENTS, "accent", (v, label, bg) => h("span.ct-dot", { style: { background: bg } })),
      h("h4", "Форма пузырей"), sw(BUBBLES, "bubble", (v, label) => h("span.ct-bub", h(`span.ct-bub-prev.cb-${v}`, "Привет!"), h("small", label))),
      h("div.setting-row", h("div.label-block", h("b", "Размер текста"), h("small", "Только в этом чате")), h("div.row", size, sizeVal)),
      h("div.setting-row", h("div.label-block", h("b", "Живые обои"), h("small", "Плавное движение фона")), anim),
      h("h4", "Для кого"), who),
    footer: [reset, save],
    onClose: () => { if (!saved) applyChatTheme(pane, conv.theme); },
  });
  const send = (theme) => busy(save, async () => {
    try {
      const r = await api.patch(`/api/conversations/${id}/theme`, { theme, shared });
      Object.assign(conv, r);
      saved = true;
      applyChatTheme(pane, conv.theme);
      m.close();
      toast(shared ? "Оформление поменялось у всех ✨" : "Оформление сохранено ✨", { icon: "check" });
    } catch (e) { toastError(e); }
  });
  save.onclick = () => send(t);
  reset.onclick = () => { Object.assign(t, DEFAULT); send(null); };
}

// ---------------------------------------------------------------- капсула времени
const pad = (n) => String(n).padStart(2, "0");
function left(ms) {
  if (ms <= 0) return "открывается…";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60);
  if (d > 0) return `${d} д ${hh} ч`;
  if (hh > 0) return `${hh} ч ${pad(mm)} мин`;
  return `${mm}:${pad(s % 60)}`;
}

export function capsuleNode(m, { onOpen }) {
  const md = m.media || {};
  const when = new Date(md.unlock_at);
  const dateText = when.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  if (md.opened) {
    return h("div.capsule.opened", h("div.capsule-top", h("span.capsule-ic", "🔓"), h("b", "Капсула времени открыта"), h("small", dateText)),
      md.hint ? h("div.capsule-hint", md.hint) : null, h("div.capsule-text", m.text));
  }
  const timer = h("b.capsule-timer", left(when - Date.now()));
  const node = h("div.capsule.sealed", h("div.capsule-orb", h("span", "⏳")),
    h("div.capsule-body", h("b", "Капсула времени"), h("small", `откроется ${dateText}`), md.hint ? h("div.capsule-hint", `«${md.hint}»`) : null, timer));
  const tick = () => {
    if (!node.isConnected) return;
    const ms = when - Date.now();
    timer.textContent = left(ms);
    if (ms <= 0) { node.classList.add("cracking"); setTimeout(onOpen, 900); return; }
    setTimeout(tick, ms < 3600e3 ? 1000 : 30000);
  };
  setTimeout(tick, 1000);
  return node;
}

export function openCapsuleDialog(id) {
  return new Promise((resolve) => {
    const text = h("textarea.input", { rows: 4, maxlength: 2000, placeholder: "Что откроется в будущем? Поздравление, предсказание, секрет…" });
    const hint = h("input.input", { maxlength: 60, placeholder: "Подсказка снаружи (необязательно): «на твой ДР»" });
    const now = new Date();
    const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
    const ny = new Date(now.getFullYear() + (now.getMonth() === 11 && now.getDate() === 31 ? 1 : 0), 11, 31, 23, 59, 0);
    if (ny <= now) ny.setFullYear(ny.getFullYear() + 1);
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const at = h("input.input", { type: "datetime-local", value: local(new Date(now.getTime() + 3600e3)), min: local(new Date(now.getTime() + 120e3)) });
    const preset = (label, d) => h("button.ct-chip", { type: "button", onclick: () => { at.value = local(d); } }, label);
    const send = h("button.btn.primary", { type: "button" }, "⏳ Запечатать");
    let result = null;
    const m = modal({
      title: "Капсула времени", narrow: true,
      body: h("div.stack", h("p.muted", { style: { margin: 0 } }, "Сообщение увидят только в назначенный момент — до этого его не прочитает никто, даже вы."),
        text, hint, h("label.field", h("span", "Откроется"), at),
        h("div.ct-chips",
          preset("Через час", new Date(now.getTime() + 3600e3)), preset("Завтра в 9:00", tomorrow9),
          preset("Через неделю", new Date(now.getTime() + 7 * 864e5)), preset("Через год", new Date(now.getTime() + 365 * 864e5)), preset("Новый год 🎄", ny))),
      footer: [send],
      onClose: () => resolve(result),
    });
    send.onclick = () => busy(send, async () => {
      if (!text.value.trim()) { text.focus(); return; }
      try {
        result = await api.post(`/api/conversations/${id}/capsule`, { text: text.value, hint: hint.value, unlock_at: new Date(at.value).toISOString() });
        m.close();
        toast("Капсула запечатана ⏳", { icon: "check" });
      } catch (e) { toastError(e); }
    });
    setTimeout(() => text.focus(), 50);
  });
}

// ---------------------------------------------------------------- колесо решений
const WHEEL_COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6", "#a855f7"];

export function wheelNode(m, { spin = false, onRepeat }) {
  const md = m.media || {};
  const opts = md.options || [];
  const n = opts.length || 1, seg = 360 / n, R = 90;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-100 -100 200 200");
  svg.classList.add("wheel-svg");
  const g = document.createElementNS(svg.namespaceURI, "g");
  opts.forEach((o, i) => {
    const a0 = (i * seg - 90) * Math.PI / 180, a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    const p = document.createElementNS(svg.namespaceURI, "path");
    p.setAttribute("d", `M0 0 L${R * Math.cos(a0)} ${R * Math.sin(a0)} A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${R * Math.cos(a1)} ${R * Math.sin(a1)} Z`);
    p.setAttribute("fill", WHEEL_COLORS[i % WHEEL_COLORS.length]);
    g.append(p);
    const mid = ((i + .5) * seg - 90) * Math.PI / 180;
    const t = document.createElementNS(svg.namespaceURI, "text");
    t.setAttribute("x", String(R * .58 * Math.cos(mid))); t.setAttribute("y", String(R * .58 * Math.sin(mid)));
    t.setAttribute("transform", `rotate(${(i + .5) * seg} ${R * .58 * Math.cos(mid)} ${R * .58 * Math.sin(mid)})`);
    t.textContent = o.length > 11 ? o.slice(0, 10) + "…" : o;
    g.append(t);
  });
  svg.append(g);
  // указатель сверху; финальный угол — середина выигравшего сектора под ним
  const final = (md.turns || 5) * 360 + (360 - (md.winner + .5) * seg);
  const result = h("div.wheel-result", opts[md.winner] ? h("span", "Выпало: ", h("b", opts[md.winner])) : null);
  const node = h("div.wheel-card", md.question ? h("b.wheel-q", md.question) : h("b.wheel-q", "Колесо решений"),
    h("div.wheel-box", svg, h("span.wheel-pin"), h("span.wheel-hub", "🎡")), result,
    onRepeat ? h("button.btn.ghost.sm", { type: "button", onclick: () => onRepeat(md) }, "Крутить ещё раз") : null);
  if (spin && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    result.classList.add("hidden");
    g.style.transform = "rotate(0deg)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      g.style.transition = "transform 3.6s cubic-bezier(.15,.85,.2,1)";
      g.style.transform = `rotate(${final}deg)`;
    }));
    setTimeout(() => { result.classList.remove("hidden"); node.classList.add("done"); navigator.vibrate?.(30); }, 3700);
  } else {
    g.style.transform = `rotate(${final}deg)`;
    node.classList.add("done");
  }
  return node;
}

export function openWheelDialog(id, preset = null) {
  return new Promise((resolve) => {
    const q = h("input.input", { maxlength: 80, placeholder: "Вопрос: «Куда идём?»", value: preset?.question || "" });
    const list = h("div.stack.wheel-opts");
    const add = (v = "") => {
      if (list.children.length >= 8) return;
      const inp = h("input.input", { maxlength: 40, value: v, placeholder: `Вариант ${list.children.length + 1}` });
      list.append(h("div.row", inp, h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Убрать", onclick: (e) => e.currentTarget.parentElement.remove() }, icon("x", "sm"))));
      return inp;
    };
    (preset?.options || ["", ""]).forEach((v) => add(v));
    const spinBtn = h("button.btn.primary", { type: "button" }, "🎡 Крутить");
    let result = null;
    const m = modal({
      title: "Колесо решений", narrow: true,
      body: h("div.stack", h("p.muted", { style: { margin: 0 } }, "Не можете решить? Пусть решит колесо — результат увидят все в чате, и он у всех одинаковый."),
        q, list, h("button.btn.soft.sm", { type: "button", onclick: () => add()?.focus() }, icon("plus", "sm"), "Добавить вариант")),
      footer: [spinBtn],
      onClose: () => resolve(result),
    });
    spinBtn.onclick = () => busy(spinBtn, async () => {
      const options = [...list.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
      try {
        result = await api.post(`/api/conversations/${id}/wheel`, { question: q.value, options });
        m.close();
      } catch (e) { toastError(e); }
    });
  });
}

// ---------------------------------------------------------------- касания
export const NUDGES = [
  ["knock", "👊", "Тук-тук", [40, 90, 40]],
  ["heart", "💓", "Сердцебиение", [70, 110, 70, 550, 70, 110, 70]],
  ["hug", "🤗", "Обнять", [300]],
  ["fire", "🔥", "Огонь", [20, 30, 20, 30, 20, 30, 20]],
  ["wave", "👋", "Помахать", [30, 60, 30, 60, 30]],
];

export function nudgeNode(m, who) {
  const n = NUDGES.find((x) => x[0] === m.media?.type) || NUDGES[0];
  return h("div.nudge-line", h("span.nudge-emo", n[1]), h("span", `${who} · ${n[2].toLowerCase()}`));
}

export function playNudge(type, from = "") {
  const n = NUDGES.find((x) => x[0] === type) || NUDGES[0];
  navigator.vibrate?.(n[3]);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { toast(`${from} — ${n[2].toLowerCase()} ${n[1]}`); return; }
  const fx = h(`div.nudge-fx.nf-${n[0]}`, h("span.nudge-big", n[1]), from ? h("span.nudge-from", from) : null,
    ...Array.from({ length: n[0] === "heart" || n[0] === "fire" ? 14 : 0 }, (_, i) => h("i", { style: { "--x": `${Math.random() * 100}%`, "--d": `${(i % 7) * .12}s`, "--s": `${.6 + Math.random() * .8}` } }, n[1])));
  document.body.append(fx);
  if (n[0] === "knock") document.querySelector(".chat")?.classList.add("knock-shake");
  setTimeout(() => document.querySelector(".chat")?.classList.remove("knock-shake"), 700);
  setTimeout(() => fx.remove(), 2400);
}

export function nudgeMenu(anchor, id, onSent) {
  showMenu(anchor, NUDGES.map(([type, emo, label]) => ({
    label: `${emo}  ${label}`, onClick: async () => {
      playNudge(type);
      try { onSent(await api.post(`/api/conversations/${id}/nudge`, { type })); } catch (e) { toastError(e); }
    },
  })), { title: "Касание — почувствует даже на расстоянии" });
}
