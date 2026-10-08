// Панель «Эмодзи / Стикеры / GIF» — открывается мгновенно (коллекция кэшируется в браузере и сверяется с сервером по ETag),
// наборы рисуются лениво по мере прокрутки, анимации играют только на экране. Поиск понимает слова: «кот» найдёт котов.
// Долгое нажатие (или правый клик) на стикере — избранное, реакции, папки, ремикс, открыть набор.
import { api, on, emit, state } from "../api.js";
import { h, icon } from "../dom.js";
import { navigate } from "../router.js";
import { toast, toastError, showMenu, promptDialog } from "../ui.js";
import { stickerEl } from "./stickerview.js";

export const EMOJI_CATS = [
  ["😀", "Смайлы", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩 😺 😸 😹 😻 😼 😽 🙀 😿 😾"],
  ["👍", "Жесты", "👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🦾 🫶 👀 👁 👄 💋 🧠 🫀"],
  ["❤️", "Сердца", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🌈"],
  ["🐱", "Природа", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🐠 🦈 🌸 🌹 🌻 🌷 🌼 🍀 🌿 🌵 🌴 🍁 🍂 🌙 ☀️ ⛅ 🌧 ❄️ ☃️ 🌊"],
  ["🍕", "Еда", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🥔 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🍝 🍜 🍣 🍱 🥟 🍦 🍰 🎂 🧁 🍫 🍬 🍩 🍪 ☕ 🍵 🧃 🥤 🍺 🍷 🥂"],
  ["⚽", "Занятия", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🥊 🎿 ⛸ 🏂 🏋️ 🚴 🏊 🧘 🎯 🎮 🕹 🎲 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 🎻 🎉 🎊 🎁 🎈 🏆 🥇 📸 📚 ✏️ 💻 📱 🚗 ✈️ 🚀 🏔 🏖 🏕 🗺"],
];

// ---------------------------------------------------------------- данные коллекции: память → localStorage → сервер (ETag)
const LS = "krug-stickers-v2";
let cache = null;
let inflight = null;
on("stickers-changed", () => { cache = null; try { localStorage.removeItem(LS); } catch { /* приватный режим */ } });

function readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "null");
    return raw && raw.uid === state.me?.id ? raw : null;
  } catch { return null; }
}

/** Коллекция целиком. С кэшем отвечает сразу, а свежие данные подтягивает в фоне (onFresh вызовется, если что-то поменялось). */
export async function loadCollection({ force = false, onFresh = null } = {}) {
  if (!force && cache) return cache.data;
  const local = !force ? readLocal() : null;
  const fetchFresh = () => (inflight ||= (async () => {
    try {
      const res = await fetch("/api/stickers", { credentials: "same-origin", headers: local?.etag ? { "If-None-Match": local.etag } : {} });
      if (res.status === 304 && local) { cache = local; return local.data; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Не удалось загрузить стикеры");
      const data = await res.json();
      cache = { uid: state.me?.id, etag: res.headers.get("etag"), data };
      try { localStorage.setItem(LS, JSON.stringify(cache)); } catch { /* места нет — не страшно */ }
      return data;
    } finally { inflight = null; }
  })());
  if (local) {
    cache = local;
    fetchFresh().then((d) => { if (d !== local.data) onFresh?.(d); }).catch(() => {});
    return local.data;
  }
  return fetchFresh();
}

/** Совместимость со старым кодом */
export async function loadStickers(force = false) { return (await loadCollection({ force })).packs; }
export function rememberSticker(s) {
  if (!cache) return;
  const d = cache.data;
  d.recent = [s, ...(d.recent || []).filter((x) => x.id !== s.id)].slice(0, 32);
  try { localStorage.setItem(LS, JSON.stringify(cache)); } catch { /* ок */ }
}

// ---------------------------------------------------------------- действия со стикером
export function stickerActions(anchor, s, { onRemix, close } = {}) {
  const d = cache?.data;
  const fav = d?.favorites?.some((x) => x.id === s.id);
  const reac = d?.reactions?.some((x) => x.id === s.id);
  const toggle = async (kind) => {
    try {
      const r = await api.post(`/api/stickers/${s.id}/save`, { kind });
      toast(r.saved ? (kind === "fav" ? "В избранном ⭐" : "Теперь это ваша реакция 💬") : "Убрано", { icon: "check", duration: 1400 });
      emit("stickers-changed");
    } catch (e) { toastError(e); }
  };
  const toFolder = async () => {
    const folders = d?.folders || [];
    showMenu(anchor, [
      ...folders.map((f) => ({ label: `${f.emoji} ${f.title}`, onClick: async () => {
        try { await api.post(`/api/sticker-folders/${f.id}/items`, { sticker_id: s.id }); toast(`В папке «${f.title}»`, { icon: "check", duration: 1400 }); emit("stickers-changed"); } catch (e) { toastError(e); }
      } })),
      { label: "Новая папка…", icon: "plus", onClick: async () => {
        const title = await promptDialog({ title: "Новая папка стикеров", label: "Например, «Мемы» или «Для работы»", confirm: "Создать" });
        if (!title) return;
        try {
          const f = await api.post("/api/sticker-folders", { title });
          await api.post(`/api/sticker-folders/${f.id}/items`, { sticker_id: s.id });
          toast(`Папка «${title}» создана`, { icon: "check" }); emit("stickers-changed");
        } catch (e) { toastError(e); }
      } },
    ]);
  };
  showMenu(anchor, [
    { label: fav ? "Убрать из избранного" : "В избранное", icon: "star", onClick: () => toggle("fav") },
    { label: reac ? "Убрать из реакций" : "Сделать реакцией", icon: "smile", onClick: () => toggle("reaction") },
    { label: "В папку…", icon: "folder", onClick: () => setTimeout(toFolder, 30) },
    (s.format || "webp") === "webp" ? { label: "Ремикс", icon: "sparkle", onClick: () => { close?.(); (onRemix || openRemixFor)(s); } } : null,
    s.pack?.slug || s.pack_id ? { label: "Открыть набор", icon: "sticker", onClick: () => { close?.(); openPackOf(s); } } : null,
  ].filter(Boolean));
}

async function openRemixFor(s) {
  const { openRemix } = await import("./remix.js");
  openRemix(s);
}

async function openPackOf(s) {
  const slug = s.pack?.slug || cache?.data?.packs?.find((p) => p.id === s.pack_id)?.slug;
  if (!slug) return;
  const { showPackPreview } = await import("../pages/stickers.js");
  showPackPreview(slug);
}

// долгое нажатие на телефоне = правый клик на компьютере
function longPress(el, fn) {
  let t = 0, fired = false;
  el.addEventListener("pointerdown", (e) => { fired = false; if (e.pointerType !== "mouse") t = setTimeout(() => { fired = true; navigator.vibrate?.(12); fn(); }, 430); });
  ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((ev) => el.addEventListener(ev, (e) => { if (ev !== "pointermove" || Math.abs(e.movementY) > 4) clearTimeout(t); }));
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); fn(); });
  el.addEventListener("click", (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

// ---------------------------------------------------------------- панель
/**
 * Открывает панель над полем ввода.
 * onEmoji(e), onSticker(sticker), onGif(gif) — если onGif нет, вкладки GIF нет (например, в комментариях).
 * mode: "reaction" — выбрать реакцию (эмодзи или стикер).
 */
export function openPanel(host, { onEmoji, onSticker, onGif = null, tab = "emoji", mode = "" } = {}) {
  const existing = host.querySelector(".sp-panel");
  if (existing) { existing.remove(); return; }
  let current = tab;
  let query = "";
  const body = h("div.sp-body");
  const tabs = h("div.sp-tabs", { role: "tablist" });
  const search = h("input.sp-search", { type: "search", placeholder: "Поиск стикеров: кот, ура, love…", "aria-label": "Поиск стикеров", enterkeyhint: "search" });
  const panel = h(`div.sp-panel${mode ? `.mode-${mode}` : ""}`, { role: "dialog", "aria-label": mode === "reaction" ? "Выбор реакции" : "Эмодзи, стикеры и GIF" },
    tabs, h("div.sp-searchbar", icon("search", "sm"), search), body);
  host.append(panel);
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = search.value.trim(); if (query && current !== "stickers") current = "stickers"; paint(); }, 220);
  });

  const pick = (s) => { rememberSticker(s); onSticker?.(s); if (mode === "reaction") close(); };

  const TABS = [["emoji", "smile", "Эмодзи"], ["stickers", "sticker", "Стикеры"], ...(onGif ? [["gif", "image", "GIF"]] : [])];
  const paintTabs = () => tabs.replaceChildren(
    ...TABS.map(([k, ic, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(current === k), onclick: () => { current = k; query = ""; search.value = ""; paint(); } }, icon(ic, "sm"), label)),
    h("div.spacer"),
    h("button.sp-manage", { type: "button", title: "Студия стикеров: импорт, наборы, AI Lab", "aria-label": "Студия стикеров", onclick: () => { close(); navigate("/stickers"); } }, icon("settings", "sm")));

  const stickerBtn = (s) => {
    const b = h(`button.sp-sticker${s.locked ? ".locked" : ""}`, { type: "button", title: s.emoji, "aria-label": `Стикер ${s.emoji}`,
      onclick: () => (s.locked ? openPackOf(s) : pick(s)) }, stickerEl(s), s.locked ? h("span.sp-lock", "KC") : null);
    longPress(b, () => stickerActions(b, s, { close }));
    return b;
  };

  // секции рисуются лениво: пока не долистали — только заголовок и место нужной высоты
  function lazySections(scroller, sections) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const sec = e.target;
        io.unobserve(sec);
        const grid = sec.querySelector(".sp-stickers");
        grid.replaceChildren(...sec._items.map(sec._render));
        grid.style.minHeight = "";
      }
    }, { root: scroller, rootMargin: "600px 0px" });
    for (const s of sections) io.observe(s);
    panel._io?.disconnect(); panel._io = io;
  }
  const section = (title, items, render = stickerBtn, extra = null) => {
    const grid = h("div.sp-stickers", { style: { minHeight: `${Math.ceil(items.length / 5) * 78}px` } });
    const sec = h("section.sp-sec", h("h4", title, extra), grid);
    sec._items = items; sec._render = render;
    return sec;
  };

  function paintEmoji(data) {
    const nav = h("div.sp-cats");
    const grid = h("div.sp-scroll");
    const emojiPacks = (data?.packs || []).filter((p) => p.kind === "emoji" && p.stickers.length && !p.locked);
    const secs = [];
    for (const p of emojiPacks) {
      const sec = section(p.title, p.stickers, (s) => { const b = stickerBtn(s); b.classList.add("emoji-size"); return b; });
      sec.classList.add("sp-emoji-pack");
      grid.append(sec); secs.push(sec);
      nav.append(h("button", { type: "button", title: p.title, "aria-label": p.title, onclick: () => sec.scrollIntoView({ block: "start", behavior: "smooth" }) }, p.cover ? stickerEl(p.cover, { size: 26 }) : "🙂"));
    }
    EMOJI_CATS.forEach(([ic, name, list], i) => {
      const sec = h("section", { id: `sp-cat-${i}` }, h("h4", name),
        h("div.sp-emoji", list.split(" ").map((e) => h("button", { type: "button", "aria-label": e, onclick: () => { onEmoji?.(e); if (mode === "reaction") close(); } }, e))));
      grid.append(sec);
      nav.append(h("button", { type: "button", title: name, "aria-label": name, onclick: () => sec.scrollIntoView({ block: "start", behavior: "smooth" }) }, ic));
    });
    body.replaceChildren(grid, nav);
    if (secs.length) lazySections(grid, secs);
  }

  async function paintSearch() {
    const grid = h("div.sp-scroll", h("div.sp-loading", h("div.spinner")));
    body.replaceChildren(grid);
    const q = query;
    try {
      let { items } = await api.get("/api/stickers/search", { q });
      let scope = "mine";
      if (!items.length) { ({ items } = await api.get("/api/stickers/search", { q, scope: "all" })); scope = "all"; }
      if (q !== query) return;
      grid.replaceChildren(items.length
        ? h("section.sp-sec", h("h4", scope === "all" ? `Нашлось в каталоге: «${q}»` : `По запросу «${q}»`), h("div.sp-stickers", items.map(stickerBtn)))
        : h("div.sp-empty-big", h("div", "🔍"), h("p", `Ничего не нашлось по «${q}»`),
          h("button.btn.soft.sm", { type: "button", onclick: () => { close(); navigate("/stickers?tab=import"); } }, icon("download", "sm"), "Импортировать набор")));
    } catch (e) { grid.replaceChildren(h("p.muted.sp-empty", e.message)); }
  }

  function paintStickers(data) {
    if (query) { paintSearch(); return; }
    const grid = h("div.sp-scroll");
    const nav = h("div.sp-cats.packs");
    const secs = [];
    const add = (title, items, navIcon, opts = {}) => {
      if (!items?.length && !opts.always) return;
      const sec = items?.length ? section(title, items) : h("section.sp-sec", h("h4", title), h("p.muted.sp-empty", opts.empty));
      grid.append(sec);
      if (items?.length) secs.push(sec);
      nav.append(h("button", { type: "button", title, "aria-label": title, onclick: () => sec.scrollIntoView({ behavior: "smooth", block: "start" }) }, navIcon));
    };
    if (mode === "reaction") add("Мои реакции", data.reactions, "💬", { always: true, empty: "Долгое нажатие на любой стикер → «Сделать реакцией»" });
    add("Недавние", data.recent, "🕘");
    add("Избранное", data.favorites, "⭐");
    if (mode !== "reaction") add("Реакции", data.reactions, "💬");
    for (const f of data.folders || []) add(f.title, f.stickers, f.emoji || "📁");
    for (const p of data.packs) {
      if (p.kind === "emoji" && mode !== "reaction") continue;
      if (p.locked) continue;
      const items = p.stickers;
      const sec = items.length ? section(p.title, items) : h("section.sp-sec", h("h4", p.title), h("p.muted.sp-empty", p.mine ? "Набор пуст — добавьте стикеры в студии" : "Пусто"));
      grid.append(sec);
      if (items.length) secs.push(sec);
      nav.append(h("button", { type: "button", title: p.title, "aria-label": p.title, onclick: () => sec.scrollIntoView({ behavior: "smooth", block: "start" }) },
        p.cover ? stickerEl(p.cover, { size: 28 }) : "📦"));
    }
    if (!data.packs.length && !data.recent?.length) grid.append(h("div.sp-empty-big", h("div", "✨"), h("p", "Пока пусто — перенесите любимые наборы из Telegram за пару секунд")));
    nav.append(h("button.sp-add", { type: "button", title: "Импорт и создание наборов", "aria-label": "Импорт и создание наборов", onclick: () => { close(); navigate("/stickers?tab=import"); } }, icon("plus", "sm")));
    body.replaceChildren(grid, nav);
    lazySections(grid, secs);
  }

  async function paintGifs() {
    const grid = h("div.sp-scroll", h("div.sp-loading", h("div.spinner")));
    body.replaceChildren(grid);
    const file = h("input", { type: "file", accept: "image/gif,image/webp,video/webm", hidden: true });
    const addBtn = h("button.sp-gif-add", { type: "button", onclick: () => file.click() }, icon("plus"), h("span", "Добавить GIF"));
    file.addEventListener("change", async () => {
      const f = file.files[0]; file.value = "";
      if (!f) return;
      const fd = new FormData(); fd.append("file", f);
      addBtn.classList.add("busy");
      try { await api.form("/api/gifs", fd); paintGifs(); } catch (e) { toastError(e); addBtn.classList.remove("busy"); }
    });
    try {
      const { items } = await api.get("/api/gifs");
      grid.replaceChildren(h("div.sp-gifs", addBtn, file, ...items.map((g) => {
        const b = h("button.sp-gif", { type: "button", "aria-label": "Отправить GIF", onclick: () => { onGif?.(g); close(); } },
          stickerEl({ url: g.url, format: g.format === "webm" ? "webm" : "webp" }));
        longPress(b, () => showMenu(b, [{ label: "Удалить GIF", icon: "trash", danger: true, onClick: async () => {
          try { await api.del(`/api/gifs/${g.id}`); b.remove(); } catch (e) { toastError(e); }
        } }]));
        return b;
      })), items.length ? null : h("p.muted.sp-empty", "Сохраняйте сюда любимые GIF — они будут под рукой в любом чате."));
    } catch (e) { grid.replaceChildren(h("p.muted.sp-empty", e.message)); }
  }

  let data = null;
  async function paint() {
    paintTabs();
    panel.classList.toggle("on-emoji", current === "emoji");
    if (current === "gif") { paintGifs(); return; }
    if (!data) {
      body.replaceChildren(h("div.sp-loading", h("div.spinner")));
      try {
        data = await loadCollection({ onFresh: (d) => { data = d; applyLook(); if (panel.isConnected && current !== "gif") paint(); } });
        applyLook();
      } catch (e) { body.replaceChildren(h("p.muted.sp-empty", e.message)); return; }
    }
    if (current === "emoji") paintEmoji(data); else paintStickers(data);
  }
  function applyLook() {
    [...panel.classList].filter((c) => c.startsWith("theme-") || c.startsWith("open-")).forEach((c) => panel.classList.remove(c));
    if (data?.theme) panel.classList.add(`theme-${data.theme.replace("sp_theme_", "")}`);
    if (data?.open_anim) panel.classList.add(`open-${data.open_anim.replace("sp_open_", "")}`);
  }
  paint();

  const onDoc = (e) => { if (!panel.contains(e.target) && !e.target.closest(".sp-toggle") && !e.target.closest(".menu, .modal, .dialog")) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    panel._io?.disconnect();
    panel.remove();
    document.removeEventListener("pointerdown", onDoc);
    document.removeEventListener("keydown", onKey);
  }
  setTimeout(() => { document.addEventListener("pointerdown", onDoc); document.addEventListener("keydown", onKey); });
  return { close };
}

export { emit };
