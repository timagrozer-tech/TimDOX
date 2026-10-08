// QEVI Remix и AI Sticker Lab в браузере: редактор с живым превью (рисует сервер), стикеры по описанию (рисует браузер:
// эмодзи системным шрифтом + надпись), набор из фото. Оригинал стикера никогда не меняется — сохраняется новая версия.
import { api, emit, state } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, toast, toastError, busy } from "../ui.js";
import { stickerEl } from "./stickerview.js";

const ANIMS = [["none", "Без"], ["bounce", "Прыжок"], ["shake", "Тряска"], ["pulse", "Пульс"], ["spin", "Вращение"], ["wobble", "Качание"],
  ["float", "Парение"], ["jelly", "Желе"], ["rainbow", "Радуга"], ["glitch", "Глитч"]];
const BGS = [["none", "Без"], ["circle", "Круг"], ["square", "Плашка"], ["gradient", "Градиент"], ["burst", "Взрыв"]];
const OUTLINES = [["none", "Без"], ["white", "Белая"], ["black", "Чёрная"], ["color", "Цветная"]];
const ELEMENTS = [["hearts", "💕 Сердечки"], ["sparkles", "✨ Искры"], ["stars", "⭐ Звёзды"], ["crown", "👑 Корона"], ["halo", "😇 Нимб"], ["tears", "💧 Слёзы"]];
const PRESETS = [
  ["Неон", { hue: 160, sat: 1.6, outline: "color", outline_color: "#00ffd5", glow: true, glow_color: "#00ffd5" }],
  ["Ретро", { sat: .6, tint: "#ffb36b", tint_k: .25, outline: "white" }],
  ["Ч/Б", { sat: 0, outline: "white", shadow: true }],
  ["Праздник", { elements: ["sparkles", "stars"], bg: "burst", bg_color: "#ffcc33", outline: "white" }],
  ["Любовь", { elements: ["hearts"], tint: "#ff5c9a", tint_k: .15, anim: "pulse", outline: "white" }],
  ["Босс", { elements: ["crown"], glow: true, outline: "black" }],
];
const DEFAULTS = { hue: 0, sat: 1, bright: 1, tint: "#ff5c9a", tint_k: 0, bg: "none", bg_color: "#7c5cff", outline: "none", outline_color: "#ffffff",
  outline_w: 10, shadow: false, glow: false, glow_color: "#ffd65a", text: "", text_pos: "bottom", text_color: "#ffffff", stroke_color: "#111111",
  meme_top: "", meme_bottom: "", elements: [], anim: "none" };

const fetchImage = async (url, opts) => {
  const res = await fetch(url, { credentials: "same-origin", ...opts, headers: { ...(opts.headers || {}), ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Не удалось построить превью");
  return res.blob();
};

/** Уменьшаем свою картинку перед загрузкой: быстрее превью и меньше трафика */
export async function shrink(file, max = 1024) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp || Math.max(bmp.width, bmp.height) <= max) return file;
  const k = max / Math.max(bmp.width, bmp.height);
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, file.type === "image/jpeg" ? "image/jpeg" : "image/png", .9));
  return new File([blob], file.name, { type: blob.type });
}

async function ownPacks() {
  try { return (await api.get("/api/stickers")).packs.filter((p) => p.mine && !p.shared); } catch { return []; }
}

/**
 * Редактор Remix. source: стикер {id, url, format, emoji} или {file} — своя картинка (для неё доступны «убрать фон» и «улучшить»).
 * mode: "remix" | "meme" | "removebg" | "enhance" — с чего начать.
 */
