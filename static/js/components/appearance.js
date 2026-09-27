// Раздел «Оформление» в настройках: готовые темы, цвет, фон (включая своё фото), шрифт, углы.
import { api, state } from "../api.js";
import { h, icon } from "../dom.js";
import { toast, toastError, applyTheme, currentTheme } from "../ui.js";
import { setMotion, currentMotion } from "../fx.js";
import {
  PALETTES, BACKGROUNDS, FONTS, SHAPES, PRESETS, applyLook, currentLook, currentBgImage, paletteOf, paletteFromColor,
} from "../look.js";

const PREVIEW_TEXT = "АаБбВвКругОрбитаРассветОкеанЛесСакураПолночьНеонГрафитКлассикаНебоЗакатКиберпанкКофейняКоролевскаяТетрадьСпортЯнтарьМинимализмКнигаРукописьКистьюРусскийстильТехноСистемныйManropeInterNunitoRubikMontserratComfortaaRobotoOpenSansUbuntuExo2Philosopher";

function loadPreviewFonts() {
  if (document.getElementById("look-preview-fonts")) return;
  const fams = Object.values(FONTS).filter((f) => f.q).map((f) => f.q).join("&family=");
  const link = h("link", { id: "look-preview-fonts", rel: "stylesheet",
    href: `https://fonts.googleapis.com/css2?display=swap&family=${fams}&text=${encodeURIComponent(PREVIEW_TEXT)}` });
  document.head.append(link);
}

const fontStack = (key, display = false) => {
  const f = FONTS[key];
  if (!f.body) return "system-ui, sans-serif";
  return `"${display ? f.display : f.body}", system-ui, sans-serif`;
};

function sectionBlock(title, hint, ...content) {
  return h("div.look-block", h("div.look-head", h("b", title), hint ? h("small.muted", hint) : null), ...content);
}

