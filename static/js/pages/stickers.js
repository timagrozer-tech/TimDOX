// Студия стикеров KRUG: мои наборы, коллекция (избранное, реакции, папки), каталог (бесплатно и за KC),
// импорт (Telegram по ссылке, архивы, перетаскивание файлов) и AI Sticker Lab. Плюс окно набора и страница по ссылке.
import { api, emit, on, state } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { setTitle, toast, toastError, modal, promptDialog, confirmDialog, busy, showMenu } from "../ui.js";
import { navigate, setCleanup } from "../router.js";
import { EMOJI_CATS, stickerActions } from "../components/stickerpanel.js";
import { stickerEl } from "../components/stickerview.js";

const QUICK_EMOJI = "😀 😂 😍 🥰 😎 🤔 😢 😡 😮 👍 👌 🙏 🎉 ❤️ 🔥 😴".split(" ");
const nStickers = (n) => pl(n, ["стикер", "стикера", "стикеров"]);
const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const SOURCE = { telegram: "Telegram", import: "Импорт", lab: "AI Lab", remix: "Ремикс", copy: "Копия", avatar3d: "3D" };

function packLink(p) { return `${location.origin}/stickers/${p.slug}`; }
function copyLink(p) {
  navigator.clipboard?.writeText(packLink(p)).then(() => toast("Ссылка на набор скопирована", { icon: "link" }), () => toast(packLink(p)));
}
const remix = (s, opts) => import("../components/remix.js").then((m) => m.openRemix(s, opts));

function badges(p) {
  return h("div.stk-badges",
    p.source && SOURCE[p.source] ? h("span.stk-badge", SOURCE[p.source]) : null,
    p.kind === "emoji" ? h("span.stk-badge", "Эмодзи") : p.kind === "reactions" ? h("span.stk-badge", "Реакции") : null,
    p.price ? h("span.stk-badge.kc", `${p.price} KC`) : null,
    p.published && p.mine ? h("span.stk-badge.ok", "В каталоге") : null,
    p.favorite ? h("span.stk-badge.fav", "★") : null);
}

/** Окно с набором: стикеры, добавить/купить, своя версия */
export async function showPackPreview(slug) {
  if (!slug) return;
  const body = h("div.pack-preview", h("div.spinner"));
  const addBtn = h("button.btn.primary", { type: "button", disabled: true }, "Добавить набор");
  const copyBtn = h("button.btn.ghost", { type: "button", hidden: true }, icon("copy", "sm"), "Своя версия");
  const m = modal({ title: "Набор стикеров", body, footer: [copyBtn, addBtn] });
  try {
    const p = await api.get(`/api/sticker-packs/by-slug/${encodeURIComponent(slug)}`);
    m.dialog.querySelector("h2")?.replaceChildren(p.title);
    body.replaceChildren(
      h("div.pack-head", h("b", p.title), h("small.muted", `${nStickers(p.count)}${p.owner ? ` · автор ${p.owner.name}` : ""}${p.installs ? ` · добавили ${p.installs}` : ""}`),
        p.description ? h("p.muted.pack-desc", p.description) : null, badges(p)),
      h("div.pack-grid", p.stickers.map((s) => {
        const cell = h("button.pack-cell", { type: "button", "aria-label": `Стикер ${s.emoji}`, onclick: () => !p.locked && stickerActions(cell, { ...s, pack: { slug: p.slug } }, { close: m.close }) },
          stickerEl(s), p.locked ? h("span.cell-lock", "🔒") : null);
        return cell;
      })));
    const paint = () => {
      addBtn.hidden = p.builtin || p.mine;
      addBtn.disabled = false;
      addBtn.textContent = p.locked ? `Купить за ${p.price} KC` : p.installed ? "Удалить из моих" : "Добавить набор";
      addBtn.className = `btn ${p.installed && !p.locked ? "outline" : "primary"}`;
      copyBtn.hidden = p.locked || p.builtin;
    };
    paint();
    addBtn.onclick = () => busy(addBtn, async () => {
      try {
        if (p.locked) {
          if (!await confirmDialog({ title: `Купить «${p.title}»?`, text: `${p.price} KC уйдут автору набора (7% — комиссия Круга). Набор останется у вас навсегда.`, confirm: `Купить за ${p.price} KC` })) return;
          Object.assign(p, (await api.post(`/api/sticker-packs/${p.id}/buy`, {})).pack);
          toast("Набор ваш! Ищите его во вкладке «Стикеры» 🎉", { icon: "check" });
          m.close(); showPackPreview(slug);
        } else {
          if (p.installed) await api.del(`/api/sticker-packs/${p.id}/install`); else await api.post(`/api/sticker-packs/${p.id}/install`, { slug: p.slug });
          p.installed = !p.installed;
          toast(p.installed ? `Набор «${p.title}» добавлен` : "Набор удалён", { icon: "check" });
        }
        emit("stickers-changed");
        paint();
      } catch (e) { toastError(e); }
    });
    copyBtn.onclick = () => busy(copyBtn, async () => {
      try {
        const c = await api.post(`/api/sticker-packs/${p.id}/copy`, {});
        emit("stickers-changed"); m.close();
        toast("Готово: ваша версия — меняйте как хотите", { icon: "check" });
        editPack(c, () => {});
      } catch (e) { toastError(e); }
    });
  } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
}

