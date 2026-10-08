// «Настроить пространство»: режим профиля и блоки, которые владелец показывает и упорядочивает.
// Навигация Yarko, поиск, сообщения и записи не скрываются никогда — меняется только сам профиль.
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, busy, toastError, toast } from "../ui.js";

export const SPACE_MODES = {
  classic: { name: "Классика", hint: "Всё по умолчанию", tab: "posts", order: ["about", "showcase", "constellation"], hidden: [] },
  creator: { name: "Автор", hint: "Публикации и аудитория впереди", tab: "posts", order: ["constellation", "about", "showcase"], hidden: ["showcase"] },
  project: { name: "Проекты", hint: "Ссылки на работы и команды", tab: "posts", order: ["constellation", "about", "showcase"], hidden: [] },
  city: { name: "Город", hint: "Достижения и коллекции", tab: "posts", order: ["showcase", "constellation", "about"], hidden: [] },
  professional: { name: "Профессионал", hint: "Опыт и учёба развёрнуты", tab: "posts", order: ["about", "constellation", "showcase"], hidden: ["showcase"] },
  gamer: { name: "Игрок", hint: "Игровые миры и коллекции", tab: "photos", order: ["constellation", "showcase", "about"], hidden: [] },
  minimal: { name: "Минимум", hint: "Только главное", tab: "posts", order: ["about", "constellation", "showcase"], hidden: ["showcase", "constellation"] },
};
const BLOCKS = { about: "О себе и данные", showcase: "Витрина коллекции", constellation: "Созвездие ✦" };

export function openSpaceEditor(space, onSave) {
  let mode = space.mode;
  let order = space.order.filter((b) => BLOCKS[b]);
  let hidden = new Set(space.hidden);
  const modes = h("div.space-modes");
  const blocks = h("div.space-blocks-list");
  const paintModes = () => modes.replaceChildren(...Object.entries(SPACE_MODES).map(([id, m]) => h("button.space-mode", {
    type: "button", "aria-pressed": String(id === mode),
    onclick: () => { mode = id; order = [...m.order]; hidden = new Set(m.hidden); paintModes(); paintBlocks(); },
  }, h("b", m.name), h("small", m.hint))));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; paintBlocks(); };
  const paintBlocks = () => blocks.replaceChildren(...order.map((b, i) => h("div.space-row",
    h("label.set-switch", h("span", BLOCKS[b]), h("input", { type: "checkbox", role: "switch", checked: !hidden.has(b),
      onchange: (e) => { e.target.checked ? hidden.delete(b) : hidden.add(b); } })),
    h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Выше: ${BLOCKS[b]}`, disabled: i === 0, onclick: () => move(i, -1) }, icon("up", "sm")),
    h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Ниже: ${BLOCKS[b]}`, disabled: i === order.length - 1, onclick: () => move(i, 1) }, icon("down", "sm")))));
  paintModes(); paintBlocks();
  const save = h("button.btn.primary", { type: "button" }, "Применить");
  const m = modal({
    title: "Настроить пространство",
    body: h("div.stack", h("div.set-group-title", "Режим профиля"), modes,
      h("div.set-group-title", "Блоки"), blocks,
      h("p.field-hint", "Записи, друзья и навигация Yarko всегда на месте — меняется только вид вашего профиля.")),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
  });
  save.addEventListener("click", () => busy(save, async () => {
    try {
      const next = await api.put("/api/me/space", { mode, order, hidden: [...hidden] });
      m.close();
      onSave(next);
      toast("Пространство обновлено", { icon: "check", duration: 1600 });
    } catch (e) { toastError(e); }
  }));
}
