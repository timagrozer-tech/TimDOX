// Панель «Смайлики / Стикеры» для чата: категории эмодзи, наборы стикеров, недавние.
import { api, on, emit } from "../api.js";
import { h, icon } from "../dom.js";
import { navigate } from "../router.js";

export const EMOJI_CATS = [
  ["😀", "Смайлы", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩 😺 😸 😹 😻 😼 😽 🙀 😿 😾"],
  ["👍", "Жесты", "👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🦾 🫶 👀 👁 👄 💋 🧠 🫀"],
  ["❤️", "Сердца", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🌈"],
  ["🐱", "Природа", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🐠 🦈 🌸 🌹 🌻 🌷 🌼 🍀 🌿 🌵 🌴 🍁 🍂 🌙 ☀️ ⛅ 🌧 ❄️ ☃️ 🌊"],
  ["🍕", "Еда", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🥔 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🍝 🍜 🍣 🍱 🥟 🍦 🍰 🎂 🧁 🍫 🍬 🍩 🍪 ☕ 🍵 🧃 🥤 🍺 🍷 🥂"],
  ["⚽", "Занятия", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🥊 🎿 ⛸ 🏂 🏋️ 🚴 🏊 🧘 🎯 🎮 🕹 🎲 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 🎻 🎉 🎊 🎁 🎈 🏆 🥇 📸 📚 ✏️ 💻 📱 🚗 ✈️ 🚀 🏔 🏖 🏕 🗺"],
];

let cache = null;
on("stickers-changed", () => { cache = null; });

export async function loadStickers(force = false) {
  if (!cache || force) cache = (await api.get("/api/stickers")).packs;
  return cache;
}

function recent() {
  try { return JSON.parse(localStorage.getItem("krug-recent-stickers") || "[]"); } catch { return []; }
}
export function rememberSticker(s) {
  try {
    const list = [s, ...recent().filter((x) => x.id !== s.id)].slice(0, 16);
    localStorage.setItem("krug-recent-stickers", JSON.stringify(list));
  } catch { /* приватный режим */ }
}

/** Открывает панель над полем ввода. onEmoji(e), onSticker(sticker). */
export function openPanel(host, { onEmoji, onSticker, tab = "emoji" }) {
  const existing = host.querySelector(".sp-panel");
  if (existing) { existing.remove(); return; }
  let current = tab;
  const body = h("div.sp-body");
  const tabs = h("div.sp-tabs", { role: "tablist" });
  const panel = h("div.sp-panel", { role: "dialog", "aria-label": "Смайлики и стикеры" }, tabs, body);
  host.append(panel);

  const paintTabs = () => tabs.replaceChildren(
    h("button", { type: "button", role: "tab", "aria-selected": String(current === "emoji"), onclick: () => { current = "emoji"; paint(); } }, icon("smile", "sm"), "Смайлики"),
    h("button", { type: "button", role: "tab", "aria-selected": String(current === "stickers"), onclick: () => { current = "stickers"; paint(); } }, icon("sticker", "sm"), "Стикеры"),
    h("div.spacer"),
    h("button.sp-manage", { type: "button", title: "Мои наборы стикеров", "aria-label": "Мои наборы стикеров", onclick: () => { close(); navigate("/stickers"); } }, icon("settings", "sm")));

  function paintEmoji() {
    const nav = h("div.sp-cats");
    const grid = h("div.sp-scroll");
    EMOJI_CATS.forEach(([ic, name, list], i) => {
      const sec = h("section", { id: `sp-cat-${i}` }, h("h4", name),
        h("div.sp-emoji", list.split(" ").map((e) => h("button", { type: "button", "aria-label": e, onclick: () => onEmoji(e) }, e))));
      grid.append(sec);
      nav.append(h("button", { type: "button", title: name, "aria-label": name, onclick: () => sec.scrollIntoView({ block: "start", behavior: "smooth" }) }, ic));
    });
    body.replaceChildren(grid, nav);
  }

  async function paintStickers() {
    body.replaceChildren(h("div.sp-loading", h("div.spinner")));
    let packs;
    try { packs = await loadStickers(); } catch (e) { body.replaceChildren(h("p.muted.sp-empty", e.message)); return; }
    const grid = h("div.sp-scroll");
    const nav = h("div.sp-cats.packs");
    const rec = recent();
    const sticker = (s) => h("button.sp-sticker", { type: "button", title: s.emoji, "aria-label": `Стикер ${s.emoji}`, onclick: () => { rememberSticker(s); onSticker(s); } },
      h("img", { src: s.url, alt: s.emoji, loading: "lazy", draggable: false }));
    if (rec.length) {
      const sec = h("section", h("h4", "Недавние"), h("div.sp-stickers", rec.map(sticker)));
      grid.append(sec);
      nav.append(h("button", { type: "button", title: "Недавние", onclick: () => sec.scrollIntoView({ behavior: "smooth" }) }, "🕘"));
    }
    for (const p of packs) {
      const sec = h("section", h("h4", p.title), p.stickers.length ? h("div.sp-stickers", p.stickers.map(sticker))
        : h("p.muted.sp-empty", p.mine ? "Набор пуст — добавьте стикеры в «Мои наборы»" : "Пусто"));
      grid.append(sec);
      nav.append(h("button", { type: "button", title: p.title, "aria-label": p.title, onclick: () => sec.scrollIntoView({ behavior: "smooth" }) },
        p.stickers[0] ? h("img", { src: p.stickers[0].url, alt: "" }) : "📦"));
    }
    nav.append(h("button.sp-add", { type: "button", title: "Создать набор", "aria-label": "Создать набор", onclick: () => { close(); navigate("/stickers?new=1"); } }, icon("plus", "sm")));
    body.replaceChildren(grid, nav);
  }

  function paint() { paintTabs(); if (current === "emoji") paintEmoji(); else paintStickers(); }
  paint();

  const onDoc = (e) => { if (!panel.contains(e.target) && !e.target.closest(".sp-toggle")) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    panel.remove();
    document.removeEventListener("pointerdown", onDoc);
    document.removeEventListener("keydown", onKey);
  }
  setTimeout(() => { document.addEventListener("pointerdown", onDoc); document.addEventListener("keydown", onKey); });
  return { close };
}

export { emit };