function emojiPicker(current, onPick) {
  const all = EMOJI_CATS.flatMap(([, , list]) => list.split(" "));
  const m = modal({
    title: "Эмодзи для стикера", narrow: true,
    body: h("div.stack", h("p.muted", { style: { margin: 0 } }, "По этому эмодзи стикер будет легче найти."),
      h("div.sp-emoji.emoji-choose", all.map((e) => h(`button${e === current ? ".on" : ""}`, { type: "button", onclick: () => { m.close(); onPick(e); } }, e)))),
  });
}

// ---------------------------------------------------------------- импорт файлов с прогрессом
async function watchJob(job, bar, label) {
  for (let i = 0; i < 600; i++) {
    const pct = job.total ? Math.round(job.done / job.total * 100) : 0;
    bar.style.setProperty("--p", `${pct}%`);
    label.textContent = job.status === "waiting" ? "Этот набор уже скачивает кто-то другой — подождём…"
      : job.status === "running" ? `Переносим: ${job.done} из ${job.total}` : job.status === "done" ? "Готово!" : job.error || "Ошибка";
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, 700));
    job = await api.get(`/api/sticker-import/${job.id}`);
  }
  return job;
}

async function importFiles(files, { title = "Импортированный набор", packId = null, progress } = {}) {
  const fd = new FormData();
  fd.append("title", title);
  if (packId) fd.append("pack_id", packId);
  for (const f of files) fd.append("files", f, f.name);
  const bar = h("div.stk-bar"), label = h("span");
  progress?.replaceChildren(h("div.stk-progress", bar, label));
  label.textContent = "Загружаем файлы…";
  const job = await watchJob(await api.form("/api/sticker-import/files", fd), bar, label);
  emit("stickers-changed");
  if (job.status === "error") throw new Error(job.error);
  return job;
}

