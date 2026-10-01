// Магазин оформления за KC: рамки аватара, титулы, подарки друзьям. Монеты за покупки сгорают.
import { api, state } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { setTitle, toast, toastError, busy, modal } from "../ui.js";
import { refreshSidebarUser } from "../components/layout.js";

const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");
const TABS = [["frames", "Рамки"], ["titles", "Титулы"], ["gifts", "Подарки"]];

export async function shopPage({ query = {} } = {}) {
  setTitle("Магазин");
  let d = await api.get("/api/shop");
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : "frames";
  const bal = h("b.shop-bal");
  const tabs = h("div.set-tabs.shop-tabs", { role: "tablist" });
  const body = h("div.shop-grid");

  const paintBal = () => { bal.textContent = `🪙 ${fmt(d.kc)} KC`; };
  const done = (next, text) => { d = next; paintBal(); paint(); toast(text, { icon: "check", duration: 1600 }); document.dispatchEvent(new CustomEvent("wallet:changed")); };

  const buyBtn = (it) => h("button.btn.primary.sm", { type: "button", disabled: d.kc < it.price, onclick: (e) => busy(e.currentTarget, async () => {
    try { done(await api.post("/api/shop/buy", { item_id: it.id }), `«${it.name}» куплено`); } catch (err) { toastError(err); }
  }) }, `${fmt(it.price)} KC`);

  function frameCard(it) {
    const preview = avatar(state.me, "lg", { presence: false, frame: false });
    preview.dataset.frame = it.id;
    const action = !it.owned ? buyBtn(it)
      : h(`button.btn.${it.on ? "ghost" : "soft"}.sm`, { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
        try {
          await api.patch("/api/collection/equip", { slot: "frame", item_id: it.on ? null : it.id });
          d = await api.get("/api/shop"); paint(); refreshSidebarUser();
          toast(it.on ? "Рамка снята" : "Рамка надета", { icon: "check", duration: 1400 });
        } catch (err) { toastError(err); }
      }) }, it.on ? "Снять" : "Надеть");
    return h(`div.shop-card${it.on ? ".on" : ""}`, h("div.shop-preview", preview), h("b", it.name), h("small", it.desc), action);
  }

  function titleCard(it) {
    const action = !it.owned ? buyBtn(it)
      : h(`button.btn.${it.on ? "ghost" : "soft"}.sm`, { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
        try { done(await api.post("/api/shop/title", { item_id: it.on ? null : it.id }), it.on ? "Титул снят" : "Титул показан в профиле"); } catch (err) { toastError(err); }
      }) }, it.on ? "Снять" : "Показать");
    return h(`div.shop-card${it.on ? ".on" : ""}`, h("div.shop-preview.title", h("span.profile-title", `✦ ${it.name}`)), h("b", it.name), h("small", "Под именем в профиле"), action);
  }

  async function sendGift(it) {
    let friends = [];
    try { friends = (await api.get(`/api/users/${state.me.username}/friends`)).items || []; } catch { /* ничего */ }
    let to = null;
    const list = h("div.pick-list");
    const note = h("input.input", { maxlength: 120, placeholder: "Пара тёплых слов (необязательно)" });
    const go = h("button.btn.primary", { type: "button", disabled: true }, `Подарить за ${fmt(it.price)} KC`);
    const draw = () => list.replaceChildren(...(friends.length ? friends.map((f) => h(`button.mini-person${to === f.username ? ".on" : ""}`, { type: "button",
      onclick: () => { to = f.username; go.disabled = false; draw(); } }, avatar(f, "sm", { presence: false }), h("div.who", h("span.name", f.name), h("span.sub", `@${f.username}`))))
      : [h("p.muted", "Добавьте друзей, чтобы дарить им подарки.")]));
    draw();
    const m = modal({ title: `${it.emoji} ${it.name}`, narrow: true, body: h("div.stack", h("small.muted", "Кому"), list, note),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), go] });
    go.addEventListener("click", () => busy(go, async () => {
      try {
        const r = await api.post("/api/shop/gift", { to, item_id: it.id, note: note.value });
        m.close(); d.kc = r.kc; paintBal();
        toast(`Подарок отправлен ${it.emoji}`, { icon: "gift" });
        document.dispatchEvent(new CustomEvent("wallet:changed"));
      } catch (err) { toastError(err); }
    }));
  }

  function giftCard(it) {
    return h("div.shop-card", h("div.shop-preview.gift", it.emoji), h("b", it.name), h("small", "Появится у друга в профиле"),
      h("button.btn.primary.sm", { type: "button", disabled: d.kc < it.price, onclick: () => sendGift(it) }, `${fmt(it.price)} KC`));
  }

  function paint() {
    tabs.replaceChildren(...TABS.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab),
      onclick: () => { tab = k; history.replaceState(history.state, "", `/shop?tab=${k}`); paint(); } }, t)));
    body.replaceChildren(...(tab === "frames" ? d.frames.map(frameCard) : tab === "titles" ? d.titles.map(titleCard) : d.gifts.map(giftCard)));
  }
  paintBal(); paint();
  return h("div.stack.shop-page",
    h("div.page-head.shop-head", h("h1", "Магазин"), bal),
    h("p.field-hint.shop-note", "Только оформление: покупки не дают охвата, рейтинга или репутации. Все монеты за покупки сгорают — так экономика остаётся честной."),
    tabs, body,
    h("div.row.shop-links", h("a.shop-earn", { href: "/market" }, icon("repeat", "sm"), "Рынок: купить у людей или продать своё"),
      h("a.shop-earn", { href: "/wallet" }, icon("coin", "sm"), "Как заработать монеты")));
}
