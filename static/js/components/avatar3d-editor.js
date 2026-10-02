// Конструктор 3D-аватара во весь экран: сверху большой живой персонаж (следит за курсором/пальцем),
// под ним вкладки «Образы | Лицо | Глаза | … | Фон», ниже — варианты. Любой цвет, отмена/повтор, готовые образы.
import { api, state } from "../api.js";
import { h, icon } from "../dom.js";
import { toast, toastError, busy, trackOverlay } from "../ui.js";
import { refreshSidebarUser } from "./layout.js";
import { mount3D, PALETTES, COLOR_KEYS, OPTIONS, PRESETS, DEFAULT_SPEC, randomSpec, bgCss, colorOf, normalizeSpec } from "./avatar3d.js";

const TABS = [
  ["looks", "✨ Образы"], ["face", "Лицо"], ["eyes", "Глаза"], ["mouth", "Рот и брови"], ["hair", "Волосы"], ["beard", "Борода"],
  ["hat", "Головные уборы"], ["glasses", "Очки"], ["jewelry", "Украшения"], ["outfit", "Одежда"], ["emotion", "Эмоции"],
  ["pet", "Питомец"], ["fx", "Эффекты"], ["bg", "Фон"],
];

export function webglAvailable() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

export async function openAvatar3DEditor(current, onSaved) {
  if (!webglAvailable()) { toast("Браузер не поддерживает 3D (WebGL)", { error: true }); return; }
  let spec = normalizeSpec(current || DEFAULT_SPEC);
  let tab = current ? "hair" : "looks";
  let view = null;
  let closed = false;
  const past = [], future = [];

  const stage = h("div.av3d-hero-stage", h("div.spinner"));
  const hero = h("div.av3d-hero", { style: { background: bgCss(spec) } }, stage);
  const tabs = h("div.av3d-tabbar", { role: "tablist", "aria-label": "Разделы" });
  const panel = h("div.av3d-options");
  const undoBtn = h("button.av3d-hbtn", { type: "button", "aria-label": "Отменить", title: "Отменить", onclick: () => undo() }, "↶");
  const redoBtn = h("button.av3d-hbtn", { type: "button", "aria-label": "Повторить", title: "Повторить", onclick: () => redo() }, "↷");

  let rafPending = false;
  const apply = () => {
    hero.style.background = bgCss(spec);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; view?.update(spec); });
  };
  const syncHist = () => { undoBtn.disabled = !past.length; redoBtn.disabled = !future.length; };
  const remember = () => { past.push(spec); if (past.length > 60) past.shift(); future.length = 0; syncHist(); };
  const replace = (next) => { remember(); spec = next; apply(); paint(false); };
  const set = (k, v) => replace({ ...spec, [k]: v });
  const undo = () => { if (!past.length) return; future.push(spec); spec = past.pop(); apply(); paint(false); syncHist(); };
  const redo = () => { if (!future.length) return; past.push(spec); spec = future.pop(); apply(); paint(false); syncHist(); };

  const group = (title, ...children) => h("section.av3d-group", h("h3", title), h("div.av3d-row", ...children));
  const chips = (key) => OPTIONS[key].map(([v, label]) => h(`button.av3d-chip${spec[key] === v ? ".on" : ""}`, {
    type: "button", "aria-pressed": String(spec[key] === v), onclick: () => set(key, v) }, label));
  const toggle = (key, label) => h(`button.av3d-chip${spec[key] ? ".on" : ""}`, { type: "button", "aria-pressed": String(!!spec[key]), onclick: () => set(key, !spec[key]) }, label);
  // цвета палитры + «свой цвет» (любой, через системную палитру)
  const swatches = (key) => {
    const pal = PALETTES[COLOR_KEYS[key]];
    const custom = typeof spec[key] === "string";
    const items = pal.map((c, i) => h(`button.av3d-sw${spec[key] === i ? ".on" : ""}`, {
      type: "button", "aria-label": `Цвет ${i + 1}`, "aria-pressed": String(spec[key] === i), onclick: () => set(key, i),
      style: { background: Array.isArray(c) ? `radial-gradient(circle at 30% 25%, ${c[0]}, ${c[1]})` : c } }));
    let started = false;
    const input = h("input", { type: "color", value: colorOf(spec, key), "aria-label": "Свой цвет",
      oninput: (e) => { if (!started) { remember(); started = true; } spec = { ...spec, [key]: e.target.value }; apply(); },
      onchange: () => { started = false; paint(false); } });
    items.push(h(`label.av3d-sw.av3d-sw-custom${custom ? ".on" : ""}`, { title: "Свой цвет", style: custom ? { background: spec[key] } : {} }, input));
    return items;
  };
  const emotions = () => h("div.av3d-emos", ...OPTIONS.emotion.map(([v, label]) => {
    const [emo, ...rest] = label.split(" ");
    return h(`button.av3d-emo${spec.emotion === v ? ".on" : ""}`, { type: "button", "aria-pressed": String(spec.emotion === v),
      onclick: () => { set("emotion", v); if (v !== "neutral") setTimeout(() => view?.emote?.(v, 1400), 80); } }, h("span.av3d-emo-ic", emo), h("small", rest.join(" ")));
  }));
  const presets = () => h("div.av3d-emos.av3d-presets", ...PRESETS.map(([, emo, name, p]) =>
    h("button.av3d-emo", { type: "button", onclick: () => replace(normalizeSpec({ ...DEFAULT_SPEC, ...p })) }, h("span.av3d-emo-ic", emo), h("small", name))));
  const note = (t) => h("p.av3d-note", t);
  const when = (cond, ...items) => (cond ? items : []);

  const PANELS = {
    looks: () => [h("section.av3d-group", h("h3", "Готовые образы"), note("Нажмите — и персонаж готов. Потом меняйте что угодно."), presets()),
      group("Ещё", h("button.av3d-chip", { type: "button", onclick: () => replace(randomSpec()) }, "🎲 Собрать случайно"),
        h("button.av3d-chip", { type: "button", onclick: () => replace({ ...DEFAULT_SPEC }) }, "↺ Начать заново"))],
    face: () => [group("Кожа", ...swatches("skin")), group("Форма головы", ...chips("headShape")), group("Размер головы", ...chips("headSize")),
      group("Телосложение", ...chips("build")), group("Уши", ...chips("ears")), group("Нос", ...chips("nose")),
      group("Детали", toggle("cheeks", "Румянец"), toggle("freckles", "Веснушки")), group("Родинка", ...chips("mole")), group("Шрам", ...chips("scar")),
      group("Раскраска лица", ...chips("paint")), ...when(spec.paint !== "none", group("Цвет раскраски", ...swatches("paintColor")))],
    eyes: () => [group("Глаза", ...chips("eyes")), group("Цвет глаз", ...swatches("eyeColor")),
      group("Особенное", toggle("heterochromia", "Разные глаза"), toggle("eyeGlow", "Светятся")),
      ...when(spec.heterochromia, group("Цвет второго глаза", ...swatches("eyeColor2"))),
      group("Ресницы", ...chips("lashes")), group("Тени для век", toggle("eyeshadow", "Тени")), ...when(spec.eyeshadow, group("Цвет теней", ...swatches("shadowColor")))],
    mouth: () => [group("Рот", ...chips("mouth")), group("Помада", toggle("lipstick", "Накрасить губы")), ...when(spec.lipstick, group("Цвет помады", ...swatches("lipColor"))),
      group("Брови", ...chips("brows"))],
    hair: () => [group("Причёска", ...chips("hair")), group("Цвет волос", ...swatches("hairColor")),
      group("Цветная прядь", toggle("hairStreak", "Добавить прядь")), group("Цвет пряди и резинок", ...swatches("hairColor2"))],
    beard: () => [group("Борода и усы", ...chips("facial")), note("Цвет — как у волос.")],
    hat: () => [group("Головной убор", ...chips("hat")), group("Цвет", ...swatches("hatColor"))],
    glasses: () => [group("Очки", ...chips("glasses")), group("Цвет оправы / стёкол", ...swatches("glassesColor"))],
    jewelry: () => [group("Уши", ...chips("earwear")), group("Шея", ...chips("neck")), group("Пирсинг", ...chips("piercing")),
      group("Цвет украшений и наушников", ...swatches("jewelColor"))],
    outfit: () => [group("Одежда", ...chips("outfit")), group("Основной цвет", ...swatches("outfitColor")), group("Второй цвет (детали, узор, шарф)", ...swatches("outfitColor2")),
      group("Узор ткани", ...chips("pattern")), group("Принт на груди", ...chips("print"))],
    emotion: () => [h("section.av3d-group", h("h3", "Эмоция по умолчанию"), note("В профиле нажмите на аватар — он покажет случайную эмоцию."), emotions()),
      group("Как двигается", ...chips("idle"))],
    pet: () => [group("Питомец рядом", ...chips("pet")), ...when(spec.pet !== "none", group("Цвет питомца", ...swatches("petColor")))],
    fx: () => [group("Частицы вокруг", ...chips("fx")), group("Как двигается", ...chips("idle"))],
    bg: () => [group("Узор фона", ...chips("bgStyle")), group("Цвет фона", ...swatches("bg"))],
  };

  function paint(resetScroll = true) {
    tabs.replaceChildren(...TABS.map(([k, t]) => h(`button.av3d-tab${tab === k ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(tab === k),
      onclick: (e) => { tab = k; paint(); e.currentTarget.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); } }, t)));
    const top = panel.scrollTop;
    panel.replaceChildren(...PANELS[tab]());
    panel.scrollTop = resetScroll ? 0 : top;
  }

  const save = h("button.av3d-done", { type: "button" }, "Готово");
  const dice = h("button.av3d-dice", { type: "button", "aria-label": "Случайный персонаж", title: "Случайно", onclick: () => replace(randomSpec()) }, "🎲");
  hero.append(h("div.av3d-hist", undoBtn, redoBtn), dice, h("span.av3d-tip", "Крутите пальцем · следит за курсором"));
  syncHist();
  const root = h("div.av3d-full", { role: "dialog", "aria-modal": "true", "aria-label": "Редактор 3D-аватара" },
    h("header.av3d-top",
      h("button.av3d-x", { type: "button", "aria-label": "Закрыть", onclick: () => close() }, icon("x")),
      h("b", "3D-аватар"), save),
    hero,
    h("div.av3d-side", tabs, panel));
  document.body.append(root);
  document.documentElement.classList.add("av3d-lock");
  requestAnimationFrame(() => root.classList.add("in"));
  const release = trackOverlay(() => close());
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.target.tagName !== "INPUT") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  };
  document.addEventListener("keydown", onKey);

  function close() {
    if (closed) return;
    closed = true;
    release?.();
    document.removeEventListener("keydown", onKey);
    document.documentElement.classList.remove("av3d-lock");
    root.classList.remove("in");
    view?.destroy(); view = null;
    setTimeout(() => root.remove(), 220);
  }

  paint();
  view = await mount3D(stage, spec, { interactive: true, snapshotable: true, zoom: matchMedia("(min-width: 900px)").matches ? .78 : 1.08 });
  stage.querySelector(".spinner")?.remove();
  if (closed) { view?.destroy(); return; }
  if (!view) { close(); toast("Не удалось запустить 3D", { error: true }); return; }

  save.addEventListener("click", () => busy(save, async () => {
    try {
      const blob = await view.snapshot(512);
      const fd = new FormData();
      fd.append("file", blob, "avatar3d.png");
      fd.append("keep3d", "1");
      const res = await api.form("/api/me/avatar", fd);
      const r = await api.put("/api/me/avatar3d", { spec });
      state.me.avatar = res.avatar;
      refreshSidebarUser();
      close();
      toast("3D-аватар сохранён ✨ Делаем стикеры…", { icon: "check" });
      onSaved?.(r.avatar3d, res.avatar);
      // набор стикеров с эмоциями персонажа — в фоне, после закрытия редактора
      setTimeout(() => import("./avatar3d-stickers.js").then((m) => m.buildAvatarStickers(r.avatar3d)), 400);
    } catch (e) { toastError(e); }
  }));
}
