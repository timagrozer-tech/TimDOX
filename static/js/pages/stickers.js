// Наборы стикеров: свои (создать, наполнить, поделиться) и добавленные чужие. Как в Telegram.
import { api, emit } from "../api.js";
import { h, icon } from "../dom.js";
import { setTitle, toast, toastError, modal, promptDialog, confirmDialog, busy } from "../ui.js";
import { EMOJI_CATS } from "../components/stickerpanel.js";

const QUICK_EMOJI = "😀 😂 😍 🥰 😎 🤔 😢 😡 😮 👍 👌 🙏 🎉 ❤️ 🔥 😴".split(" ");

function packLink(p) { return `${location.origin}/stickers/${p.slug}`; }

function copyLink(p) {
  navigator.clipboard?.writeText(packLink(p)).then(() => toast("Ссылка на набор скопирована", { icon: "link" }),
    () => toast(packLink(p)));
}

/** Окно с набором: посмотреть стикеры и добавить набор к себе */
export async function showPackPreview(slug) {
  if (!slug) return;
  const body = h("div.pack-preview", h("div.spinner"));
  const addBtn = h("button.btn.primary", { type: "button", disabled: true }, "Добавить набор");
  const m = modal({ title: "Набор стикеров", body, footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Закрыть"), addBtn] });
  try {
    const p = await api.get(`/api/sticker-packs/by-slug/${encodeURIComponent(slug)}`);
    m.dialog.setAttribute("aria-label", p.title);
    m.dialog.querySelector("h2")?.replaceChildren(p.title);
    body.replaceChildren(
      h("div.pack-head", h("b", p.title), h("small.muted", `${p.count} ${p.count % 10 === 1 && p.count % 100 !== 11 ? "стикер" : "стикеров"}${p.owner ? ` · автор ${p.owner.name}` : ""}`)),
      h("div.pack-grid", p.stickers.map((s) => h("div.pack-cell", h("img", { src: s.url, alt: s.emoji, loading: "lazy" })))));
    const paint = () => {
      addBtn.hidden = p.builtin || p.mine;
      addBtn.textContent = p.installed ? "Удалить из моих" : "Добавить набор";
      addBtn.className = `btn ${p.installed ? "outline" : "primary"}`;
    };
    paint();
    addBtn.onclick = () => busy(addBtn, async () => {
      try {
        if (p.installed) await api.del(`/api/sticker-packs/${p.id}/install`); else await api.post(`/api/sticker-packs/${p.id}/install`);
        p.installed = !p.installed;
        emit("stickers-changed");
        toast(p.installed ? `Набор «${p.title}» добавлен` : "Набор удалён", { icon: "check" });
        paint();
      } catch (e) { toastError(e); }
    });
  } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
}

function emojiPicker(current, onPick) {
  const all = EMOJI_CATS.flatMap(([, , list]) => list.split(" "));
  const m = modal({
    title: "Эмодзи для стикера", narrow: true,
    body: h("div.stack",
      h("p.muted", { style: { margin: 0 } }, "По этому эмодзи стикер будет легче найти."),
      h("div.sp-emoji.emoji-choose", all.map((e) => h(`button${e === current ? ".on" : ""}`, { type: "button", onclick: () => { m.close(); onPick(e); } }, e)))),
  });
}

async function editPack(p, onChange) {
  const grid = h("div.pack-grid.editable");
  const fileInput = h("input", { type: "file", accept: "image/png,image/webp,image/gif,image/jpeg", multiple: true, hidden: true });
  let emoji = "🙂";
  const emojiRow = h("div.quick-emoji", QUICK_EMOJI.map((e) => h("button", { type: "button", "aria-pressed": String(e === emoji), onclick: () => { emoji = e; paintEmoji(); } }, e)),
    h("button.more", { type: "button", onclick: () => emojiPicker(emoji, (e) => { emoji = e; paintEmoji(); }) }, "…"));
  const paintEmoji = () => emojiRow.querySelectorAll("button:not(.more)").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === emoji)));
  const progress = h("div.pack-progress");

  const paint = () => {
    grid.replaceChildren(
      ...p.stickers.map((s) => h("div.pack-cell",
        h("img", { src: s.url, alt: s.emoji }),
        h("span.cell-emoji", s.emoji),
        h("button.cell-del", { type: "button", "aria-label": "Удалить стикер", onclick: async () => {
          try { await api.del(`/api/stickers/${s.id}`); p.stickers = p.stickers.filter((x) => x.id !== s.id); p.count--; paint(); onChange(); } catch (e) { toastError(e); }
        } }, icon("x", "sm")))),
      p.stickers.length < 120 ? h("button.pack-cell.add-cell", { type: "button", onclick: () => fileInput.click() }, icon("plus"), h("span", "Добавить")) : null);
  };
  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files].slice(0, 120 - p.stickers.length);
    fileInput.value = "";
    let done = 0;
    for (const f of files) {
      progress.textContent = `Загружаем ${++done} из ${files.length}…`;
      const fd = new FormData();
      fd.append("file", f); fd.append("emoji", emoji);
      try { const s = await api.form(`/api/sticker-packs/${p.id}/stickers`, fd); p.stickers.push(s); p.count++; paint(); } catch (e) { toastError(e); }
    }
    progress.textContent = "";
    onChange();
  });
  paint();
  const m = modal({
    title: p.title,
    body: h("div.stack",
      h("div.pack-tools",
        h("button.btn.soft.sm", { type: "button", onclick: async () => {
          const t = await promptDialog({ title: "Название набора", confirm: "Сохранить", value: p.title });
          if (t) try { Object.assign(p, await api.patch(`/api/sticker-packs/${p.id}`, { title: t })); m.close(); onChange(); } catch (e) { toastError(e); }
        } }, icon("edit", "sm"), "Переименовать"),
        h("button.btn.soft.sm", { type: "button", onclick: () => copyLink(p) }, icon("link", "sm"), "Ссылка"),
        h("div.spacer"),
        h("button.btn.ghost.sm.danger-text", { type: "button", onclick: async () => {
          if (!await confirmDialog({ title: `Удалить набор «${p.title}»?`, text: "Стикеры пропадут у всех, кто добавил набор. Уже отправленные сообщения останутся.", confirm: "Удалить", danger: true })) return;
          try { await api.del(`/api/sticker-packs/${p.id}`); m.close(); onChange(); toast("Набор удалён"); } catch (e) { toastError(e); }
        } }, icon("trash", "sm"), "Удалить")),
      h("div.field", h("label", "Эмодзи для новых стикеров"), emojiRow),
      h("p.muted.small-note", "PNG или WebP с прозрачным фоном выглядят лучше всего. Анимированные GIF и WebP остаются анимированными. До 5 МБ, до 120 стикеров."),
      progress, grid, fileInput),
  });
}