export async function openRemix(source, { mode = "remix" } = {}) {
  const p = { ...DEFAULTS, elements: [] };
  const isFile = !!source.file;
  let file = isFile ? await shrink(source.file) : null;
  const lab = { cut: mode === "removebg", enhance: mode === "enhance" };
  if (mode === "meme") Object.assign(p, { meme_top: "", meme_bottom: "" });
  const img = h("img.rx-img", { alt: "Превью ремикса" });
  const spinner = h("div.rx-spin", h("div.spinner"));
  const stage = h("div.rx-stage", img, spinner);
  let ctrl = null, timer = 0, url = null;

  async function preview() {
    ctrl?.abort(); ctrl = new AbortController();
    stage.classList.add("loading");
    try {
      let blob;
      if (isFile) {
        const fd = new FormData();
        fd.append("file", file); fd.append("tool", mode === "meme" ? "meme" : "remix"); fd.append("preview", "1");
        fd.append("params", JSON.stringify({ ...p, ...lab }));
        blob = await fetchImage("/api/sticker-lab/upload", { method: "POST", body: fd, signal: ctrl.signal });
      } else {
        blob = await fetchImage("/api/sticker-lab/remix", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sticker_id: source.id, params: p, preview: true }) });
      }
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob); img.src = url;
      stage.classList.remove("error");
    } catch (e) {
      if (e.name !== "AbortError") { stage.classList.add("error"); toast(e.message, { error: true }); }
    } finally { stage.classList.remove("loading"); }
  }
  const changed = () => { clearTimeout(timer); timer = setTimeout(preview, 260); };

  const chips = (key, list, multi = false) => h("div.rx-chips", list.map(([v, label]) => {
    const on = multi ? p[key].includes(v) : p[key] === v;
    return h(`button.chip${on ? ".on" : ""}`, { type: "button", "aria-pressed": String(on), onclick: (e) => {
      if (multi) p[key] = on ? p[key].filter((x) => x !== v) : [...p[key], v].slice(0, 4);
      else p[key] = v;
      repaint(); changed();
      e.currentTarget.blur();
    } }, label);
  }));
  const range = (key, min, max, step, label, fmt = (x) => x) => {
    const val = h("output", fmt(p[key]));
    const inp = h("input", { type: "range", min, max, step, value: p[key], oninput: (e) => { p[key] = Number(e.target.value); val.textContent = fmt(p[key]); changed(); } });
    return h("label.rx-range", h("span", label), inp, val);
  };
  const color = (key, label) => h("label.rx-color", h("span", label), h("input", { type: "color", value: p[key], oninput: (e) => { p[key] = e.target.value; changed(); } }));
  const text = (key, ph) => h("input.input", { type: "text", maxlength: 48, placeholder: ph, value: p[key], oninput: (e) => { p[key] = e.target.value; changed(); } });
  const check = (key, label, obj = p) => h("label.rx-check", h("input", { type: "checkbox", checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; changed(); } }), h("span", label));
  const group = (title, ...kids) => h("section.rx-group", h("h4", title), ...kids);

  const controls = h("div.rx-controls");
  function repaint() {
    controls.replaceChildren(
      isFile ? group("AI Lab", h("div.rx-row", check("cut", "Убрать фон", lab), check("enhance", "Улучшить чёткость", lab)),
        h("p.muted.rx-note", "Фон убирается лучше всего, если он однотонный или спокойный.")) : null,
      group("Готовые стили", h("div.rx-chips", PRESETS.map(([name, pr]) => h("button.chip", { type: "button", onclick: () => { Object.assign(p, DEFAULTS, { elements: [] }, pr); repaint(); changed(); } }, name)),
        h("button.chip.ghost", { type: "button", onclick: () => { Object.assign(p, DEFAULTS, { elements: [] }); repaint(); changed(); } }, "Сбросить"))),
      group("Анимация", chips("anim", ANIMS)),
      group("Надпись", mode === "meme"
        ? h("div.stack.tight", text("meme_top", "Текст сверху"), text("meme_bottom", "Текст снизу"))
        : h("div.stack.tight", text("text", "Например: «Привет!»"), chips("text_pos", [["top", "Сверху"], ["bottom", "Снизу"], ["middle", "По центру"]])),
        h("div.rx-row", color("text_color", "Цвет"), color("stroke_color", "Обводка букв"))),
      group("Новые элементы", chips("elements", ELEMENTS, true)),
      group("Цвет", range("hue", -180, 180, 5, "Оттенок", (x) => `${x}°`), range("sat", 0, 2.5, .05, "Насыщенность", (x) => `${Math.round(x * 100)}%`),
        range("bright", .3, 1.8, .05, "Яркость", (x) => `${Math.round(x * 100)}%`), h("div.rx-row", color("tint", "Тонировка"), range("tint_k", 0, .85, .05, "Сила", (x) => `${Math.round(x * 100)}%`))),
      group("Фон", chips("bg", BGS), p.bg !== "none" ? color("bg_color", "Цвет фона") : null),
      group("Обводка и свет", chips("outline", OUTLINES), p.outline === "color" ? color("outline_color", "Цвет обводки") : null,
        p.outline !== "none" ? range("outline_w", 2, 24, 1, "Толщина", (x) => `${x}px`) : null,
        h("div.rx-row", check("shadow", "Тень"), check("glow", "Свечение")), p.glow ? color("glow_color", "Цвет свечения") : null),
    );
  }
  repaint();

  const packSel = h("select.input.rx-target", h("option", { value: "" }, isFile ? "Новый набор «AI Lab»" : "Набор «Мои ремиксы»"));
  ownPacks().then((list) => list.forEach((pk) => packSel.append(h("option", { value: pk.id }, pk.title))));
  const save = h("button.btn.primary", { type: "button" }, icon("check", "sm"), "Сохранить стикер");
  const m = modal({
    title: isFile ? (mode === "meme" ? "Мем-стикер" : "AI Sticker Lab") : "QEVI Remix", wide: true,
    body: h("div.rx", h("div.rx-left", stage, h("p.muted.rx-note", isFile ? "Своя картинка → стикер. Оригинал у вас не меняется."
      : "Оригинал остаётся как есть — сохранится ваша версия.")), controls),
    footer: [packSel, save],
  });
  m.dialog?.classList.add("rx-modal");
  // не прыгаем к полю ввода: сначала человек видит превью
  requestAnimationFrame(() => { document.activeElement?.blur?.(); m.dialog?.querySelector(".modal-body")?.scrollTo?.(0, 0); });
  save.addEventListener("click", () => busy(save, async () => {
    try {
      let r;
      if (isFile) {
        const fd = new FormData();
        fd.append("file", file); fd.append("tool", mode === "meme" ? "meme" : "remix"); fd.append("params", JSON.stringify({ ...p, ...lab }));
        if (packSel.value) fd.append("pack_id", packSel.value);
        r = await api.form("/api/sticker-lab/upload", fd);
      } else {
        r = await api.post("/api/sticker-lab/remix", { sticker_id: source.id, params: p, pack_id: packSel.value || null });
      }
      emit("stickers-changed");
      m.close();
      toast(`Сохранено в «${r.pack.title}» ✨`, { icon: "check" });
    } catch (e) { toastError(e); }
  }));
  preview();
}

