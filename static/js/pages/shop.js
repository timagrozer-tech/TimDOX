// Магазин оформления за KC: рамки, ауры, эффекты имени, титулы, подарки друзьям. Монеты за покупки сгорают.
import { api, state } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { setTitle, toast, toastError, busy, modal } from "../ui.js";
import { refreshSidebarUser } from "../components/layout.js";
import { decorate } from "../components/cosmetics.js";

const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");
const TABS = [["frames", "Рамки"], ["auras", "Ауры"], ["names", "Имя"], ["titles", "Титулы"], ["gifts", "Подарки"]];
const FILTERS = [["all", "Все"], ["new", "Новинки"], ["top", "Эпические и выше"]];
const NOTE = {
  frames: "Рамка видна везде, где есть ваш аватар: в ленте, комментариях и чатах.",
  auras: "Аура — живые частицы вокруг аватара в вашем профиле.",
  names: "Эффект имени — анимация вашего имени в шапке профиля.",
  titles: "Титул — плашка под именем в профиле.",
  gifts: "Подарок появится у друга в профиле вместе с вашим именем.",
};

export async function shopPage({ query = {} } = {}) {
  setTitle("Магазин");
  let d = await api.get("/api/shop");
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : "frames";
  let filter = "all";
  const bal = h("b.shop-bal");
  const tabs = h("div.set-tabs.shop-tabs", { role: "tablist" });
  const filters = h("div.segmented.shop-filter", { role: "group", "aria-label": "Фильтр" });
  const note = h("p.field-hint.shop-tabnote");
  const body = h("div.shop-grid");

  const paintBal = () => { bal.textContent = `🪙 ${fmt(d.kc)} KC`; };
  const done = (next, text) => { d = next; paintBal(); paint(); toast(text, { icon: "check", duration: 1600 }); document.dispatchEvent(new CustomEvent("wallet:changed")); };

  const buyBtn = (it) => h("button.btn.primary.sm", { type: "button", disabled: d.kc < it.price, onclick: (e) => busy(e.currentTarget, async () => {
    try { done(await api.post("/api/shop/buy", { item_id: it.id }), `«${it.name}» куплено`); } catch (err) { toastError(err); }
  }) }, `${fmt(it.price)} KC`);

  const wearBtn = (it, run) => h(`button.btn.${it.on ? "ghost" : "soft"}.sm`, { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
    try { await run(); } catch (err) { toastError(err); }
  }) }, it.on ? "Снять" : "Надеть");

  const badges = (it) => h("div.shop-badges",
    h(`span.rar.r-${it.rarity}`, it.rarity_label),
    it.new ? h("span.shop-new", "Новинка") : null);

  function card(it, preview, action, desc = it.desc) {
    return h(`div.shop-card.r-${it.rarity}${it.on ? ".on" : ""}`, badges(it), h("div.shop-preview", preview), h("b", it.name), h("small", desc), action);
  }

  function frameCard(it) {
    const a = avatar(state.me, "lg", { presence: false, frame: false });
    a.dataset.frame = it.id;
    const action = !it.owned ? buyBtn(it) : wearBtn(it, async () => {
      await api.patch("/api/collection/equip", { slot: "frame", item_id: it.on ? null : it.id });
      d = await api.get("/api/shop"); paint(); refreshSidebarUser();
      toast(it.on ? "Рамка снята" : "Рамка надета", { icon: "check", duration: 1400 });
    });
    return card(it, a, action);
  }

  function auraCard(it) {
    const prev = decorate(avatar(state.me, "xl", { presence: false, frame: false }), { aura: it.id });
    const action = !it.owned ? buyBtn(it) : wearBtn(it, async () => {
      done(await api.post("/api/shop/equip", { slot: "aura", item_id: it.on ? null : it.id }), it.on ? "Аура снята" : "Аура надета — загляните в профиль");
    });
    return card(it, h("div.shop-aura-stage", prev), action);
  }

  function nameCard(it) {
    const prev = h("span.pname.shop-name", { dataset: { namefx: it.id } }, state.me?.name || "Ваше имя");
    const action = !it.owned ? buyBtn(it) : wearBtn(it, async () => {
      done(await api.post("/api/shop/equip", { slot: "namefx", item_id: it.on ? null : it.id }), it.on ? "Эффект снят" : "Имя засияло — загляните в профиль");
    });
    return card(it, prev, action);
  }

  function titleCard(it) {
    const action = !it.owned ? buyBtn(it) : wearBtn(it, async () => {
      done(await api.post("/api/shop/title", { item_id: it.on ? null : it.id }), it.on ? "Титул снят" : "Титул показан в профиле");
    });
    return card(it, h("span.profile-title", { dataset: it.style ? { style: it.style } : {} }, it.name), action, it.style ? "Анимированная плашка под именем" : "Плашка под именем в профиле");
  }

  async function sendGift(it) {
    let friends = [];
    try { friends = (await api.get(`/api/users/${state.me.username}/friends`)).items || []; } catch { /* ничего */ }
    let to = null;
    const list = h("div.pick-list");
    const note2 = h("input.input", { maxlength: 120, placeholder: "Пара тёплых слов (необязательно)" });
    const go = h("button.btn.primary", { type: "button", disabled: true }, `Подарить за ${fmt(it.price)} KC`);
    const draw = () => list.replaceChildren(...(friends.length ? friends.map((f) => h(`button.mini-person${to === f.username ? ".on" : ""}`, { type: "button",
      onclick: () => { to = f.username; go.disabled = false; draw(); } }, avatar(f, "sm", { presence: false }), h("div.who", h("span.name", f.name), h("span.sub", `@${f.username}`))))
      : [h("p.muted", "Добавьте друзей, чтобы дарить им подарки.")]));
    draw();
    const m = modal({ title: `${it.emoji} ${it.name}`, narrow: true, body: h("div.stack", h("small.muted", "Кому"), list, note2),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), go] });
    go.addEventListener("click", () => busy(go, async () => {
      try {
        const r = await api.post("/api/shop/gift", { to, item_id: it.id, note: note2.value });
        m.close(); d.kc = r.kc; paintBal();
        toast(`Подарок отправлен ${it.emoji}`, { icon: "gift" });
        document.dispatchEvent(new CustomEvent("wallet:changed"));
      } catch (err) { toastError(err); }
    }));
  }

  function giftCard(it) {
    return h(`div.shop-card.r-${it.rarity}`, h("div.shop-preview.gift", h("span.gift-emoji", it.emoji)), h("b", it.name), h("small", "Появится у друга в профиле"),
      h("button.btn.primary.sm", { type: "button", disabled: d.kc < it.price, onclick: () => sendGift(it) }, `${fmt(it.price)} KC`));
  }

  const RENDER = { frames: frameCard, auras: auraCard, names: nameCard, titles: titleCard, gifts: giftCard };
  function paint() {
    tabs.replaceChildren(...TABS.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab),
      onclick: () => { tab = k; history.replaceState(history.state, "", `/shop?tab=${k}`); paint(); } }, t,
      ["auras", "names"].includes(k) ? h("i.tab-dot", { "aria-hidden": "true" }) : null)));
    filters.hidden = tab === "gifts";
    filters.replaceChildren(...FILTERS.map(([k, t]) => h("button", { type: "button", "aria-pressed": String(filter === k), onclick: () => { filter = k; paint(); } }, t)));
    note.textContent = NOTE[tab];
    let items = d[tab] || [];
    if (tab !== "gifts" && filter === "new") items = items.filter((x) => x.new);
    if (tab !== "gifts" && filter === "top") items = items.filter((x) => x.rarity === "epic" || x.rarity === "legendary");
    body.replaceChildren(...(items.length ? items.map(RENDER[tab]) : [h("p.muted", "Здесь пока пусто.")]));
  }
  paintBal(); paint();
  return h("div.stack.shop-page",
    h("div.page-head.shop-head", h("h1", "Магазин"), bal),
    h("p.field-hint.shop-note", "Только оформление: покупки не дают охвата, рейтинга или репутации. Все монеты за покупки сгорают — так экономика остаётся честной."),
    tabs, h("div.shop-toolbar", filters, note), body,
    h("div.row.shop-links", h("a.shop-earn", { href: "/market" }, icon("repeat", "sm"), "Рынок: купить у людей или продать своё"),
      h("a.shop-earn", { href: "/wallet" }, icon("coin", "sm"), "Как заработать монеты")));
}