// ---------------------------------------------------------------- редактор набора
export async function editPack(p, onChange) {
  p = await api.get(`/api/sticker-packs/by-slug/${p.slug}`);
  const grid = h("div.pack-grid.editable");
  const fileInput = h("input", { type: "file", accept: "image/png,image/webp,image/gif,image/jpeg,.tgs,video/webm,.webm,.zip,application/zip", multiple: true, hidden: true });
  let emoji = "🙂";
  let selecting = false;
  const selected = new Set();
  const emojiRow = h("div.quick-emoji", QUICK_EMOJI.map((e) => h("button", { type: "button", "aria-pressed": String(e === emoji), onclick: () => { emoji = e; paintEmoji(); } }, e)),
    h("button.more", { type: "button", onclick: () => emojiPicker(emoji, (e) => { emoji = e; paintEmoji(); }) }, "…"));
  const paintEmoji = () => emojiRow.querySelectorAll("button:not(.more)").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === emoji)));
  const progress = h("div.pack-progress");
  const selBar = h("div.stk-selbar", { hidden: true });
  const reload = async () => { Object.assign(p, await api.get(`/api/sticker-packs/by-slug/${p.slug}`)); paint(); onChange?.(); emit("stickers-changed"); };

  const cellMenu = (cell, s) => showMenu(cell, [
    { label: "Сделать обложкой", icon: "image", onClick: async () => { try { await api.patch(`/api/sticker-packs/${p.id}`, { cover_id: s.id }); toast("Обложка обновлена", { icon: "check" }); reload(); } catch (e) { toastError(e); } } },
    { label: `Эмодзи: ${s.emoji}`, icon: "smile", onClick: () => emojiPicker(s.emoji, async (e) => { try { await api.patch(`/api/stickers/${s.id}`, { emoji: e }); reload(); } catch (er) { toastError(er); } }) },
    { label: "Теги для поиска…", icon: "search", hint: s.tags || "например: кот, радость", onClick: async () => {
      const t = await promptDialog({ title: "Теги для поиска", label: "Через пробел: кот рыжий радость", value: s.tags || "", confirm: "Сохранить" });
      if (t != null) try { await api.patch(`/api/stickers/${s.id}`, { tags: t }); reload(); } catch (e) { toastError(e); }
    } },
    (s.format || "webp") === "webp" ? { label: "Ремикс", icon: "sparkle", onClick: () => remix(s) } : null,
    "-",
    { label: "Удалить стикер", icon: "trash", danger: true, onClick: async () => { try { await api.del(`/api/stickers/${s.id}`); reload(); } catch (e) { toastError(e); } } },
  ]);

  const paintSel = () => {
    selBar.hidden = !selecting;
    selBar.replaceChildren(h("b", selected.size ? `Выбрано: ${selected.size}` : "Выберите стикеры"), h("div.spacer"),
      h("button.btn.soft.sm", { type: "button", disabled: !selected.size, onclick: async () => {
        const title = await promptDialog({ title: "Новый набор из выбранных", value: `${p.title} · часть 2`, confirm: "Разделить" });
        if (!title) return;
        try { await api.post(`/api/sticker-packs/${p.id}/split`, { sticker_ids: [...selected], title }); selected.clear(); selecting = false; toast("Набор разделён", { icon: "check" }); reload(); } catch (e) { toastError(e); }
      } }, icon("scissors", "sm"), "В новый набор"),
      h("button.btn.ghost.sm.danger-text", { type: "button", disabled: !selected.size, onclick: async () => {
        if (!await confirmDialog({ title: `Удалить ${nStickers(selected.size)}?`, confirm: "Удалить", danger: true })) return;
        for (const id of selected) { try { await api.del(`/api/stickers/${id}`); } catch (e) { toastError(e); break; } }
        selected.clear(); selecting = false; reload();
      } }, icon("trash", "sm"), "Удалить"),
      h("button.btn.ghost.sm", { type: "button", onclick: () => { selecting = false; selected.clear(); paint(); } }, "Готово"));
  };
  const paint = () => {
    grid.replaceChildren(
      ...p.stickers.map((s) => {
        const on = selected.has(s.id);
        const cell = h(`button.pack-cell${on ? ".sel" : ""}${p.cover?.id === s.id ? ".cover" : ""}`, { type: "button", "aria-label": `Стикер ${s.emoji}`, onclick: () => {
          if (selecting) { on ? selected.delete(s.id) : selected.add(s.id); paint(); } else cellMenu(cell, s);
        } }, stickerEl(s), h("span.cell-emoji", s.emoji), selecting ? h("span.cell-check", on ? icon("check", "sm") : null) : null,
        p.cover?.id === s.id ? h("span.cell-cover", "обложка") : null);
        return cell;
      }),
      p.stickers.length < 200 ? h("button.pack-cell.add-cell", { type: "button", onclick: () => fileInput.click() }, icon("plus"), h("span", "Добавить")) : null);
    paintSel();
  };
  async function upload(files) {
    files = [...files];
    if (!files.length) return;
    if (files.length === 1 && !/\.(zip|tgs|webm)$/i.test(files[0].name)) {
      progress.textContent = "Загружаем…";
      const fd = new FormData(); fd.append("file", files[0]); fd.append("emoji", emoji);
      try { await api.form(`/api/sticker-packs/${p.id}/stickers`, fd); } catch (e) { toastError(e); }
      progress.textContent = "";
    } else {
      try { await importFiles(files, { packId: p.id, progress }); } catch (e) { toastError(e); }
      setTimeout(() => progress.replaceChildren(), 1500);
    }
    reload();
  }
  fileInput.addEventListener("change", () => { const f = fileInput.files; upload(f); fileInput.value = ""; });
  grid.addEventListener("dragover", (e) => { e.preventDefault(); grid.classList.add("drop"); });
  grid.addEventListener("dragleave", () => grid.classList.remove("drop"));
  grid.addEventListener("drop", (e) => { e.preventDefault(); grid.classList.remove("drop"); upload(e.dataTransfer.files); });
  paint();

  const publishBtn = () => h("button.btn.soft.sm", { type: "button", onclick: async () => {
    const price = h("input.input", { type: "number", min: 0, max: 5000, step: 10, value: p.price || 0 });
    const desc = h("textarea.input", { rows: 2, maxlength: 300, placeholder: "Пара слов о наборе — это увидят в каталоге" }, p.description || "");
    const mm = modal({ title: p.published ? "Набор в каталоге" : "Опубликовать в каталоге", narrow: true,
      body: h("div.stack", h("p.muted", { style: { margin: 0 } }, "Любой человек найдёт набор в каталоге и добавит себе. Можно раздавать бесплатно или продавать за KC — монеты придут вам (7% — комиссия Круга)."),
        h("div.field", h("label", "Описание"), desc), h("div.field", h("label", "Цена, KC (0 — бесплатно)"), price),
        h("p.muted.small-note", "Публиковать можно свои рисунки, наборы из AI Lab и ремиксы своих стикеров. Импортированные из Telegram — нельзя: это чужое творчество.")),
      footer: [p.published ? h("button.btn.ghost", { type: "button", onclick: async () => { try { await api.post(`/api/sticker-packs/${p.id}/publish`, { published: false }); mm.close(); toast("Снято с каталога"); reload(); } catch (e) { toastError(e); } } }, "Снять с каталога") : null,
        h("button.btn.primary", { type: "button", onclick: async (e) => busy(e.currentTarget, async () => {
          try {
            await api.patch(`/api/sticker-packs/${p.id}`, { description: desc.value });
            await api.post(`/api/sticker-packs/${p.id}/publish`, { published: true, price: Number(price.value) || 0 });
            mm.close(); toast("Набор в каталоге ✨", { icon: "check" }); reload();
          } catch (er) { toastError(er); }
        }) }, p.published ? "Сохранить" : "Опубликовать")] });
  } }, icon("upload", "sm"), p.published ? "В каталоге" : "В каталог");

  const m = modal({
    title: p.title, wide: true,
    body: h("div.stack",
      h("div.pack-tools",
        h("button.btn.soft.sm", { type: "button", onclick: async () => {
          const t = await promptDialog({ title: "Название набора", confirm: "Сохранить", value: p.title });
          if (t) try { await api.patch(`/api/sticker-packs/${p.id}`, { title: t }); m.dialog.querySelector("h2").textContent = t; reload(); } catch (e) { toastError(e); }
        } }, icon("edit", "sm"), "Переименовать"),
        h("button.btn.soft.sm", { type: "button", onclick: () => { selecting = !selecting; selected.clear(); paint(); } }, icon("check", "sm"), "Выбрать"),
        h("button.btn.soft.sm", { type: "button", onclick: () => mergeInto(p, reload) }, icon("merge", "sm"), "Объединить"),
        h("button.btn.soft.sm", { type: "button", onclick: async () => {
          try { const c = await api.post(`/api/sticker-packs/${p.id}/copy`, {}); toast(`Копия «${c.title}» создана`, { icon: "check" }); onChange?.(); emit("stickers-changed"); } catch (e) { toastError(e); }
        } }, icon("copy", "sm"), "Копия"),
        h("button.btn.soft.sm", { type: "button", onclick: () => copyLink(p) }, icon("link", "sm"), "Ссылка"),
        publishBtn(),
        h("div.spacer"),
        h("button.btn.ghost.sm.danger-text", { type: "button", onclick: async () => {
          if (!await confirmDialog({ title: `Удалить набор «${p.title}»?`, text: "Стикеры пропадут у всех, кто добавил набор. Уже отправленные сообщения останутся.", confirm: "Удалить", danger: true })) return;
          try { await api.del(`/api/sticker-packs/${p.id}`); m.close(); onChange?.(); emit("stickers-changed"); toast("Набор удалён"); } catch (e) { toastError(e); }
        } }, icon("trash", "sm"), "Удалить")),
      h("div.field", h("label", "Эмодзи для новых стикеров"), emojiRow),
      h("p.muted.small-note", "Перетащите сюда файлы или ZIP. PNG/WebP с прозрачным фоном, GIF, анимации Telegram (TGS) и видеостикеры (WEBM) — всё конвертируется само. Нажмите на стикер — обложка, эмодзи, теги, ремикс."),
      selBar, progress, grid, fileInput),
  });
}

