// Рынок: купить рамки и титулы у других людей или выставить свои. 1% за лот и 7% со сделки сгорают.
import { api, state } from "../api.js";
import { h, icon, avatar, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, busy, modal, confirmDialog } from "../ui.js";
import { decorate } from "../components/cosmetics.js";

const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");
const TABS = [["buy", "Купить"], ["mine", "Мои лоты"]];

function preview(item) {
  if (item.kind === "frame") {
    const a = avatar(state.me, "lg", { presence: false, frame: false });
    a.dataset.frame = item.id;
    return h("div.shop-preview", a);
  }
  if (item.kind === "aura") return h("div.shop-preview", h("div.shop-aura-stage", decorate(avatar(state.me, "xl", { presence: false, frame: false }), { aura: item.id })));
  if (item.kind === "namefx") return h("div.shop-preview", h("span.pname.shop-name", { dataset: { namefx: item.id } }, state.me?.name || "Имя"));
  return h("div.shop-preview.title", h("span.profile-title", { dataset: item.style ? { style: item.style } : {} }, item.name));
}

export async function marketPage({ query = {} } = {}) {
  setTitle("Рынок");
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : "buy";
  let kind = "", sort = "new", kc = 0;
  const bal = h("b.shop-bal");
  const tabs = h("div.set-tabs.shop-tabs", { role: "tablist" });
  const filters = h("div.market-filters");
  const body = h("div.stack");
  const paintBal = () => { bal.textContent = `🪙 ${fmt(kc)} KC`; };

  async function loadBuy() {
    body.replaceChildren(h("div.spinner"));
    try {
      const d = await api.get("/api/market", { kind, sort });
      kc = d.kc; paintBal();
      body.replaceChildren(d.items.length ? h("div.shop-grid", ...d.items.map((l) => {
        const deal = l.price < l.ref * 0.9;
        return h("div.shop-card", preview(l.item), h("b", l.item.name),
          h("small", `Справочная цена ${fmt(l.ref)} KC`),
          h("a.market-seller", { href: `/u/${l.seller.username}` }, avatar(l.seller, "xs", { presence: false }), l.seller.name.split(" ")[0], " · ", timeAgo(l.at)),
          deal ? h("span.market-deal", "Выгодно") : null,
          l.mine ? h("span.muted", "Ваш лот")
            : h("button.btn.primary.sm", { type: "button", disabled: kc < l.price, onclick: (e) => busy(e.currentTarget, async () => {
              if (!(await confirmDialog({ title: `Купить «${l.item.name}» за ${fmt(l.price)} KC?`, text: "Предмет сразу появится у вас. Монеты уйдут продавцу, 7% сгорает.", confirm: "Купить" }))) return;
              try { const r = await api.post(`/api/market/${l.id}/buy`); kc = r.kc; toast("Куплено — найдите предмет в магазине", { icon: "check" }); document.dispatchEvent(new CustomEvent("wallet:changed")); loadBuy(); } catch (err) { toastError(err); }
            }) }, `${fmt(l.price)} KC`));
      })) : h("div.card.empty", icon("gift"), h("h2", "Лотов пока нет"), h("p", "Купленные в магазине рамки и титулы можно продать здесь через 7 дней.")));
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
  }

  async function sell(it) {
    const price = h("input.input", { type: "number", min: it.min, max: it.max, value: it.ref });
    const calc = h("small.muted");
    const upd = () => { const p = +price.value || 0; calc.textContent = `Сбор за выставление ${Math.max(5, Math.round(p * 0.01))} KC · вы получите ${fmt(p - Math.max(1, Math.round(p * 0.07)))} KC после продажи`; };
    price.addEventListener("input", upd); upd();
    const go = h("button.btn.primary", { type: "button" }, "Выставить");
    const m = modal({ title: `Продать «${it.name}»`, narrow: true, body: h("div.stack",
      h("div.field", h("label", `Цена, KC (от ${fmt(it.min)} до ${fmt(it.max)})`), price, calc),
      h("p.field-hint", `Справочная цена — ${fmt(it.ref)} KC. Пока лот на рынке, предмет снимается с вашего профиля; снять лот можно в любой момент.`)),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), go] });
    go.addEventListener("click", () => busy(go, async () => {
      try { await api.post("/api/market", { item_id: it.id, price: +price.value || 0 }); m.close(); toast("Лот выставлен", { icon: "check" }); document.dispatchEvent(new CustomEvent("wallet:changed")); loadMine(); } catch (e) { toastError(e); }
    }));
  }

  async function loadMine() {
    body.replaceChildren(h("div.spinner"));
    try {
      const d = await api.get("/api/market/mine");
      kc = d.kc; paintBal();
      const st = { active: "На продаже", sold: "Продан", cancelled: "Снят" };
      body.replaceChildren(
        h("section.card.wl-card", h("div.wl-head", h("h2", "Можно продать")),
          d.sellable.length ? h("div.market-sell", ...d.sellable.map((it) => h("div.wl-h-row",
            h("div.grow", h("b", it.name), h("small", it.ready ? `Справочная цена ${fmt(it.ref)} KC` : `Можно продать через 7 дней после получения`)),
            h("button.btn.soft.sm", { type: "button", disabled: !it.ready, onclick: () => sell(it) }, "Продать"))))
            : h("p.muted", "Купите рамку или титул в магазине — через 7 дней их можно будет продать.")),
        h("section.card.wl-card", h("div.wl-head", h("h2", "Мои лоты")),
          d.items.length ? h("div", ...d.items.map((l) => h("div.wl-h-row",
            h("div.grow", h("b", l.item.name), h("small", `${st[l.status]} · ${fmt(l.price)} KC · ${timeAgo(l.closed_at || l.at)}`)),
            l.status === "active" ? h("button.btn.ghost.sm", { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
              try { await api.del(`/api/market/${l.id}`); toast("Лот снят, предмет вернулся", { icon: "check" }); loadMine(); } catch (err) { toastError(err); }
            }) }, "Снять") : null)))
            : h("p.muted", "Пока нет лотов.")));
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
  }

  function paint() {
    tabs.replaceChildren(...TABS.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab),
      onclick: () => { tab = k; history.replaceState(history.state, "", `/market?tab=${k}`); paint(); } }, t)));
    filters.replaceChildren(...(tab === "buy" ? [
      h("div.segmented", ...[["", "Всё"], ["frame", "Рамки"], ["aura", "Ауры"], ["namefx", "Имя"], ["title", "Титулы"]].map(([k, t]) => h("button", { type: "button", "aria-pressed": String(kind === k), onclick: () => { kind = k; paint(); } }, t))),
      h("div.segmented", ...[["new", "Новые"], ["cheap", "Дешевле"], ["deal", "Выгоднее"]].map(([k, t]) => h("button", { type: "button", "aria-pressed": String(sort === k), onclick: () => { sort = k; paint(); } }, t))),
    ] : []));
    tab === "buy" ? loadBuy() : loadMine();
  }
  paint();
  return h("div.stack.shop-page",
    h("div.page-head.shop-head", h("h1", "Рынок"), bal),
    h("p.field-hint.shop-note", "Люди продают друг другу рамки и титулы. За выставление сгорает 1%, со сделки — 7%. Достижения, репутация и галочки не продаются."),
    tabs, filters, body,
    h("a.shop-earn", { href: "/shop" }, icon("gift", "sm"), "В магазин"));
}