// ---------------------------------------------------------------- стикеры по описанию (рисуются в браузере)
const EMOJI_FONT = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";

export function drawDesign(d, size = 512) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const x = c.getContext("2d");
  const art = document.createElement("canvas"); art.width = art.height = size;
  const a = art.getContext("2d");
  a.textAlign = "center"; a.textBaseline = "middle";
  const hasCap = !!(d.caption || "").trim();
  const cy = hasCap ? size * .43 : size * .5;
  if (d.bg && d.bg !== "none") {
    const g = a.createRadialGradient(size * .4, size * .32, size * .05, size / 2, size / 2, size * .46);
    g.addColorStop(0, d.bg + "cc"); g.addColorStop(1, d.bg);
    a.fillStyle = g; a.beginPath(); a.arc(size / 2, cy, size * .4, 0, Math.PI * 2); a.fill();
  }
  a.font = `${Math.round(size * .5)}px ${EMOJI_FONT}`;
  a.fillText(d.emoji, size / 2, cy + size * .02);
  const spots = [[.18, .16], [.84, .2], [.82, .7], [.16, .66]];
  (d.accent || []).forEach((em, i) => { a.font = `${Math.round(size * .15)}px ${EMOJI_FONT}`; a.fillText(em, size * spots[i % 4][0], size * spots[i % 4][1]); });
  // белая «наклеечная» обводка по силуэту
  const sil = document.createElement("canvas"); sil.width = sil.height = size;
  const s = sil.getContext("2d");
  s.drawImage(art, 0, 0); s.globalCompositeOperation = "source-in"; s.fillStyle = "#fff"; s.fillRect(0, 0, size, size);
  const r = Math.round(size / 60);
  for (let i = 0; i < 16; i++) { const t = i / 16 * Math.PI * 2; x.drawImage(sil, Math.cos(t) * r, Math.sin(t) * r); }
  x.drawImage(art, 0, 0);
  if (hasCap) {
    const fs = Math.round(size * (d.caption.length > 12 ? .085 : .11));
    x.font = `900 ${fs}px Unbounded, 'Arial Black', system-ui, sans-serif`;
    x.textAlign = "center"; x.textBaseline = "alphabetic";
    x.lineJoin = "round"; x.lineWidth = Math.max(6, fs * .28); x.strokeStyle = "#151024";
    x.strokeText(d.caption, size / 2, size * .93, size * .94);
    x.fillStyle = "#fff"; x.fillText(d.caption, size / 2, size * .93, size * .94);
  }
  return c;
}