export async function stickersPage({ params, query }) {
  if (params.slug) {
    setTitle("Набор стикеров");
    const holder = h("div.stack");
    const p = await api.get(`/api/sticker-packs/by-slug/${encodeURIComponent(params.slug)}`);
    const btn = h("button.btn.primary", { type: "button" });
    const paint = () => {
      btn.hidden = p.builtin || p.mine;
      btn.className = `btn ${p.installed ? "outline" : "primary"}`;
      btn.textContent = p.installed ? "Удалить из моих стикеров" : "Добавить в мои стикеры";
    };
    btn.onclick = () => busy(btn, async () => {
      try {
        if (p.installed) await api.del(`/api/sticker-packs/${p.id}/install`); else await api.post(`/api/sticker-packs/${p.id}/install`);
        p.installed = !p.installed; emit("stickers-changed"); paint();
        toast(p.installed ? "Набор добавлен — ищите его в чате во вкладке «Стикеры»" : "Набор удалён", { icon: "check" });
      } catch (e) { toastError(e); }
    });
    paint();
    setTitle(p.title);
    holder.append(h("section.card.card-pad.pack-page",
      h("div.pack-page-head", p.stickers[0] ? h("img.pack-cover", { src: p.stickers[0].url, alt: "" }) : null,
        h("div.grow", h("h1", p.title), h("p.muted", `${p.count} стикеров${p.owner ? ` · автор ${p.owner.name}` : ""}`),
          p.builtin ? h("span.status-pill", "Встроенный набор — есть у всех") : p.mine ? h("span.status-pill", "Ваш набор") : null),
        h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, h("button.btn.soft", { type: "button", onclick: () => copyLink(p) }, icon("link", "sm"), "Поделиться"), btn)),
      h("div.pack-grid.big", p.stickers.map((s) => h("div.pack-cell", h("img", { src: s.url, alt: s.emoji, loading: "lazy" }))))));
    return holder;
  }

  setTitle("Стикеры");
  const list = h("div.stack");
  async function load() {
    const { packs } = await api.get("/api/stickers");
    const mine = packs.filter((p) => p.mine);
    const other = packs.filter((p) => !p.mine);
    const row = (p) => h("div.pack-row",
      h("div.pack-thumbs", p.stickers.slice(0, 4).map((s) => h("img", { src: s.url, alt: "" })), !p.stickers.length ? h("span.muted", "пусто") : null),
      h("div.grow", h("b", p.title), h("small.muted", `${p.count} стикеров${p.builtin ? " · встроенный" : p.owner && !p.mine ? ` · ${p.owner.name}` : ""}`)),
      p.mine ? h("button.btn.soft.sm", { type: "button", onclick: () => editPack(p, () => { emit("stickers-changed"); load(); }) }, icon("edit", "sm"), "Изменить")
        : h("button.btn.ghost.sm", { type: "button", onclick: () => showPackPreview(p.slug) }, "Открыть"),
      !p.mine && !p.builtin ? h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Удалить набор ${p.title} из моих`, title: "Удалить из моих", onclick: async () => {
        try { await api.del(`/api/sticker-packs/${p.id}/install`); emit("stickers-changed"); load(); } catch (e) { toastError(e); }
      } }, icon("trash", "sm")) : null);
    list.replaceChildren(
      h("section.card.card-pad",
        h("div.row", h("h2", { style: { margin: 0 } }, "Мои наборы"), h("div.spacer"),
          h("button.btn.primary.sm", { type: "button", onclick: createPack }, icon("plus", "sm"), "Создать набор")),
        mine.length ? h("div.pack-list", mine.map(row))
          : h("div.empty.small", h("p", "Соберите свой набор из картинок — друзья смогут добавить его по ссылке."))),
      h("section.card.card-pad", h("h2", { style: { margin: "0 0 8px" } }, "Добавленные наборы"), h("div.pack-list", other.map(row))));
    return { mine };
  }
  async function createPack() {
    const title = await promptDialog({ title: "Новый набор стикеров", label: "Например, «Мой кот Барсик»", confirm: "Создать" });
    if (!title) return;
    try {
      const p = await api.post("/api/sticker-packs", { title });
      emit("stickers-changed");
      await load();
      editPack(p, () => { emit("stickers-changed"); load(); });
    } catch (e) { toastError(e); }
  }
  await load();
  if (query.new) setTimeout(createPack, 200);
  return h("div.stack", h("div.page-head", h("h1", "Стикеры")), list);
}