async function mergeInto(p, done) {
  const { packs } = await api.get("/api/stickers");
  const others = packs.filter((x) => x.id !== p.id && !x.locked);
  if (!others.length) { toast("Нет других наборов для объединения"); return; }
  const mm = modal({ title: `Добавить в «${p.title}»`, narrow: true,
    body: h("div.pack-list", others.map((x) => h("button.pack-row.pick", { type: "button", onclick: (e) => {
      const go = async (move) => {
        try { const r = await api.post(`/api/sticker-packs/${p.id}/merge`, { from_id: x.id, move }); mm.close(); toast(`Добавлено: ${nStickers(r.added)}`, { icon: "check" }); emit("stickers-changed"); done(); } catch (er) { toastError(er); }
      };
      if (x.mine && !x.shared) showMenu(e.currentTarget, [
        { label: "Скопировать стикеры", icon: "copy", onClick: () => go(false) },
        { label: `Перенести и удалить «${x.title}»`, icon: "merge", onClick: () => go(true) }]);
      else go(false);
    } }, h("div.pack-thumbs", x.stickers.slice(0, 4).map((s) => stickerEl(s))), h("div.grow", h("b", x.title), h("small.muted", nStickers(x.count)))))) });
}

// ---------------------------------------------------------------- вкладки студии
function packCard(p, reload) {
  const card = h("article.stk-card", { tabindex: 0 },
    h("button.stk-card-main", { type: "button", onclick: () => (p.mine && !p.shared ? editPack(p, reload) : showPackPreview(p.slug)) },
      h("div.stk-cover", p.cover ? stickerEl(p.cover) : h("span", "📦")),
      h("div.stk-strip", (p.stickers || []).slice(0, 4).map((s) => stickerEl(s))),
      h("div.stk-meta", h("b", p.title), h("small.muted", `${nStickers(p.count)}${p.owner && !p.mine ? ` · ${p.owner.name}` : ""}`), badges(p))),
    h("button.stk-more", { type: "button", "aria-label": "Действия с набором", onclick: (e) => showMenu(e.currentTarget, [
      { label: p.favorite ? "Убрать из любимых" : "В любимые наборы", icon: "star", onClick: async () => { try { await api.post(`/api/sticker-packs/${p.id}/favorite`, {}); emit("stickers-changed"); reload(); } catch (er) { toastError(er); } } },
      !p.locked && !p.builtin ? { label: "Создать свою версию", icon: "copy", onClick: async () => { try { const c = await api.post(`/api/sticker-packs/${p.id}/copy`, {}); emit("stickers-changed"); reload(); editPack(c, reload); } catch (er) { toastError(er); } } } : null,
      { label: "Поделиться ссылкой", icon: "link", onClick: () => copyLink(p) },
      !p.builtin ? "-" : null,
      !p.builtin ? { label: p.mine && !p.shared ? "Удалить набор" : "Убрать из моих", icon: "trash", danger: true, onClick: async () => {
        try {
          if (p.mine && !p.shared) {
            if (!await confirmDialog({ title: `Удалить «${p.title}»?`, confirm: "Удалить", danger: true })) return;
            await api.del(`/api/sticker-packs/${p.id}`);
          } else await api.del(`/api/sticker-packs/${p.id}/install`);
          emit("stickers-changed"); reload();
        } catch (er) { toastError(er); }
      } } : null,
    ]) }, icon("more", "sm")));
  return card;
}

