// Constellation ✦ — цифровая вселенная профиля.
// Нажатие на ✦ рядом с именем не открывает меню: интерфейс перестраивается в вселенную вокруг человека.
// Этапы: затемнение → размытие профиля → частицы стягиваются к центру → миры выходят на орбиты.
// Всё движение — transform/opacity на компоновщике, частицы — один canvas, на слабых устройствах их меньше.
import { api, state } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { toast, toastError, modal, busy } from "../ui.js";
import { pushOverlay, navigate } from "../router.js";

// внешний вид каждого мира: тип тела и два цвета. Никаких логотипов — у каждого мира своя форма.
const WORLDS = {
  telegram: { type: "satellite", name: "Спутник связи", c: ["#5fc8ff", "#1f7ae0"] },
  discord: { type: "satellite", name: "Станция голосов", c: ["#9aa4ff", "#5865f2"] },
  instagram: { type: "planet", name: "Планета кадров", c: ["#ffb35c", "#d6249f"] },
  tiktok: { type: "planet", name: "Ритм-планета", c: ["#5ef2e8", "#ff2d6f"] },
  x: { type: "node", name: "Узел мыслей", c: ["#e6e6e6", "#5a5a5a"] },
  threads: { type: "node", name: "Узел разговоров", c: ["#d9d9d9", "#4a4a4a"] },
  vk: { type: "planet", name: "Планета друзей", c: ["#7fb2ff", "#0077ff"] },
  steam: { type: "planet", ring: true, name: "Игровая планета", c: ["#66c0f4", "#1b2838"] },
  xbox: { type: "planet", ring: true, name: "Зелёный мир", c: ["#7ee07e", "#107c10"] },
  playstation: { type: "planet", ring: true, name: "Синий мир", c: ["#7aa8ff", "#003791"] },
  epic: { type: "crystal", name: "Эпический кристалл", c: ["#f2f2f2", "#2a2a2a"] },
  riot: { type: "comet", name: "Комета арены", c: ["#ff8a80", "#d13639"] },
  github: { type: "node", name: "Технологический узел", c: ["#b4a7ff", "#24292f"] },
  gitlab: { type: "node", name: "Узел сборки", c: ["#ffb169", "#e24329"] },
  portfolio: { type: "portal", name: "Портал работ", c: ["#ffd36e", "#ff7a59"] },
  website: { type: "portal", name: "Портал", c: ["#8ef0c9", "#2bb3a3"] },
  youtube: { type: "planet", ring: true, name: "Медиа-планета", c: ["#ff8a8a", "#e60023"] },
  twitch: { type: "planet", name: "Планета эфиров", c: ["#c9a4ff", "#7c3aed"] },
  spotify: { type: "planet", name: "Планета звука", c: ["#7ef0a6", "#1db954"] },
  soundcloud: { type: "planet", name: "Облачная планета", c: ["#ffb27a", "#ff5500"] },
  network: { type: "galaxy", name: "Галактика связей", label: "Сеть", c: ["#c7b8ff", "#7c5cff"] },
  communities: { type: "galaxy", name: "Скопление сообществ", label: "Сообщества", c: ["#9be7ff", "#2f80ed"] },
  gallery: { type: "crystal", name: "Кристалл памяти", label: "Галерея", c: ["#ffc1e3", "#c2185b"] },
  collection: { type: "comet", name: "Комета находок", label: "Коллекция", c: ["#ffe08a", "#f59e0b"] },
};
const KRUG = ["network", "communities", "gallery", "collection"];
const STYLE_NAMES = { cosmos: "Космос", neural: "Нейросеть", crystal: "Кристалл" };
const pl = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]}`; };
const reduced = () => document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const lite = () => document.documentElement.classList.contains("lite");

/** ✦ рядом с именем. Без подписей и подсказок — только знак, который хочется нажать. */
export function constellationSpark(user, data, isMe) {
  const items = data?.items || [];
  if (!items.length && !isMe) return null;
  const btn = h("button.cst-spark", { type: "button", "aria-label": "Открыть созвездие" }, "✦");
  btn.addEventListener("click", () => openConstellation(user, data || { style: "cosmos", items: [] }, isMe, btn));
  return btn;
}

function worldInfo(it, user) {
  const w = WORLDS[it.kind] || WORLDS.website;
  if (KRUG.includes(it.kind)) {
    const s = it.stats || {};
    const facts = it.kind === "network" ? [pl(s.friends || 0, ["друг", "друга", "друзей"]), pl(s.followers || 0, ["подписчик", "подписчика", "подписчиков"])]
      : it.kind === "communities" ? [pl(s.count || 0, ["сообщество", "сообщества", "сообществ"])]
      : it.kind === "gallery" ? [pl(s.count || 0, ["фото", "фото", "фото"])]
      : [pl(s.count || 0, ["находка", "находки", "находок"])];
    const href = it.kind === "network" ? `/u/${user.username}?tab=friends` : it.kind === "gallery" ? `/u/${user.username}?tab=photos`
      : it.kind === "communities" ? "/communities" : `/u/${user.username}`;
    return { w, title: w.label, sub: w.name, facts, href, internal: true };
  }
  return { w, title: it.label, sub: w.name, facts: [it.handle ? `@${it.handle}`.replace(/^@(https?:)/, "$1") : ""], href: it.url, internal: false, handle: it.handle };
}

function body(w, kind) {
  const el = h(`div.cst-body.t-${w.type}${w.ring ? ".ring" : ""}`, { dataset: { kind } });
  el.style.setProperty("--c1", w.c[0]);
  el.style.setProperty("--c2", w.c[1]);
  return el;
}

/** Раскладка по орбитам: до 4 на ближней, до 6 на средней, остальные — на дальней */
function orbitsFor(n) {
  const r = [[], [], []];
  for (let i = 0; i < n; i++) (i < 4 ? r[0] : i < 10 ? r[1] : r[2]).push(i);
  return r.filter((x) => x.length);
}

export function openConstellation(user, data, isMe, origin) {
  let cur = data;
  const root = h("div.cst", { role: "dialog", "aria-modal": "true", "aria-label": `Созвездие ${user.name}` });
  const canvas = h("canvas.cst-sky", { "aria-hidden": "true" });
  const stage = h("div.cst-stage");
  const card = h("div.cst-card", { hidden: true });
  const closeBtn = h("button.cst-x", { type: "button", "aria-label": "Закрыть" }, icon("x"));
  const edit = isMe ? h("button.cst-edit", { type: "button" }, icon("settings", "sm"), "Настроить") : null;
  root.append(canvas, stage, card, h("div.cst-top", edit, closeBtn));
  document.body.append(root);
  document.documentElement.classList.add("cst-open");

  // точка, из которой рождается вселенная, — сам знак ✦
  const o = origin?.getBoundingClientRect();
  if (o) { root.style.setProperty("--ox", `${o.left + o.width / 2}px`); root.style.setProperty("--oy", `${o.top + o.height / 2}px`); }

  let selected = null;
  const showCard = (it, el) => {
    stage.querySelectorAll(".cst-obj.on").forEach((x) => x.classList.remove("on"));
    if (!it) { card.hidden = true; root.classList.remove("paused"); selected = null; return; }
    selected = it;
    el.classList.add("on");
    root.classList.add("paused");
    const info = worldInfo(it, user);
    const go = info.href
      ? h(info.internal ? "a.btn.primary" : "a.btn.primary", info.internal
        ? { href: info.href, onclick: () => close(true) }
        : { href: info.href, target: "_blank", rel: "noopener noreferrer nofollow" }, info.internal ? "Перейти" : "Открыть мир", icon("arrowRight", "sm"))
      : h("button.btn.primary", { type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(info.handle || ""); toast("Скопировано", { icon: "check", duration: 1500 }); } catch { /* нет доступа */ }
      } }, icon("copy", "sm"), "Скопировать ник");
    const mini = body(info.w, it.kind);
    card.replaceChildren(
      h("div.cst-card-head", h("div.cst-card-world", mini), h("div.grow", h("b", info.title), h("small", info.sub))),
      h("div.cst-card-facts", ...info.facts.filter(Boolean).map((f) => h("span", f))),
      h("div.cst-card-actions", h("button.btn.ghost", { type: "button", onclick: () => showCard(null) }, "Назад"), go));
    card.hidden = false;
  };

  const paint = () => {
    root.className = `cst style-${cur.style || "cosmos"}${root.classList.contains("in") ? " in" : ""}`;
    const items = cur.items || [];
    const core = h("div.cst-core", avatar(user, "xl", { presence: false, frame: false }), h("b.cst-core-name", user.name));
    const rings = orbitsFor(items.length).map((idx, ri) => {
      const ring = h(`div.cst-orbit.o${ri + 1}`, { style: { "--n": idx.length } });
      idx.forEach((i, k) => {
        const it = items[i];
        const info = worldInfo(it, user);
        const ang = (360 / idx.length) * k + ri * 37;
        const obj = h("button.cst-obj", { type: "button", "aria-label": `${info.title} — ${info.sub}`, style: { "--a": `${ang}deg`, "--d": `${(i * 70) + 380}ms` } },
          h("span.cst-link", { "aria-hidden": "true" }),
          h("span.cst-upright", body(info.w, it.kind), h("span.cst-label", info.title)));
        obj.addEventListener("click", (e) => { e.stopPropagation(); selected === it ? showCard(null) : showCard(it, obj); });
        ring.append(obj);
      });
      return ring;
    });
    const empty = !items.length ? h("div.cst-empty", h("b", "Здесь будет ваша вселенная"), h("p", "Добавьте миры — соцсети, игры, проекты — и они выйдут на орбиты вокруг вас."),
      h("button.btn.primary", { type: "button", onclick: () => editor() }, icon("plus", "sm"), "Добавить миры")) : null;
    stage.replaceChildren(...rings, core, empty || "");
    card.hidden = true; selected = null; root.classList.remove("paused");
  };
  paint();

  // ---- небо: частицы стягиваются из краёв экрана к центру, потом мерцают
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let W = 0, H = 0, raf = 0, t0 = performance.now();
  const N = reduced() ? 0 : lite() ? 70 : 160;
  const parts = [];
  const resize = () => {
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, rr = 0.15 + Math.random() * 0.85;
    parts.push({ a, rr, sx: Math.random(), sy: Math.random(), s: Math.random() * 1.6 + .3, tw: Math.random() * 6.28, sp: .4 + Math.random() });
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const frame = (now) => {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
    for (const p of parts) {
      const k = ease((t - .25) / 1.1);
      const tx = cx + Math.cos(p.a + t * .02 * p.sp) * p.rr * R * .9, ty = cy + Math.sin(p.a + t * .02 * p.sp) * p.rr * R * .9;
      const x = p.sx * W + (tx - p.sx * W) * k, y = p.sy * H + (ty - p.sy * H) * k;
      const al = Math.min(1, t * 2) * (.35 + .65 * (0.5 + 0.5 * Math.sin(p.tw + t * 2 * p.sp)));
      ctx.globalAlpha = al;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(x, y, p.s, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  };
  if (N) raf = requestAnimationFrame(frame);
  // вкладка в фоне — частицы не считаются
  const vis = () => { if (document.hidden) cancelAnimationFrame(raf); else if (N) { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); } };
  document.addEventListener("visibilitychange", vis);
  addEventListener("resize", resize);

  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("in")));

  let closed = false;
  const release = pushOverlay(() => close(false));
  function close(fromNav) {
    if (closed) return;
    closed = true;
    root.classList.remove("in");
    root.classList.add("out");
    document.documentElement.classList.remove("cst-open");
    document.removeEventListener("visibilitychange", vis);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", resize);
    release();
    setTimeout(() => { cancelAnimationFrame(raf); root.remove(); }, reduced() ? 0 : 420);
    origin?.focus?.({ preventScroll: true });
  }
  closeBtn.addEventListener("click", () => close(false));
  root.addEventListener("click", (e) => { if (e.target === root || e.target === stage || e.target === canvas) selected ? showCard(null) : close(false); });
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) { e.stopPropagation(); e.preventDefault(); selected ? showCard(null) : close(false); } };
  document.addEventListener("keydown", onKey, true);
  closeBtn.focus({ preventScroll: true });

  // ---- конструктор созвездия (только владелец)
  async function editor() {
    let meta;
    try { meta = await api.get("/api/me/constellation"); } catch (e) { return toastError(e); }
    let list = meta.items.map((i) => ({ kind: i.kind, value: i.url && !i.handle ? i.url : (i.handle || i.url || "") }));
    let style = meta.styles.includes(cur.style) ? cur.style : meta.style;
    const GROUPS = { social: "Соцсети", games: "Игры", dev: "Разработка", media: "Контент" };
    const rows = h("div.cst-ed-list");
    const styleSeg = h("div.segmented", { role: "group", "aria-label": "Стиль созвездия" });
    const paintStyle = () => styleSeg.replaceChildren(...meta.styles.map((s) => h("button", { type: "button", "aria-pressed": String(s === style), onclick: () => { style = s; paintStyle(); } }, STYLE_NAMES[s] || s)));
    const label = (k) => (WORLDS[k]?.label) || meta.kinds.find((x) => x.kind === k)?.label || k;
    const paintRows = () => rows.replaceChildren(...(list.length ? list.map((it, i) => {
      const w = WORLDS[it.kind] || WORLDS.website;
      const krug = KRUG.includes(it.kind);
      const inp = krug ? h("span.muted", "Считается само") : h("input.input", { value: it.value, placeholder: meta.kinds.find((x) => x.kind === it.kind)?.needs_url ? "https://…" : "ник или ссылка", "aria-label": `${label(it.kind)}: ник или ссылка`,
        oninput: (e) => { it.value = e.target.value; } });
      return h("div.cst-ed-row", body(w, it.kind), h("b", label(it.kind)), inp,
        h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Убрать ${label(it.kind)}`, onclick: () => { list.splice(i, 1); paintRows(); } }, icon("x", "sm")));
    }) : [h("p.muted", "Пока пусто — выберите миры ниже.")]));
    const add = (kind) => { if (list.length >= 12) return toast("Не больше 12 миров", { error: true }); if (KRUG.includes(kind) && list.some((x) => x.kind === kind)) return; list.push({ kind, value: "" }); paintRows(); rows.lastElementChild?.querySelector("input")?.focus(); };
    const picker = h("div.cst-ed-pick",
      h("div.cst-ed-group", h("small", "Круг"), h("div.chips", ...KRUG.map((k) => h("button.chip", { type: "button", onclick: () => add(k) }, WORLDS[k].label)))),
      ...Object.entries(GROUPS).map(([g, t]) => h("div.cst-ed-group", h("small", t),
        h("div.chips", ...meta.kinds.filter((k) => k.group === g).map((k) => h("button.chip", { type: "button", onclick: () => add(k.kind) }, k.label))))));
    paintStyle(); paintRows();
    const save = h("button.btn.primary", { type: "button" }, "Сохранить");
    const m = modal({ title: "Ваше созвездие", body: h("div.stack", h("div.look-row", h("span", "Стиль"), styleSeg), rows, picker),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save] });
    save.addEventListener("click", () => busy(save, async () => {
      try {
        cur = await api.put("/api/me/constellation", { style, items: list });
        m.close();
        paint();
        document.dispatchEvent(new CustomEvent("constellation:changed", { detail: cur }));
      } catch (e) { toastError(e); }
    }));
  }
  edit?.addEventListener("click", editor);
  return { close };
}

/** Мини-превью созвездия для блока в профиле */
export function constellationBlock(user, data, isMe) {
  const items = data?.items || [];
  if (!items.length && !isMe) return null;
  const strip = h("div.cst-strip", ...items.slice(0, 8).map((it) => {
    const info = worldInfo(it, user);
    return h("span.cst-strip-w", { title: info.title }, body(info.w, it.kind));
  }));
  const open = h("button.cst-block", { type: "button" },
    h("div.grow", h("b", "Созвездие ✦"), h("small", items.length ? `${pl(items.length, ["мир", "мира", "миров"])} на орбитах` : "Соберите свою вселенную")), strip);
  open.addEventListener("click", () => openConstellation(user, data || { style: "cosmos", items: [] }, isMe, open));
  return h("section.card.cst-block-card", open);
}

export { WORLDS, navigate, state };
