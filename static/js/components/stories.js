// Истории на 24 часа: лента кружков, просмотр на весь экран, создание.
import { api, state } from "../api.js";
import { h, icon, avatar, timeAgo, pl } from "../dom.js";
import { modal, toast, toastError, busy, confirmDialog, promptDialog, trackOverlay } from "../ui.js";
import { navigate } from "../router.js";
import { report } from "./post.js";
import { BACKGROUNDS, FONTS, MODES, COLORS, loadStoryFonts, defaultStyle, applyTextStyle, textNode, stickerNode, place, renderStory } from "./storykit.js";

export { BACKGROUNDS };
const DURATION = 5000;

/** Полоса историй над лентой */
export function storiesBar() {
  const strip = h("div.stories-strip", { role: "list", "aria-label": "Истории" });
  const card = h("section.card.stories-card", strip);
  card._reload = () => load();
  let groups = [];

  async function load() {
    try {
      groups = (await api.get("/api/stories")).groups;
    } catch { groups = []; }
    draw();
  }
  function draw() {
    const mine = groups.find((g) => g.is_me);
    const items = [h("div.story-item", { role: "listitem" },
      h("button.story-ring.add", { type: "button", "aria-label": "Добавить историю", onclick: () => createStory(load) },
        avatar(state.me, "lg", { presence: false }), h("span.story-plus", icon("plus", "sm"))),
      h("span.story-name", "Добавить"))];
    if (mine) {
      items[0] = h("div.story-item", { role: "listitem" },
        h("button.story-ring.seen", { type: "button", "aria-label": "Мои истории", onclick: () => openViewer(groups, groups.indexOf(mine), load) },
          avatar(state.me, "lg", { presence: false })),
        h("span.story-name", "Вы"),
        h("button.story-add-mini", { type: "button", "aria-label": "Добавить ещё историю", onclick: () => createStory(load) }, icon("plus", "sm")));
    }
    groups.filter((g) => !g.is_me).forEach((g) => {
      items.push(h("div.story-item", { role: "listitem" },
        h(`button.story-ring${g.has_unseen ? "" : ".seen"}`, { type: "button", "aria-label": `Истории: ${g.user.name}`, onclick: () => openViewer(groups, groups.indexOf(g), load) },
          avatar(g.user, "lg", { presence: false })),
        h("span.story-name", g.user.name.split(" ")[0])));
    });
    strip.replaceChildren(...items);
  }
  load();
  return card;
}