async function tabPacks(root) {
  const FILTERS = [["all", "Все"], ["created", "Созданные мной"], ["imported", "Импортированные"], ["animated", "Анимированные"], ["fav", "Любимые"], ["emoji", "Эмодзи и реакции"]];
  let filter = "all";
  const grid = h("div.stk-grid");
  const chips = h("div.stk-chips");
  let packs = [];
  const reload = async () => { packs = (await api.get("/api/stickers")).packs; paint(); };
  const paint = () => {
    chips.replaceChildren(...FILTERS.map(([k, label]) => h(`button.chip${filter === k ? ".on" : ""}`, { type: "button", onclick: () => { filter = k; paint(); } }, label)));
    const list = packs.filter((p) => filter === "all" || (filter === "created" && p.mine && ["own", "lab", "remix", "copy", "avatar3d"].includes(p.source))
      || (filter === "imported" && ["telegram", "import"].includes(p.source)) || (filter === "animated" && p.stickers.some((s) => s.animated))
      || (filter === "fav" && p.favorite) || (filter === "emoji" && p.kind !== "stickers"));
    grid.replaceChildren(...list.map((p) => packCard(p, reload)),
      list.length ? null : h("div.empty.small", h("p", filter === "all" ? "Пока ни одного набора" : "Здесь пока пусто")));
  };
  root.replaceChildren(
    h("div.stk-toolbar", chips, h("div.spacer"),
      h("button.btn.soft.sm", { type: "button", onclick: () => navigate("/stickers?tab=import") }, icon("download", "sm"), "Импорт"),
      h("button.btn.primary.sm", { type: "button", onclick: createPack }, icon("plus", "sm"), "Создать набор")),
    grid);
  async function createPack() {
    const title = await promptDialog({ title: "Новый набор стикеров", label: "Например, «Мой кот Барсик»", confirm: "Создать" });
    if (!title) return;
    try { const p = await api.post("/api/sticker-packs", { title }); emit("stickers-changed"); await reload(); editPack(p, reload); } catch (e) { toastError(e); }
  }
  await reload();
  return { createPack };
}

async function tabCollection(root) {
  const d = await api.get("/api/stickers");
  const sec = (title, items, extra = null, empty = "") => h("section.card.card-pad.stk-sec", h("div.row", h("h3", title), h("div.spacer"), extra),
    items.length ? h("div.stk-mini-grid", items.map((s) => { const b = h("button.pack-cell", { type: "button", onclick: () => stickerActions(b, s) }, stickerEl(s)); return b; }))
      : h("p.muted", empty));
  root.replaceChildren(
    h("p.muted.stk-hint", "Долгое нажатие (или правый клик) на любом стикере в чате — «В избранное», «Сделать реакцией», «В папку»."),
    sec("⭐ Избранное", d.favorites, null, "Добавляйте сюда стикеры, которые отправляете чаще всего."),
    sec("💬 Мои реакции", d.reactions, h("button.btn.ghost.sm", { type: "button", onclick: () => navigate("/stickers?tab=lab") }, icon("sparkle", "sm"), "Сделать реакции"),
      "Любой стикер можно поставить реакцией на сообщение."),
    sec("🕘 Недавние", d.recent, null, "Здесь появятся стикеры, которые вы отправляли."),
    ...d.folders.map((f) => sec(`${f.emoji} ${f.title}`, f.stickers, h("div.row", { style: { gap: "4px" } },
      h("button.btn.ghost.sm.icon-only", { type: "button", "aria-label": "Переименовать папку", onclick: async () => {
        const t = await promptDialog({ title: "Название папки", value: f.title, confirm: "Сохранить" });
        if (t) try { await api.patch(`/api/sticker-folders/${f.id}`, { title: t }); emit("stickers-changed"); tabCollection(root); } catch (e) { toastError(e); }
      } }, icon("edit", "sm")),
      h("button.btn.ghost.sm.icon-only", { type: "button", "aria-label": "Удалить папку", onclick: async () => {
        if (!await confirmDialog({ title: `Удалить папку «${f.title}»?`, text: "Стикеры останутся в своих наборах.", confirm: "Удалить", danger: true })) return;
        try { await api.del(`/api/sticker-folders/${f.id}`); emit("stickers-changed"); tabCollection(root); } catch (e) { toastError(e); }
      } }, icon("trash", "sm"))), "Пустая папка")),
    h("button.btn.soft", { type: "button", onclick: async () => {
      const t = await promptDialog({ title: "Новая папка", label: "Например, «Мемы», «Работа», «Для мамы»", confirm: "Создать" });
      if (t) try { await api.post("/api/sticker-folders", { title: t }); emit("stickers-changed"); tabCollection(root); } catch (e) { toastError(e); }
    } }, icon("folder", "sm"), "Новая папка"));
}

