// Конструктор 3D-аватара: живое превью, вкладки, «Случайно». Сохраняет параметры и снимок-картинку
// (снимок — аватар для ленты, комментариев и чатов; в профиле персонаж живой).
import { api, state } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, toast, toastError, busy } from "../ui.js";
import { refreshSidebarUser } from "./layout.js";
import { mount3D, PALETTES, OPTIONS, DEFAULT_SPEC, randomSpec, bgCss } from "./avatar3d.js";

const TABS = [
  ["face", "Лицо"], ["hair", "Волосы"], ["eyes", "Глаза и рот"], ["acc", "Аксессуары"], ["outfit", "Одежда"], ["bg", "Фон"],
];

export function webglAvailable() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

export async function openAvatar3DEditor(current, onSaved) {
  if (!webglAvailable()) { toast("Браузер не поддерживает 3D (WebGL)", { error: true }); return; }
  let spec = { ...DEFAULT_SPEC, ...(current || {}) };
  const stage = h("div.av3d-stage", { style: { background: bgCss(spec) } }, h("div.spinner"));
  const tabs = h("div.segmented.av3d-tabs", { role: "tablist" });
  const panel = h("div.av3d-panel");
  let tab = "face";
  let view = null;

  const set = (k, v) => {
    spec = { ...spec, [k]: v };
    stage.style.background = bgCss(spec);
    view?.update(spec);
    paint();
  };
  const group = (title, ...children) => h("div.av3d-group", h("small", title), h("div.av3d-row", ...children));
  const chips = (key) => OPTIONS[key].map(([v, label]) => h(`button.chip${spec[key] === v ? ".on" : ""}`, { type: "button", "aria-pressed": String(spec[key] === v), onclick: () => set(key, v) }, label));
  const swatches = (key) => PALETTES[key].map((c, i) => h(`button.av3d-sw${spec[key] === i ? ".on" : ""}`, {
    type: "button", "aria-label": `Цвет ${i + 1}`, "aria-pressed": String(spec[key] === i), onclick: () => set(key, i),
    style: { background: Array.isArray(c) ? `radial-gradient(circle at 30% 25%, ${c[0]}, ${c[1]})` : c } }));
  const toggle = (key, label) => h(`button.chip${spec[key] ? ".on" : ""}`, { type: "button", "aria-pressed": String(!!spec[key]), onclick: () => set(key, !spec[key]) }, label);

  function paint() {
    tabs.replaceChildren(...TABS.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-pressed": String(tab === k), onclick: () => { tab = k; paint(); } }, t)));
    const P = {
      face: () => [group("Кожа", ...swatches("skin")), group("Нос", ...chips("nose")), group("Детали", toggle("cheeks", "Румянец"), toggle("freckles", "Веснушки")),
        group("Борода и усы", ...chips("facial"))],
      hair: () => [group("Причёска", ...chips("hair")), group("Цвет волос", ...swatches("hairColor"))],
      eyes: () => [group("Глаза", ...chips("eyes")), group("Цвет глаз", ...swatches("eyeColor")), group("Брови", ...chips("brows")), group("Рот", ...chips("mouth"))],
      acc: () => [group("Аксессуар", ...chips("acc")), group("Цвет", ...swatches("accColor"))],
      outfit: () => [group("Одежда", ...chips("outfit")), group("Цвет", ...swatches("outfitColor"))],
      bg: () => [group("Фон", ...swatches("bg"))],
    };
    panel.replaceChildren(...P[tab]());
  }
  paint();

  const dice = h("button.btn.ghost", { type: "button", onclick: () => { spec = randomSpec(); stage.style.background = bgCss(spec); view?.update(spec); paint(); } }, "🎲 Случайно");
  const save = h("button.btn.primary", { type: "button" }, "Сохранить");
  const m = modal({
    title: "3D-аватар",
    body: h("div.av3d-editor", stage, h("p.field-hint.av3d-hint", "Крутите пальцем, нажмите — подпрыгнет. В профиле аватар живой, в ленте и чатах — его снимок."), tabs, panel),
    footer: [dice, h("span.grow"), h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
    onClose: () => { view?.destroy(); view = null; },
  });
  view = await mount3D(stage, spec, { interactive: true, snapshotable: true, zoom: 1.05 });
  stage.querySelector(".spinner")?.remove();
  if (!view) { m.close(); toast("Не удалось запустить 3D", { error: true }); return; }

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
      m.close();
      toast("3D-аватар готов ✨", { icon: "check" });
      onSaved?.(r.avatar3d, res.avatar);
    } catch (e) { toastError(e); }
  }));
}
