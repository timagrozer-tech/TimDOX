// Друзья: список, заявки, рекомендации, заблокированные.
import { api, state, setCounters } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";
import { personRow, defaultPersonActions, friendButton, openChat } from "../components/people.js";

export async function friendsPage({ query }) {
  setTitle("Друзья");
  const tabs = [
    { id: "all", label: "Мои друзья" },
    { id: "requests", label: "Заявки", badge: "friend_requests" },
    { id: "suggestions", label: "Возможно, знакомы" },
    { id: "blocked", label: "Чёрный список" },
  ];
  const tabBar = h("div.tabs", { role: "tablist" });
  const content = h("div");
  let current = tabs.some((t) => t.id === query.tab) ? query.tab : "all";

  const card = (...c) => h("div.card", ...c);
  const empty = (ic, title, text, extra) => h("div.empty", icon(ic), h("h3", title), text ? h("p", text) : null, extra || null);

  async function draw() {
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === current)));
    history.replaceState({}, "", current === "all" ? "/friends" : `/friends?tab=${current}`);
    content.replaceChildren(card(h("div.spinner")));
    try {
      if (current === "all") {
        const { items } = await api.get(`/api/users/${state.me.username}/friends`);
        if (!items.length) return content.replaceChildren(card(empty("users", "У вас пока нет друзей", "Найдите знакомых по имени, городу, месту учёбы или работы.",
          h("a.btn.primary", { href: "/friends?tab=suggestions", onclick: (e) => { e.preventDefault(); current = "suggestions"; draw(); } }, "Найти друзей"))));
        const filter = h("input.input", { type: "search", placeholder: "Поиск среди друзей", "aria-label": "Поиск среди друзей" });
        const list = h("div.people");
        const online = items.filter((i) => i.online).length;
        const render = () => {
          const q = filter.value.trim().toLowerCase();
          list.replaceChildren(...items.filter((p) => !q || `${p.name} ${p.username} ${p.city}`.toLowerCase().includes(q))
            .map((p) => personRow(p, () => h("button.btn.soft.sm", { type: "button", onclick: () => openChat(p.id) }, icon("message", "sm"), "Написать"))));
        };
        filter.addEventListener("input", render);
        render();
        content.replaceChildren(card(h("div.card-pad", { style: { paddingBottom: "4px" } },
          h("div.card-title", pl(items.length, ["друг", "друга", "друзей"]), online ? h("span.muted", { style: { fontWeight: 500 } }, `· ${online} в сети`) : null), filter), list));
      } else if (current === "requests") {
        const data = await api.get("/api/friends/requests");
        const incoming = data.incoming.map((p) => personRow(p, (person, row) => friendButton(person, { status: "request_received" }, (rel) => {
          row.querySelector(".acts").replaceChildren(h("span.muted", rel.status === "friends" ? "Теперь вы друзья" : "Заявка отклонена"));
          api.get("/api/counters").then(setCounters);
        }, { small: true })));
        const outgoing = data.outgoing.map((p) => personRow(p, (person, row) => friendButton(person, { status: "request_sent" }, () => {
          row.querySelector(".acts").replaceChildren(h("span.muted", "Заявка отменена"));
        }, { small: true })));
        content.replaceChildren(h("div.stack",
          card(h("div.card-pad", { style: { paddingBottom: 0 } }, h("div.card-title", "Входящие заявки", data.incoming.length ? h("span.badge", String(data.incoming.length)) : null)),
            incoming.length ? h("div.people", incoming) : empty("userPlus", "Новых заявок нет")),
          card(h("div.card-pad", { style: { paddingBottom: 0 } }, h("div.card-title", "Отправленные заявки")),
            outgoing.length ? h("div.people", outgoing) : h("p.muted.card-pad", { style: { paddingTop: 0 } }, "Вы пока никому не отправляли заявок."))));
      } else if (current === "suggestions") {
        const { items } = await api.get("/api/friends/suggestions");
        content.replaceChildren(card(h("div.card-pad", { style: { paddingBottom: 0 } }, h("div.card-title", "Возможно, вы знакомы"),
          h("p.muted", { style: { fontSize: "14px", marginTop: "-6px" } }, "Друзья ваших друзей и люди из вашего города. Ищете кого-то конкретного? ", h("a", { href: "/search" }, "Воспользуйтесь поиском"), ".")),
          items.length ? h("div.people", items.map((p) => personRow(p, defaultPersonActions))) : empty("users", "Пока некого предложить", "Приглашайте друзей в Круг!")));
      } else {
        const { blocked } = await api.get("/api/friends/requests");
        content.replaceChildren(card(
          blocked.length ? h("div.people", blocked.map((p) => personRow(p, (person, row) => h("button.btn.outline.sm", {
            type: "button", onclick: async () => {
              try { await api.del(`/api/people/${person.id}/block`); row.remove(); toast("Пользователь разблокирован"); } catch (e) { toastError(e); }
            },
          }, "Разблокировать")))) : empty("block", "Список пуст", "Здесь будут люди, которых вы заблокировали.")));
      }
    } catch (e) { content.replaceChildren(card(empty("x", "Ошибка", e.message))); }
  }

  tabBar.append(...tabs.map((t) => {
    const n = t.badge ? state.counters[t.badge] : 0;
    return h("button", { type: "button", role: "tab", dataset: { tab: t.id }, onclick: () => { current = t.id; draw(); } },
      t.label, n ? h("span.badge", { dataset: { badge: t.badge, count: String(n) } }, String(n)) : null);
  }));
  draw();
  return h("div.stack", h("div.page-head", h("h1", "Друзья"), h("div.spacer"), h("a.btn.soft.sm", { href: "/search" }, icon("search", "sm"), "Найти людей")),
    h("div.card", tabBar), content);
}