async function tabCatalog(root) {
  let q = "", sort = "popular", price = "all";
  const grid = h("div.stk-grid.catalog");
  const search = h("input.input", { type: "search", placeholder: "Поиск наборов: коты, мемы, аниме…", "aria-label": "Поиск по каталогу" });
  const chips = h("div.stk-chips");
  let timer = 0;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 250); });
  async function load() {
    chips.replaceChildren(
      ...[["popular", "Популярные"], ["new", "Новые"], ["cheap", "Дешевле"]].map(([k, l]) => h(`button.chip${sort === k ? ".on" : ""}`, { type: "button", onclick: () => { sort = k; load(); } }, l)),
      h("span.stk-sep"),
      ...[["all", "Все"], ["free", "Бесплатные"], ["paid", "За KC"]].map(([k, l]) => h(`button.chip${price === k ? ".on" : ""}`, { type: "button", onclick: () => { price = k; load(); } }, l)));
    grid.replaceChildren(h("div.spinner"));
    try {
      const { items } = await api.get("/api/sticker-catalog", { q, sort, price });
      grid.replaceChildren(...items.map((p) => packCard(p, load)),
        items.length ? null : h("div.empty.small", h("p", q ? `Ничего не нашлось по «${q}»` : "Каталог только наполняется — опубликуйте свой набор первым!")));
    } catch (e) { grid.replaceChildren(h("p.muted", e.message)); }
  }
  root.replaceChildren(h("div.stk-toolbar", search), chips,
    h("p.muted.stk-hint", "Бесплатные наборы добавляются в один клик, платные — за KC: монеты получает автор. KC тратятся только на красоту — популярность и подписчиков купить нельзя."),
    grid);
  load();
}

async function tabImport(root, ref = "") {
  const { items: jobs, telegram } = await api.get("/api/sticker-import");
  // ---- Telegram
  const link = h("input.input", { type: "text", placeholder: "https://t.me/addstickers/Название или @Название", "aria-label": "Ссылка на набор Telegram", autocomplete: "off" });
  const tgBox = h("div.stk-tg-preview");
  const tgBtn = h("button.btn.primary", { type: "button" }, icon("search", "sm"), "Найти");
  let timer = 0;
  async function preview() {
    const ref = link.value.trim();
    if (!ref) { tgBox.replaceChildren(); return; }
    tgBox.replaceChildren(h("div.spinner"));
    try {
      const p = await api.get("/api/sticker-import/telegram", { ref });
      const imp = h("button.btn.primary", { type: "button" }, icon("download", "sm"), p.ready ? "Добавить мгновенно" : "Импортировать набор");
      const prog = h("div");
      imp.onclick = () => busy(imp, async () => {
        try {
          const bar = h("div.stk-bar"), label = h("span");
          prog.replaceChildren(h("div.stk-progress", bar, label));
          const job = await watchJob(await api.post("/api/sticker-import/telegram", { ref }), bar, label);
          emit("stickers-changed");
          if (job.status === "done") { toast(`«${p.title}» теперь в Круге ✨`, { icon: "check" }); if (job.slug) showPackPreview(job.slug); }
          else toast(job.error || "Не получилось", { error: true });
        } catch (e) { toastError(e); }
      });
      tgBox.replaceChildren(h("div.stk-tg-card",
        h("div.stk-tg-thumbs", p.thumbs.map((u) => h("img", { src: u, alt: "", loading: "lazy" }))),
        h("div.stk-tg-info", h("b", p.title), h("small.muted", `${nStickers(p.count)} · ${mb(p.size)}`),
          h("div.stk-badges", p.static ? h("span.stk-badge", `${p.static} картинок`) : null, p.animated ? h("span.stk-badge", `${p.animated} анимаций`) : null,
            p.video ? h("span.stk-badge", `${p.video} видео`) : null, p.kind === "emoji" ? h("span.stk-badge", "Эмодзи") : null,
            p.ready ? h("span.stk-badge.ok", "Уже есть в Круге") : null)),
        imp), prog);
    } catch (e) { tgBox.replaceChildren(h("p.stk-error", e.message)); }
  }
  link.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(preview, 500); });
  link.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); preview(); } });
  tgBtn.onclick = preview;
  link.addEventListener("paste", () => setTimeout(preview, 30));

  // ---- файлы и архивы
  const file = h("input", { type: "file", multiple: true, hidden: true, accept: "image/png,image/webp,image/gif,image/jpeg,.tgs,.webm,video/webm,.zip,application/zip" });
  const title = h("input.input", { type: "text", maxlength: 64, value: "Мой набор", "aria-label": "Название набора" });
  const prog = h("div");
  const drop = h("button.stk-drop", { type: "button", onclick: () => file.click() }, h("div.stk-drop-ic", icon("upload")),
    h("b", "Перетащите файлы или ZIP-архив"), h("small.muted", "PNG · WEBP · GIF · JPEG · TGS · WEBM · ZIP — до 200 стикеров, всё сконвертируем сами"));
  const run = async (files) => {
    if (!files.length) return;
    drop.classList.add("busy");
    try {
      const job = await importFiles(files, { title: title.value || "Мой набор", progress: prog });
      toast(`Готово: ${nStickers(job.done)} ✨`, { icon: "check" });
      if (job.slug) showPackPreview(job.slug);
    } catch (e) { toastError(e); } finally { drop.classList.remove("busy"); }
  };
  file.addEventListener("change", () => { run([...file.files]); file.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); run([...e.dataTransfer.files]); });

  root.replaceChildren(
    h("section.card.card-pad.stk-import",
      h("div.stk-import-head", h("span.stk-logo.tg", "✈️"), h("div", h("h3", "Из Telegram"), h("p.muted", "Вставьте ссылку на набор или его @название — покажем превью и перенесём в один клик. Анимированные и видеостикеры тоже."))),
      telegram ? null : h("p.stk-warn", "Импорт по ссылке почти готов: администратору осталось подключить бота Telegram. Пока можно загрузить стикеры архивом или файлами ниже."),
      h("div.row.stk-link-row", link, tgBtn), tgBox),
    h("section.card.card-pad.stk-import",
      h("div.stk-import-head", h("span.stk-logo", "📦"), h("div", h("h3", "Файлы и архивы"), h("p.muted", "Свои картинки, экспорт из других мессенджеров, ZIP — что угодно."))),
      h("div.field", h("label", "Название нового набора"), title), drop, file, prog),
    jobs.length ? h("section.card.card-pad", h("h3", "Недавние импорты"), h("div.stk-jobs", jobs.map((j) => h("div.stk-job",
      h("span", j.source === "telegram" ? "✈️" : "📦"), h("b", j.title || j.ref || "Набор"),
      h("small.muted", j.status === "done" ? nStickers(j.done) : j.status === "error" ? j.error || "ошибка" : `${j.done} из ${j.total}…`),
      j.slug && j.status === "done" ? h("button.btn.ghost.sm", { type: "button", onclick: () => showPackPreview(j.slug) }, "Открыть") : null)))) : null);
  // пришли из бота Telegram: набор уже выбран — сразу показываем превью
  if (ref) { link.value = ref.includes("/") ? ref : `https://t.me/addstickers/${ref}`; preview(); } else setTimeout(() => link.focus(), 60);
}