export function openTextStickers() {
  const prompt = h("input.input", { type: "text", maxlength: 200, placeholder: "Например: «грустный кот под дождём» или «стикеры для работы»" });
  const grid = h("div.tx-grid");
  const go = h("button.btn.primary", { type: "button" }, icon("sparkle", "sm"), "Придумать");
  const save = h("button.btn.primary", { type: "button", disabled: true }, icon("check", "sm"), "Сохранить выбранные");
  const packSel = h("select.input.rx-target", h("option", { value: "" }, "Новый набор «AI Lab»"));
  ownPacks().then((list) => list.forEach((pk) => packSel.append(h("option", { value: pk.id }, pk.title))));
  let designs = [];
  const chosen = new Set();
  const paint = () => {
    grid.replaceChildren(...designs.map((d, i) => {
      const cv = drawDesign(d, 256);
      const on = chosen.has(i);
      return h(`button.tx-cell${on ? ".on" : ""}`, { type: "button", "aria-pressed": String(on), onclick: () => { on ? chosen.delete(i) : chosen.add(i); paint(); } },
        cv, d.anim && d.anim !== "none" ? h("span.tx-anim", "анимация") : null, h("span.tx-check", icon("check", "sm")));
    }));
    save.disabled = !chosen.size;
  };
  go.addEventListener("click", () => busy(go, async () => {
    try {
      const r = await api.post("/api/sticker-lab/text", { prompt: prompt.value });
      designs = r.designs; chosen.clear(); designs.forEach((_, i) => chosen.add(i)); paint();
      if (!r.ai) toast("ИИ сейчас недоступен — собрали по словам из описания", { duration: 2500 });
    } catch (e) { toastError(e); }
  }));
  prompt.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
  save.addEventListener("click", () => busy(save, async () => {
    let pack = packSel.value || null;
    let n = 0;
    for (const i of chosen) {
      const d = designs[i];
      const blob = await new Promise((r) => drawDesign(d, 512).toBlob(r, "image/png"));
      const fd = new FormData();
      fd.append("file", blob, "text.png"); fd.append("tool", "remix"); fd.append("emoji", d.emoji);
      fd.append("params", JSON.stringify({ anim: d.anim || "none" }));
      if (pack) fd.append("pack_id", pack);
      try { const r = await api.form("/api/sticker-lab/upload", fd); pack = pack || r.pack.id; n++; } catch (e) { toastError(e); break; }
    }
    emit("stickers-changed");
    if (n) { toast(`Готово: ${n} стикеров ✨`, { icon: "check" }); m.close(); }
  }));
  const m = modal({ title: "Стикеры по описанию", wide: true,
    body: h("div.stack", h("p.muted", { style: { margin: 0 } }, "Опишите идею — ИИ придумает композиции из эмодзи и надписей. Выберите понравившиеся."),
      h("div.row", { style: { gap: "8px" } }, prompt, go), grid),
    footer: [packSel, save] });
  setTimeout(() => prompt.focus(), 50);
}

/** Набор из одного фото */
export function openPhotoPack() {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  const title = h("input.input", { type: "text", maxlength: 64, value: "Мои стикеры", "aria-label": "Название набора" });
  const prev = h("div.pp-drop", h("div", "📸"), h("b", "Выберите фото"), h("small.muted", "Лучше портрет на однотонном фоне"));
  const cut = h("input", { type: "checkbox", checked: true });
  let file = null;
  const make = h("button.btn.primary", { type: "button", disabled: true }, icon("sparkle", "sm"), "Сделать набор");
  input.addEventListener("change", async () => {
    file = input.files[0]; if (!file) return;
    file = await shrink(file, 1400);
    prev.replaceChildren(h("img", { src: URL.createObjectURL(file), alt: "" }));
    make.disabled = false;
  });
  prev.addEventListener("click", () => input.click());
  make.addEventListener("click", () => busy(make, async () => {
    const fd = new FormData();
    fd.append("file", file); fd.append("title", title.value); fd.append("cut", cut.checked ? "1" : "0");
    try {
      const pack = await api.form("/api/sticker-lab/photo-pack", fd);
      emit("stickers-changed"); m.close();
      toast(`Набор «${pack.title}» готов — ${pack.count} стикеров ✨`, { icon: "check" });
      const { showPackPreview } = await import("../pages/stickers.js");
      showPackPreview(pack.slug);
    } catch (e) { toastError(e); }
  }));
  const m = modal({ title: "Набор из фото", body: h("div.stack", prev, input, h("div.field", h("label", "Название"), title),
    h("label.rx-check", cut, h("span", "Убрать фон")), h("p.muted.rx-note", "Получится 10 стикеров: с подписями (их придумает ИИ по фото), сердечками, короной, анимациями.")),
    footer: [make] });
}

export { stickerEl };