/** Просмотр историй: прогресс-бары, автоматическое листание, ответ в личку */
export function openViewer(groups, gi, onChange) {
  let g = gi, s = 0, timer = null, started = 0, elapsed = 0, paused = false, waiting = false;
  const first = groups[g].stories.findIndex((x) => !x.seen);
  if (first > 0 && !groups[g].is_me) s = first;

  const bars = h("div.sv-bars");
  const head = h("div.sv-head");
  const stage = h("div.sv-stage");
  const foot = h("div.sv-foot");
  const box = h("div.story-viewer", { role: "dialog", "aria-label": "Просмотр историй" },
    h("div.sv-frame", bars, head, stage, foot,
      h("button.sv-nav.prev", { type: "button", "aria-label": "Предыдущая", onclick: () => go(-1) }),
      h("button.sv-nav.next", { type: "button", "aria-label": "Следующая", onclick: () => go(1) })));

  // касание истории: слева — назад, справа — вперёд; удержание — пауза
  let downAt = 0;
  stage.addEventListener("pointerdown", (e) => { if (e.button > 0) return; downAt = Date.now(); pause(); });
  stage.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const held = Date.now() - downAt;
    downAt = 0;
    if (e.target.closest("a") || held > 300) return resume();
    const r = stage.getBoundingClientRect();
    go(e.clientX - r.left < r.width * .33 ? -1 : 1);
  });
  stage.addEventListener("pointercancel", () => { downAt = 0; resume(); });

  function current() { return groups[g].stories[s]; }
  function render() {
    const grp = groups[g], st = current();
    bars.replaceChildren(...grp.stories.map((_, i) => h("span.sv-bar", h("i", { style: { width: i < s ? "100%" : "0%" } }))));
    head.replaceChildren(
      h("a", { href: grp.is_me ? `/u/${state.me.username}` : `/u/${grp.user.username}`, onclick: close }, avatar(grp.user, "sm", { presence: false })),
      h("div.grow", h("b", grp.is_me ? "Вы" : grp.user.name), h("small", timeAgo(st.created_at))),
      grp.is_me ? h("button.sv-round", { type: "button", "aria-label": "Удалить историю", title: "Удалить историю", onclick: remove }, icon("trash", "sm"))
        : h("button.sv-round", { type: "button", "aria-label": "Пожаловаться на историю", title: "Пожаловаться", onclick: () => { pause(); report("story", st.id); } }, icon("flag", "sm")),
      h("button.sv-round", { type: "button", "aria-label": "Закрыть", title: "Закрыть", onclick: close }, icon("x", "sm")));
    renderStory(stage, st, { onNavigate: close });
    const photo = stage.querySelector(".st-photo");
    waiting = !!(photo && !photo.complete);
    if (waiting) {
      clearTimeout(timer);
      const go0 = () => { if (waiting && current() === st) { waiting = false; start(); } };
      photo.addEventListener("load", go0, { once: true });
      photo.addEventListener("error", go0, { once: true });
    }
    if (grp.is_me) {
      const btn = h("button.btn.sm.sv-viewers", { type: "button" }, icon("eye", "sm"), "Просмотры");
      btn.addEventListener("click", () => showViewers(st));
      foot.replaceChildren(btn);
    } else {
      const input = h("input.input", { placeholder: `Ответить ${grp.user.name.split(" ")[0]}…`, maxlength: 1000, "aria-label": "Ответ на историю" });
      input.addEventListener("focus", pause);
      input.addEventListener("blur", resume);
      const form = h("form.sv-reply", {
        onsubmit: async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          try {
            await api.post(`/api/stories/${st.id}/reply`, { text });
            input.value = "";
            toast("Ответ отправлен в личные сообщения", { icon: "send" });
            input.blur();
          } catch (err) { toastError(err); }
        },
      }, input, h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить" }, icon("send", "sm")));
      foot.replaceChildren(form);
      if (!st.seen) {
        st.seen = true;
        api.post(`/api/stories/${st.id}/view`).catch(() => {});
      }
    }
    if (!waiting) start();
  }
  function start() {
    clearTimeout(timer);
    elapsed = 0; started = Date.now(); paused = false;
    animate();
    timer = setTimeout(() => go(1), DURATION);
  }
  function animate() {
    const bar = bars.children[s]?.firstChild;
    if (!bar) return;
    bar.style.transition = "none";
    bar.style.width = `${(elapsed / DURATION) * 100}%`;
    requestAnimationFrame(() => {
      bar.style.transition = `width ${DURATION - elapsed}ms linear`;
      bar.style.width = "100%";
    });
  }
  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    elapsed += Date.now() - started;
    const bar = bars.children[s]?.firstChild;
    if (bar) { bar.style.transition = "none"; bar.style.width = `${(elapsed / DURATION) * 100}%`; }
  }
  function resume() {
    if (!paused) return;
    paused = false;
    started = Date.now();
    animate();
    timer = setTimeout(() => go(1), DURATION - elapsed);
  }
  function go(d) {
    s += d;
    if (s >= groups[g].stories.length) { groups[g].has_unseen = false; g++; s = 0; }
    else if (s < 0) { g--; s = g >= 0 ? groups[g].stories.length - 1 : 0; }
    if (g < 0 || g >= groups.length) return close();
    render();
  }
  async function remove() {
    pause();
    if (!await confirmDialog({ title: "Удалить историю?", text: "Её больше никто не увидит.", confirm: "Удалить", danger: true })) return resume();
    try {
      await api.del(`/api/stories/${current().id}`);
      groups[g].stories.splice(s, 1);
      if (!groups[g].stories.length) { groups.splice(g, 1); return close(); }
      s = Math.min(s, groups[g].stories.length - 1);
      render();
    } catch (e) { toastError(e); resume(); }
  }
  async function showViewers(st) {
    pause();
    const list = h("div.sv-panel-list", h("div.spinner"));
    const panel = h("div.sv-panel", { role: "dialog", "aria-label": "Просмотры" },
      h("div.sv-panel-head", h("b", "Просмотры"), h("button.sv-round", { type: "button", "aria-label": "Закрыть", onclick: () => { panel.remove(); resume(); } }, icon("x", "sm"))),
      list);
    box.querySelector(".sv-frame").append(panel);
    try {
      const { items, total } = await api.get(`/api/stories/${st.id}/viewers`);
      panel.querySelector(".sv-panel-head b").textContent = total ? `Просмотры · ${total}` : "Просмотры";
      list.replaceChildren(...(items.length ? items.map((u) => h("a.mini-person", { href: `/u/${u.username}`, onclick: close }, avatar(u, "sm"),
        h("div.who", h("span.name", u.name), h("span.sub", timeAgo(u.viewed_at))))) : [h("div.sv-empty", icon("eye"), h("p", "Пока никто не посмотрел"))]));
    } catch (e) { list.replaceChildren(h("p.sv-empty", e.message)); }
  }
  const onKey = (e) => {
    if (document.activeElement?.tagName === "INPUT" || document.querySelector(".modal-backdrop")) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === " ") { e.preventDefault(); paused ? resume() : pause(); }
  };
  let done = null;
  function close() {
    if (!box.isConnected) return;
    clearTimeout(timer);
    box.remove();
    done?.();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onHidden);
    document.body.style.overflow = "";
    onChange?.();
  }
  const onHidden = () => { if (document.hidden) pause(); else if (!box.querySelector(".sv-panel")) resume(); };
  document.addEventListener("visibilitychange", onHidden);
  document.addEventListener("keydown", onKey);
  done = trackOverlay(close);
  loadStoryFonts();
  document.body.append(box);
  document.body.style.overflow = "hidden";
  render();
}