async function pickSticker(title, onPick) {
  const { packs, favorites, recent } = await api.get("/api/stickers");
  const items = [...(recent || []), ...(favorites || []), ...packs.filter((p) => !p.locked).flatMap((p) => p.stickers)].filter((s) => (s.format || "webp") === "webp");
  const seen = new Set();
  const uniq = items.filter((s) => !seen.has(s.id) && seen.add(s.id)).slice(0, 300);
  const m = modal({ title, body: uniq.length ? h("div.pack-grid", uniq.map((s) => h("button.pack-cell", { type: "button", onclick: () => { m.close(); onPick(s); } }, stickerEl(s))))
    : h("p.muted", "Нет подходящих стикеров — добавьте набор или импортируйте свой.") });
}

function tabLab(root) {
  const pickFile = (cb) => { const i = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" }); i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); };
  const lab = () => import("../components/remix.js");
  const tools = [
    ["🌀", "KRUG Remix", "Цвет, фон, надписи, обводка, элементы и анимации для любого стикера. Оригинал не меняется.", () => pickSticker("Какой стикер ремиксуем?", (s) => lab().then((m) => m.openRemix(s)))],
    ["📸", "Набор из фото", "Одно фото → 10 стикеров: фон уберём, подписи придумает ИИ, добавим анимации.", () => lab().then((m) => m.openPhotoPack())],
    ["✍️", "По описанию", "Опишите идею словами — ИИ придумает стикеры из эмодзи и надписей.", () => lab().then((m) => m.openTextStickers())],
    ["🤡", "Мем-стикер", "Картинка + текст сверху и снизу в классическом мемном стиле.", () => pickFile((f) => lab().then((m) => m.openRemix({ file: f }, { mode: "meme" })))],
    ["✂️", "Убрать фон", "Вырежем главное с картинки и сделаем из неё стикер с обводкой.", () => pickFile((f) => lab().then((m) => m.openRemix({ file: f }, { mode: "removebg" })))],
    ["🔎", "Улучшить и увеличить", "Чётче, ярче и до 512 px — для мелких и мутных картинок.", () => pickFile((f) => lab().then((m) => m.openRemix({ file: f }, { mode: "enhance" })))],
    ["💬", "Реакции", "Из любого стикера — три живые реакции (пульс, прыжок, тряска) для сообщений.", () => pickSticker("Из какого стикера сделать реакции?", async (s) => {
      try { await api.post("/api/sticker-lab/reactions", { sticker_id: s.id }); emit("stickers-changed"); toast("Готово: 3 реакции уже в вашем списке 💬", { icon: "check" }); } catch (e) { toastError(e); }
    })],
    ["🎞", "Анимация", "Оживите статичный стикер: прыжок, пульс, желе, радуга, глитч.", () => pickSticker("Какой стикер оживить?", (s) => lab().then((m) => m.openRemix(s)))],
  ];
  root.replaceChildren(
    h("div.stk-lab-hero", h("div", h("h2", "AI Sticker Lab"), h("p.muted", "Создавайте, улучшайте и ремиксуйте — без сложных программ. Всё сохраняется в ваши наборы."))),
    h("div.stk-lab-grid", tools.map(([ic, t, d, fn]) => h("button.stk-tool", { type: "button", onclick: fn }, h("span.stk-tool-ic", ic), h("b", t), h("small", d)))));
}

const TABS = [["packs", "Мои наборы"], ["collection", "Коллекция"], ["catalog", "Каталог"], ["import", "Импорт"], ["lab", "AI Lab"]];

export async function stickersPage({ params, query }) {
  if (params.slug) return packPage(params.slug);
  setTitle("Стикеры");
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : "packs";
  const root = h("div.stk-body");
  const nav = h("nav.stk-tabs", { role: "tablist" }, TABS.map(([k, label]) => h(`button${tab === k ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(tab === k),
    onclick: () => navigate(`/stickers${k === "packs" ? "" : `?tab=${k}`}`, { replace: true }) }, label)));
  const page = h("div.stk-page", h("div.stk-head", h("div", h("h1", "Стикеры"), h("p.muted", "Ваша коллекция — часть вашей цифровой личности в Круге")),
    h("button.btn.soft.sm", { type: "button", onclick: () => navigate(`/u/${state.me?.username}?tab=stickers`) }, icon("star", "sm"), "Моя витрина")), nav, root);
  // файлы можно бросить прямо на страницу — сразу импорт
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (tab !== "import") { navigate("/stickers?tab=import", { replace: true }); return; }
  };
  const onOver = (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); };
  document.addEventListener("drop", onDrop); document.addEventListener("dragover", onOver);
  const off = on("stickers-changed", () => {});
  setCleanup(() => { document.removeEventListener("drop", onDrop); document.removeEventListener("dragover", onOver); off?.(); });
  root.append(h("div.spinner"));
  try {
    if (tab === "packs") { const t = await tabPacks(root); if (query.new) setTimeout(t.createPack, 200); }
    else if (tab === "collection") await tabCollection(root);
    else if (tab === "catalog") await tabCatalog(root);
    else if (tab === "import") await tabImport(root, query.ref || "");
    else tabLab(root);
  } catch (e) { root.replaceChildren(h("p.muted", e.message)); }
  return page;
}

async function packPage(slug) {
  setTitle("Набор стикеров");
  const p = await api.get(`/api/sticker-packs/by-slug/${encodeURIComponent(slug)}`);
  setTitle(p.title);
  const btn = h("button.btn.primary", { type: "button" });
  const paint = () => {
    btn.hidden = p.builtin || p.mine;
    btn.className = `btn ${p.installed && !p.locked ? "outline" : "primary"}`;
    btn.textContent = p.locked ? `Купить за ${p.price} KC` : p.installed ? "Удалить из моих стикеров" : "Добавить в мои стикеры";
  };
  btn.onclick = () => (p.locked ? showPackPreview(p.slug) : busy(btn, async () => {
    try {
      if (p.installed) await api.del(`/api/sticker-packs/${p.id}/install`); else await api.post(`/api/sticker-packs/${p.id}/install`, { slug: p.slug });
      p.installed = !p.installed; emit("stickers-changed"); paint();
      toast(p.installed ? "Набор добавлен — ищите его в чате во вкладке «Стикеры»" : "Набор удалён", { icon: "check" });
    } catch (e) { toastError(e); }
  }));
  paint();
  return h("div.stack", h("section.card.card-pad.pack-page",
    h("div.pack-page-head", p.cover ? h("div.pack-cover", stickerEl(p.cover)) : null,
      h("div.grow", h("h1", p.title), h("p.muted", `${nStickers(p.count)}${p.owner ? ` · автор ${p.owner.name}` : ""}${p.installs ? ` · добавили ${p.installs}` : ""}`),
        p.description ? h("p", p.description) : null, badges(p),
        p.builtin ? h("span.status-pill", "Встроенный набор — есть у всех") : p.mine ? h("span.status-pill", "Ваш набор") : null),
      h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, h("button.btn.soft", { type: "button", onclick: () => copyLink(p) }, icon("link", "sm"), "Поделиться"), btn)),
    h("div.pack-grid.big", p.stickers.map((s) => h("div.pack-cell", stickerEl(s))))));
}
