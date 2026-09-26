// Коллекция: редкие рамки, анимации, эффекты и питомцы. Купить нельзя — только заработать.
import { api, state } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { setTitle, toast, toastError, modal } from "../ui.js";
import { decorate, pet, mountEffect, itemPreview, RARITY_LABEL, SLOT_LABEL } from "../components/cosmetics.js";
import { burst } from "../fx.js";

const RARITY_ORDER = ["legendary", "epic", "rare", "common"];

export async function collectionPage({ query }) {
  setTitle("Коллекция");
  const data = await api.get("/api/collection");
  let slot = query.slot && SLOT_LABEL[query.slot] ? query.slot : "frame";

  const stage = h("div.coll-stage");
  const tabs = h("div.tabs.coll-tabs", { role: "tablist" });
  const grid = h("div.item-grid");
  const summary = h("div.coll-summary");

  function paintStage() {
    const eq = data.equipped;
    const av = decorate(avatar({ ...state.me, frame: eq.frame }, "xl", { presence: false }), eq);
    stage.replaceChildren(h("div.coll-stage-inner", av, eq.pet ? pet(eq.pet) : null));
    if (eq.effect) mountEffect(stage, eq.effect);
  }

  function paintSummary() {
    const pct = Math.round((data.owned_count / data.total) * 100);
    const byRarity = RARITY_ORDER.map((r) => [r, data.items.filter((i) => i.owned && i.rarity === r).length]);
    summary.replaceChildren(
      h("div.coll-ring", { style: { "--p": String(pct) } }, h("b", `${data.owned_count}`), h("small", `из ${data.total}`)),
      h("div.coll-text",
        h("h1", "Моя коллекция"),
        h("p.muted", "Редкие рамки, анимации, эффекты и питомцы. Их нельзя купить — только заработать активностью в Круге."),
        h("div.rarity-chips", byRarity.map(([r, n]) => h(`span.rarity-chip.${r}`, `${RARITY_LABEL[r]}: ${n}`)))));
  }

  function paintTabs() {
    tabs.replaceChildren(...Object.entries(SLOT_LABEL).map(([k, label]) => {
      const owned = data.items.filter((i) => i.slot === k && i.owned).length;
      const all = data.items.filter((i) => i.slot === k).length;
      return h("button", { type: "button", role: "tab", "aria-selected": String(k === slot), onclick: () => { slot = k; history.replaceState({}, "", `/collection?slot=${k}`); paintTabs(); paintGrid(); } },
        label, h("span.tab-count", `${owned}/${all}`));
    }));
  }

  function paintGrid() {
    const items = data.items.filter((i) => i.slot === slot)
      .sort((a, b) => (b.owned - a.owned) || (RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity)));
    grid.replaceChildren(...items.map((it) => {
      const equipped = data.equipped[slot] === it.id;
      const pct = Math.round((it.progress / it.need) * 100);
      const btn = it.owned
        ? h(`button.btn.sm${equipped ? ".soft" : ".primary"}`, { type: "button", onclick: (e) => equip(it, !equipped, e.currentTarget) }, equipped ? "Снять" : "Надеть")
        : h("div.item-lock", icon("lock", "sm"), "Нужно заработать");
      return h(`article.item-card.${it.rarity}${it.owned ? "" : ".locked"}${equipped ? ".equipped" : ""}`,
        h("div.item-top", itemPreview(it, state.me), equipped ? h("span.item-on", icon("check", "sm")) : null),
        h(`span.rarity-tag.${it.rarity}`, it.rarity_label),
        h("h3", it.name),
        h("p.item-desc", it.description),
        it.owned
          ? h("p.item-cond.done", icon("check", "sm"), it.condition)
          : h("div.item-progress", h("p.item-cond", it.condition),
            h("div.bar", h("i", { style: { width: `${pct}%` } })), h("small", `${it.progress} / ${it.need}`)),
        btn);
    }));
  }

  async function equip(it, on, btn) {
    try {
      const res = await api.patch("/api/collection/equip", { slot: it.slot, item_id: on ? it.id : null });
      data.equipped = res.equipped;
      if (on) { burst(btn, "✨", 12); toast(`«${it.name}» теперь в вашем профиле`, { icon: "check" }); }
      paintStage(); paintGrid();
    } catch (e) { toastError(e); }
  }

  paintStage(); paintSummary(); paintTabs(); paintGrid();
  if (data.new?.length) setTimeout(() => showReveal(data.items.find((i) => i.id === data.new[0])), 400);

  return h("div.stack",
    h("section.card.coll-hero", stage, summary),
    h("div.card", tabs),
    grid);
}

/** Праздничное окно при получении предмета */
export function showReveal(item, onEquip) {
  if (!item) return;
  const art = itemPreview({ ...item, slot: item.slot }, state.me);
  const equipBtn = h("button.btn.primary", { type: "button" }, "Надеть сейчас");
  const m = modal({
    title: "Новый предмет!", narrow: true,
    body: h(`div.reveal.${item.rarity}`,
      h("div.reveal-glow"),
      h("div.reveal-art", art),
      h(`span.rarity-tag.${item.rarity}`, item.rarity_label || RARITY_LABEL[item.rarity]),
      h("h2", item.name),
      h("p.muted", "Предмет заработан за вашу активность и останется у вас навсегда.")),
    footer: [h("a.btn.ghost", { href: `/collection?slot=${item.slot}`, onclick: () => m.close() }, "В коллекцию"), equipBtn],
  });
  equipBtn.addEventListener("click", async () => {
    try {
      await api.patch("/api/collection/equip", { slot: item.slot, item_id: item.id });
      m.close();
      toast(`«${item.name}» теперь в вашем профиле`, { icon: "check" });
      onEquip?.();
    } catch (e) { toastError(e); }
  });
  setTimeout(() => burst(equipBtn, "✨", 18), 250);
}