const EMOJI = "😀 😂 😍 🥰 😎 🤩 🥳 😭 😡 🤯 👍 🙏 👏 🔥 ✨ 💯 ❤️ 💔 💫 🌈 ☀️ 🌙 ⭐ 🎉 🎂 🍕 ☕ 🍓 🌸 🐱 🐶 🦊 ⚽ 🎮 🎧 📸 ✈️ 🏖 🏔 🚀".split(" ");
const clamp = (v) => Math.min(.94, Math.max(.06, v));
const ALIGN = [["center", "По центру"], ["left", "Слева"], ["right", "Справа"]];

/** Редактор истории: фон или фото, текст с оформлением, стикеры. Текст и стикеры двигаются пальцем,
 *  а чтобы убрать — перетащите их в корзину сверху. */
export function createStory(onDone) {
  loadStoryFonts();
  const style = defaultStyle(false);
  let text = "", bg = "blue", file = null, url = null, tab = "text", visibility = "friends";

  const stage = h("div.se-stage");
  const trash = h("div.se-trash", { "aria-hidden": "true" }, icon("trash"));
  const panelBody = h("div.se-panel-body");
  const tabs = h("div.se-tabs", { role: "tablist" });
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
  const visBtn = h("button.se-pill", { type: "button", onclick: () => { visibility = visibility === "friends" ? "public" : "friends"; paintVis(); } });
  const paintVis = () => visBtn.replaceChildren(icon(visibility === "friends" ? "users" : "globe", "sm"), visibility === "friends" ? "Друзья" : "Все");
  paintVis();
  const publish = h("button.se-publish", { type: "button" }, "Поделиться", icon("send", "sm"));
  const frame = h("div.se-frame",
    h("div.se-top",
      h("button.sv-round", { type: "button", "aria-label": "Закрыть", onclick: () => tryClose() }, icon("x", "sm")),
      h("div.spacer"), visBtn),
    h("div.se-stage-wrap", stage, trash),
    h("div.se-panel", tabs, panelBody),
    h("div.se-bottom", h("span.se-note", "Исчезнет через 24 часа"), publish),
    fileInput);
  const box = h("div.story-editor", { role: "dialog", "aria-label": "Новая история" }, frame);

  // ---------------------------------------------------------------- перетаскивание
  function draggable(el, obj, { onTap, onDelete }) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, ox = obj.x ?? .5, oy = obj.y ?? .5;
      let moved = false;
      el.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        frame.classList.add("dragging");
        obj.x = clamp(ox + dx / r.width); obj.y = clamp(oy + dy / r.height);
        place(el, obj);
        const tr = trash.getBoundingClientRect();
        const over = ev.clientY < tr.bottom + 24 && Math.abs(ev.clientX - (tr.left + tr.width / 2)) < 70;
        trash.classList.toggle("over", over); el.classList.toggle("to-trash", over);
      };
      const up = () => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
        frame.classList.remove("dragging");
        if (!moved) return onTap?.();
        if (trash.classList.contains("over")) { trash.classList.remove("over"); navigator.vibrate?.(15); onDelete?.(); }
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }

  // ---------------------------------------------------------------- холст
  function paintStage() {
    stage.style.background = file ? "#000" : BACKGROUNDS[bg];
    const nodes = [];
    if (file) nodes.push(h("img.st-photo", { src: url, alt: "" }));
    const t = text ? textNode(text, style) : h("div.st-text.st-placeholder", "Нажмите, чтобы написать");
    if (!text) { applyTextStyle(t, { ...style, mode: "plain" }); place(t, style); }
    draggable(t, style, { onTap: editText, onDelete: () => { text = ""; paintStage(); } });
    nodes.push(t);
    style.stickers.forEach((s, i) => {
      const el = stickerNode(s, { interactive: false });
      draggable(el, s, {
        onTap: () => { s.v = ((s.v || 0) + 1) % 3; paintStage(); }, // нажатие меняет вид стикера
        onDelete: () => { style.stickers.splice(i, 1); paintStage(); },
      });
      nodes.push(el);
    });
    const editing = stage.querySelector(".se-editing");
    stage.replaceChildren(...nodes, ...(editing ? [editing] : []));
  }

  // ---------------------------------------------------------------- ввод текста поверх холста
  function editText() {
    const ta = h("textarea.st-text.se-input", { maxlength: 300, rows: 1, placeholder: "Текст истории", "aria-label": "Текст истории" });
    ta.value = text;
    applyTextStyle(ta, style);
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; };
    const layer = h("div.se-editing", ta,
      h("button.se-done", { type: "button", onclick: () => finish() }, "Готово"));
    const finish = () => { text = ta.value.trim(); layer.remove(); stage.classList.remove("is-editing"); paintStage(); };
    layer.addEventListener("pointerdown", (e) => { if (e.target === layer) finish(); });
    ta.addEventListener("input", grow);
    stage.append(layer);
    stage.classList.add("is-editing");
    requestAnimationFrame(() => { grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    layer._restyle = () => { applyTextStyle(ta, style); grow(); };
  }
  const restyle = () => { stage.querySelector(".se-editing")?._restyle(); paintStage(); };

  // ---------------------------------------------------------------- панели
  const chip = (label, on, onclick, extra = {}) => h(`button.se-chip${on ? ".on" : ""}`, { type: "button", onclick, ...extra }, label);
  const row = (title, ...items) => h("div.se-row", h("span.se-row-title", title), h("div.se-row-items", ...items));

  function textPanel() {
    return [
      row("Шрифт", ...Object.entries(FONTS).map(([k, f]) => chip(f.label, style.font === k, () => { style.font = k; restyle(); drawPanel(); },
        { style: { fontFamily: f.css, fontWeight: String(f.weight) } }))),
      row("Стиль", ...Object.entries(MODES).map(([k, label]) => {
        const sample = h(`span.se-mode-sample.st-mode-${k}`, "Aa");
        sample.style.setProperty("--st-c", style.color); sample.style.setProperty("--st-k", style.color === "#ffffff" ? "#111111" : "#ffffff");
        return h(`button.se-chip.se-mode${style.mode === k ? ".on" : ""}`, { type: "button", onclick: () => { style.mode = k; restyle(); drawPanel(); } }, sample, label);
      })),
      row("Цвет", ...COLORS.map((c) => h(`button.se-color${style.color === c ? ".on" : ""}`, { type: "button", "aria-label": `Цвет ${c}`,
        style: { background: c }, onclick: () => { style.color = c; restyle(); drawPanel(); } }))),
      h("div.se-row.se-row-inline",
        h("button.se-chip", { type: "button", onclick: () => {
          const i = ALIGN.findIndex(([a]) => a === style.align);
          style.align = ALIGN[(i + 1) % ALIGN.length][0]; restyle(); drawPanel();
        } }, `Выравнивание: ${ALIGN.find(([a]) => a === style.align)[1].toLowerCase()}`),
        h("label.se-size", "Размер", h("input", { type: "range", min: 16, max: 64, value: style.size, oninput: (e) => { style.size = +e.target.value; restyle(); } }))),
      h("button.se-chip.se-wide", { type: "button", onclick: editText }, icon("edit", "sm"), text ? "Изменить текст" : "Написать текст"),
    ];
  }

  function bgPanel() {
    return [
      h("div.se-row.se-row-inline",
        h("button.se-chip.on", { type: "button", onclick: () => fileInput.click() }, icon("image", "sm"), file ? "Другое фото" : "Фото из галереи"),
        file ? h("button.se-chip", { type: "button", onclick: () => { URL.revokeObjectURL(url); file = null; url = null; paintStage(); drawPanel(); } }, icon("x", "sm"), "Убрать фото") : null),
      h("div.se-bg-grid", Object.entries(BACKGROUNDS).map(([k, v]) => h(`button.se-bg${!file && bg === k ? ".on" : ""}`, { type: "button", "aria-label": `Фон ${k}`,
        style: { background: v }, onclick: () => { bg = k; if (file) { URL.revokeObjectURL(url); file = null; url = null; } paintStage(); drawPanel(); } }))),
    ];
  }

  function addSticker(s) {
    if (style.stickers.length >= 8) return toast("Не больше 8 стикеров", { error: true });
    const spots = [[.5, .2], [.5, .72], [.28, .32], [.72, .6], [.7, .25], [.3, .82], [.5, .9], [.5, .1]];
    const [x, y] = spots[style.stickers.length % spots.length];
    style.stickers.push({ x, y, v: 0, ...s });
    paintStage();
    navigator.vibrate?.(8);
  }
  async function addLink() {
    const raw = await promptDialog({ title: "Ссылка", label: "Адрес страницы", placeholder: "https://…", confirm: "Дальше" });
    if (!raw) return;
    const link = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try { new URL(link); } catch { return toast("Это не похоже на ссылку", { error: true }); }
    const label = await promptDialog({ title: "Подпись к ссылке", label: "Необязательно — например, «Мой канал»", confirm: "Добавить" });
    if (label === null) return;
    addSticker({ type: "link", url: link, label: label || new URL(link).hostname.replace(/^www\./, "") });
  }
  async function addMention() {
    let friends = [];
    try { friends = (await api.get(`/api/users/${state.me.username}/friends`)).items; } catch (e) { return toastError(e); }
    const q = h("input.input", { type: "search", placeholder: "Поиск по имени", "aria-label": "Поиск по имени" });
    const list = h("div.pick-list");
    const m = modal({ title: "Отметить человека", narrow: true, body: h("div.stack", q, list) });
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      const items = friends.filter((f) => !s || f.name.toLowerCase().includes(s) || f.username.includes(s));
      list.replaceChildren(...(items.length ? items.map((f) => h("button.mini-person", { type: "button", onclick: () => { m.close(); addSticker({ type: "mention", username: f.username, name: f.name }); } },
        avatar(f, "sm", { presence: false }), h("div.who", h("span.name", f.name), h("span.sub", `@${f.username}`)))) : [h("p.muted", "Никого не нашли")]));
    };
    q.addEventListener("input", draw);
    draw();
  }
  async function addTag() {
    const t = await promptDialog({ title: "Хэштег", placeholder: "лето", confirm: "Добавить" });
    const tag = (t || "").replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 40);
    if (tag) addSticker({ type: "tag", tag });
  }
  function stickersPanel() {
    const now = new Date();
    return [
      h("div.se-sticker-btns",
        h("button.se-chip.on", { type: "button", onclick: addLink }, icon("link", "sm"), "Ссылка"),
        h("button.se-chip", { type: "button", onclick: addMention }, icon("at", "sm"), "Упоминание"),
        h("button.se-chip", { type: "button", onclick: addTag }, icon("hash", "sm"), "Хэштег"),
        h("button.se-chip", { type: "button", onclick: () => addSticker({ type: "time", text: now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) }) }, "🕒 Время"),
        h("button.se-chip", { type: "button", onclick: () => addSticker({ type: "date", text: now.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) }) }, "📅 Дата")),
      h("div.se-emoji-grid", EMOJI.map((e) => h("button", { type: "button", onclick: () => addSticker({ type: "emoji", e }) }, e))),
      h("p.se-hint", "Стикеры можно двигать пальцем. Нажмите на стикер — поменяется его вид, перетащите в корзину — удалится."),
    ];
  }

  const TABS = [["text", "Текст", "edit"], ["bg", "Фон", "image"], ["stickers", "Стикеры", "sticker"]];
  function drawPanel() {
    tabs.replaceChildren(...TABS.map(([id, label, ic]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === id),
      onclick: () => { tab = id; drawPanel(); } }, icon(ic, "sm"), label)));
    panelBody.replaceChildren(...(tab === "text" ? textPanel() : tab === "bg" ? bgPanel() : stickersPanel()));
  }

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast("Файл больше 10 МБ", { error: true });
    if (url) URL.revokeObjectURL(url);
    file = f; url = URL.createObjectURL(f);
    if (!text) style.y = .8;
    paintStage(); drawPanel();
  });

  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) tryClose(); };
  let done = null;
  function close() {
    if (!box.isConnected) return;
    box.remove();
    done?.();
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    if (url) URL.revokeObjectURL(url);
  }
  const dirty = () => !!(text || file || style.stickers.length);
  async function tryClose(fromBack = false) {
    if (dirty() && !await confirmDialog({ title: "Выйти без публикации?", text: "История не сохранится.", confirm: "Выйти", danger: true })) {
      if (fromBack) done = trackOverlay(() => tryClose(true)); // «Назад» уже сработал — снова ставим окно в историю
      return;
    }
    close();
  }

  publish.addEventListener("click", () => busy(publish, async () => {
    stage.querySelector(".se-editing .se-done")?.click();
    if (!file && !text && !style.stickers.length) return toast("Добавьте текст, фото или стикер", { error: true });
    const fd = new FormData();
    if (file) fd.append("photo", file);
    fd.append("text", text);
    fd.append("background", bg);
    fd.append("visibility", visibility);
    fd.append("style", JSON.stringify(style));
    try {
      await api.form("/api/stories", fd);
      close();
      toast("История опубликована на 24 часа", { icon: "check" });
      onDone?.();
    } catch (e) { toastError(e); }
  }));

  document.addEventListener("keydown", onKey);
  document.body.append(box);
  document.body.style.overflow = "hidden";
  done = trackOverlay(() => tryClose(true));
  paintStage();
  drawPanel();
}


export { navigate };