export function appearanceSection(settings) {
  loadPreviewFonts();
  let look = currentLook();
  let mode = settings.theme || currentTheme();
  let saveTimer = null;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await api.patch("/api/me/settings", { appearance: look });
        state.me.appearance = res.appearance;
      } catch (e) { toastError(e); }
    }, 450);
  };

  /** Изменить часть оформления; ручная правка снимает отметку с готовой темы */
  const update = (patch, { keepPreset = false } = {}) => {
    look = applyLook({ ...look, ...patch, ...(keepPreset ? {} : { preset: "custom" }) });
    save();
    paint();
  };

  const setMode = (m) => {
    mode = m;
    applyTheme(m);
    state.me.theme = m;
    api.patch("/api/me/settings", { theme: m }).catch(() => {});
  };

  // ------------------------------------------------ готовые темы
  const presetsBox = h("div.preset-grid", { role: "group", "aria-label": "Готовые темы" });
  const paintPresets = () => presetsBox.replaceChildren(...Object.entries(PRESETS).map(([key, p]) => {
    const pal = PALETTES[p.palette];
    const dark = p.mode === "dark";
    const bg = dark
      ? `radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, ${pal.c[1]} 45%, transparent), transparent 60%), radial-gradient(110% 90% at 0% 100%, color-mix(in srgb, ${pal.c[0]} 55%, transparent), transparent 60%), color-mix(in oklab, ${pal.pl} 12%, #06060c)`
      : `radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, ${pal.c[1]} 35%, transparent), transparent 60%), radial-gradient(110% 90% at 0% 100%, color-mix(in srgb, ${pal.c[0]} 35%, transparent), transparent 60%), color-mix(in oklab, ${pal.pl} 6%, #fbfaff)`;
    const radius = { soft: "12px", medium: "8px", sharp: "3px" }[p.shape];
    return h("button.preset-card", {
      type: "button", "aria-pressed": String(look.preset === key), "aria-label": `Тема «${p.name}»`,
      onclick: () => {
        setMode(p.mode);
        update({ preset: key, palette: p.palette, bg: p.bg === "image" ? "orbit" : p.bg, font: p.font, shape: p.shape }, { keepPreset: true });
        toast(`Тема «${p.name}»`, { icon: "check", duration: 1600 });
      },
    },
    h("div.preset-preview", { style: { background: bg, color: dark ? "#f4f4fb" : "#15142a" } },
      h("div.pp-card", { style: { borderRadius: radius, background: dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.75)", borderColor: dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.06)" } },
        h("span.pp-aa", { style: { fontFamily: fontStack(p.font, true) } }, "Аа"),
        h("span.pp-lines", h("i", { style: { background: dark ? pal.pd : pal.pl } }), h("i")),
        h("span.pp-btn", { style: { borderRadius: radius, background: `linear-gradient(120deg, ${pal.pl}, ${pal.al})` } }))),
    h("span.preset-name", { style: { fontFamily: fontStack(p.font, true) } }, p.name),
    look.preset === key ? h("span.preset-check", icon("check", "sm")) : null);
  }));

  // ------------------------------------------------ режим
  const modeSeg = h("div.segmented", { role: "group", "aria-label": "Светлая или тёмная" });
  const paintMode = () => modeSeg.replaceChildren(...[["system", "Авто"], ["light", "Светлая"], ["dark", "Тёмная"]].map(([v, t]) => h("button", {
    type: "button", "aria-pressed": String(v === mode), onclick: () => { setMode(v); paintMode(); },
  }, t)));

  // ------------------------------------------------ цвета
  const colorInput = h("input.visually-hidden", { type: "color", value: look.custom || "#5b3df5", "aria-label": "Свой цвет", tabindex: -1 });
  colorInput.addEventListener("input", () => update({ palette: "custom", custom: colorInput.value }));
  const swatches = h("div.swatch-row", { role: "radiogroup", "aria-label": "Цвет оформления" });
  const paintSwatches = () => {
    const custom = look.palette === "custom" && look.custom ? paletteFromColor(look.custom) : null;
    swatches.replaceChildren(
      ...Object.entries(PALETTES).map(([key, p]) => h("button.swatch", {
        type: "button", role: "radio", "aria-checked": String(look.palette === key), title: p.name, "aria-label": p.name,
        style: { "--sw1": p.pl, "--sw2": p.al, "--sw3": p.c[2] },
        onclick: () => update({ palette: key }),
      }, look.palette === key ? icon("check", "sm") : null)),
      h("button.swatch.custom", {
        type: "button", role: "radio", "aria-checked": String(!!custom), title: "Свой цвет", "aria-label": "Выбрать свой цвет",
        style: custom ? { "--sw1": custom.pl, "--sw2": custom.al, "--sw3": custom.c[2] } : {},
        onclick: () => colorInput.click(),
      }, custom ? icon("check", "sm") : icon("plus", "sm")),
      colorInput);
  };

  // ------------------------------------------------ фон
  const bgGrid = h("div.bg-grid", { role: "radiogroup", "aria-label": "Фон" });
  const bgExtra = h("div.bg-extra");
  let bgImage = currentBgImage();

  const uploadBg = () => {
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true });
    document.body.append(input);
    input.addEventListener("change", async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return toast("Файл больше 10 МБ", { error: true });
      const fd = new FormData();
      fd.append("file", file);
      const t = toast("Загружаем фон…", { duration: 30000 });
      try {
        const res = await api.form("/api/me/background", fd);
        bgImage = res.background;
        state.me.background = bgImage;
        t.remove();
        look = applyLook({ ...look, bg: "image", preset: "custom" }, bgImage);
        save();
        paint();
        toast("Фон обновлён", { icon: "check" });
      } catch (e) { t.remove(); toastError(e); }
    });
    input.click();
  };

  const removeBg = async () => {
    try {
      await api.del("/api/me/background");
      bgImage = null;
      state.me.background = null;
      look = applyLook({ ...look, bg: "orbit", preset: "custom" }, null);
      save();
      paint();
    } catch (e) { toastError(e); }
  };

  const slider = (label, key, max, unit) => {
    const out = h("output", `${look[key]}${unit}`);
    const r = h("input.range", { type: "range", min: 0, max, value: look[key], "aria-label": label });
    r.addEventListener("input", () => {
      out.textContent = `${r.value}${unit}`;
      look = applyLook({ ...look, [key]: +r.value });
      save();
    });
    return h("label.range-row", h("span", label), r, out);
  };

  const paintBg = () => {
    const active = look.bg === "image" && !bgImage ? "orbit" : look.bg;
    bgGrid.replaceChildren(...Object.entries(BACKGROUNDS).map(([key, name]) => {
      const isImg = key === "image";
      return h("button.bg-tile", {
        type: "button", role: "radio", "aria-checked": String(active === key), dataset: { v: key },
        onclick: () => (isImg && !bgImage ? uploadBg() : update({ bg: key })),
      },
      h("span.bg-thumb", isImg && bgImage ? { style: { backgroundImage: `url("${bgImage}")` } } : {},
        isImg && !bgImage ? icon("camera") : null,
        key === "orbit" ? h("span.mini-ring") : null),
      h("span.bg-name", isImg && !bgImage ? "Загрузить фото" : name));
    }));
    bgExtra.replaceChildren(...(active === "image" ? [
      slider("Затемнение", "dim", 85, "%"),
      slider("Размытие", "blur", 24, " px"),
      h("div.row", { style: { flexWrap: "wrap" } },
        h("button.btn.soft.sm", { type: "button", onclick: uploadBg }, icon("camera", "sm"), "Заменить фото"),
        h("button.btn.ghost.sm", { type: "button", onclick: removeBg }, icon("trash", "sm"), "Удалить фото")),
    ] : bgImage ? [h("p.muted.small-note", "Ваше фото сохранено — выберите «Своё фото», чтобы вернуть его.")] : []));
  };

  // ------------------------------------------------ шрифты
  const fontGrid = h("div.font-grid", { role: "radiogroup", "aria-label": "Шрифт" });
  const paintFonts = () => fontGrid.replaceChildren(...Object.entries(FONTS).map(([key, f]) => h("button.font-tile", {
    type: "button", role: "radio", "aria-checked": String(look.font === key), onclick: () => update({ font: key }),
  }, h("span.ft-aa", { style: { fontFamily: fontStack(key, true) } }, "Аа"),
    h("span.ft-name", { style: { fontFamily: fontStack(key) } }, f.name))));

  // ------------------------------------------------ углы и анимации
  const shapeSeg = h("div.segmented", { role: "group", "aria-label": "Форма углов" });
  const paintShape = () => shapeSeg.replaceChildren(...Object.entries(SHAPES).map(([v, t]) => h("button", {
    type: "button", "aria-pressed": String(v === look.shape), onclick: () => update({ shape: v }),
  }, t)));

  const motionSeg = h("div.segmented", { role: "group", "aria-label": "Анимации" });
  const paintMotion = (cur) => motionSeg.replaceChildren(...[["full", "Все эффекты"], ["reduced", "Минимум движения"]].map(([v, t]) => h("button", {
    type: "button", "aria-pressed": String(v === cur), onclick: () => { setMotion(v); paintMotion(v); },
  }, t)));

  function paint() {
    paintPresets(); paintMode(); paintSwatches(); paintBg(); paintFonts(); paintShape();
  }
  paint();
  paintMotion(currentMotion());

  const reset = h("button.btn.ghost.sm.icon-only", { type: "button", onclick: () => {
    setMode("system");
    update({ ...PRESETS.orbit, preset: "orbit", palette: "violet", custom: null, dim: 35, blur: 0 }, { keepPreset: true });
    paint();
  }, title: "Сбросить оформление", "aria-label": "Сбросить оформление" }, icon("repeat", "sm"));

  // ---- компактная раскладка: переключатель светлая/тёмная сверху и вкладки
  const PANES = {
    themes: ["Темы", () => [presetsBox]],
    color: ["Цвет", () => [swatches]],
    bg: ["Фон", () => [bgGrid, bgExtra]],
    font: ["Шрифт", () => [fontGrid]],
    more: ["Ещё", () => [
      h("div.look-row", h("span", "Углы"), shapeSeg),
      h("div.look-row", h("span", "Анимации", h("small.muted", "На слабых телефонах можно выключить")), motionSeg),
    ]],
  };
  let pane = "themes";
  try { pane = sessionStorage.getItem("krug-look-pane") || "themes"; } catch { /* нет хранилища */ }
  if (!PANES[pane]) pane = "themes";
  const paneTabs = h("div.look-tabs", { role: "tablist" });
  const paneBody = h("div.look-pane");
  const paintPane = () => {
    paneTabs.replaceChildren(...Object.entries(PANES).map(([k, [label]]) => h("button", {
      type: "button", role: "tab", "aria-selected": String(k === pane),
      onclick: () => { pane = k; try { sessionStorage.setItem("krug-look-pane", k); } catch { /* */ } paintPane(); },
    }, label)));
    paneBody.replaceChildren(...PANES[pane][1]());
  };
  paintPane();

  return h("section.card.settings-section.look-section",
    h("div.look-top", h("h2", "Оформление"), h("div.spacer"), modeSeg, reset),
    paneTabs, paneBody);
}