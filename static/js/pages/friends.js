// Друзья: список, заявки, рекомендации, заблокированные.
import { api, state, setCounters } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";
import { personRow, defaultPersonActions, friendButton, openChat, featuredStrip } from "../components/people.js";

export async function friendsPage({ query }) {
  setTitle("Друзья");
  const tabs = [
    { id: "all", label: "Мои друзья" },
    { id: "requests", label: "Заявки", badge: "friend_requests" },
    { id: "suggestions", label: "Рекомендации" },
    { id: "classmates", label: "Одноклассники" },
    { id: "blocked", label: "Чёрный список" },
  ];
  const tabBar = h("div.tabs", { role: "tablist" });
  const content = h("div");
  let current = tabs.some((t) => t.id === query.tab) ? query.tab : "all";

  const card = (...c) => h("div.card", ...c);
  const empty = (ic, title, text, extra) => h("div.empty", icon(ic), h("h2", title), text ? h("p", text) : null, extra || null);

  async function draw() {
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === current)));
    history.replaceState({}, "", current === "all" ? "/friends" : `/friends?tab=${current}`);
    content.replaceChildren(card(h("div.spinner")));
    try {
      if (current === "all") {
        const { items } = await api.get(`/api/users/${state.me.username}/friends`);
        if (!items.length) return content.replaceChildren(card(empty("users", "У вас пока нет друзей", "Найдите знакомых по имени, городу, месту учёбы или работы.",
          h("a.btn.primary", { href: "/friends?tab=suggestions", onclick: (e) => { e.preventDefault(); current = "suggestions"; draw(); } }, "Смотреть рекомендации"))));
        const filter = h("input.input", { type: "search", placeholder: "Поиск среди друзей", "aria-label": "Поиск среди друзей" });
        const list = h("div.people");
        const online = items.filter((i) => i.online).length;
        const render = () => {
          const q = filter.value.trim().toLowerCase();
          list.replaceChildren(...items.filter((p) => !q || `${p.name} ${p.username} ${p.city}`.toLowerCase().includes(q))
            .map((p) => personRow(p, () => h("button.btn.soft.icon-only.round", { type: "button", "aria-label": `Написать ${p.name}`, title: "Написать", onclick: () => openChat(p.id) }, icon("message", "sm")))));
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
      } else if (current === "classmates") {
        const settings = await api.get("/api/me/settings");
        const school = h("input.input", { placeholder: "Школа, лицей, гимназия", value: query.school || settings.school || "" });
        const uni = h("input.input", { placeholder: "Вуз или колледж", value: query.university || settings.university || "" });
        const year = h("input.input", { type: "number", min: 1940, max: 2040, placeholder: "Год выпуска", value: query.year || settings.school_year || "" });
        const city = h("input.input", { placeholder: "Город (необязательно)", value: query.city || "" });
        const results = h("div");
        const run = async () => {
          results.replaceChildren(h("div.spinner"));
          try {
            const res = await api.get("/api/classmates", { school: school.value.trim(), university: uni.value.trim(), year: year.value, city: city.value.trim() });
            if (res.need_profile) return results.replaceChildren(empty("book", "Укажите школу или вуз", "Заполните поля выше или добавьте место учёбы в настройках профиля."));
            results.replaceChildren(res.items.length ? h("div.people", res.items.map((p) => personRow(p, defaultPersonActions)))
              : empty("search", "Никого не нашли", "Попробуйте написать название короче или убрать год."));
          } catch (e) { results.replaceChildren(h("p.muted.card-pad", e.message)); }
        };
        const form = h("form.stack.card-pad", {
          onsubmit: (e) => { e.preventDefault(); run(); },
        }, h("div.card-title", icon("book", "sm"), "Поиск одноклассников и однокурсников"),
        h("div.grid-2", school, uni), h("div.grid-2", year, city),
        h("div.row", h("span.muted", { style: { fontSize: "13px" } }, "Совпадения ищутся по части названия"), h("div.spacer"), h("button.btn.primary", { type: "submit" }, icon("search", "sm"), "Найти")));
        content.replaceChildren(card(form, results));
        if (school.value || uni.value) run();
      } else if (current === "suggestions") {
        const { items, featured } = await api.get("/api/friends/suggestions");
        content.replaceChildren(h("div.stack", contactsCard(), featuredStrip({ items: featured || [] }), card(h("div.card-pad", { style: { paddingBottom: 0 } }, h("div.card-title", "Возможно, вы знакомы"),
          h("p.muted", { style: { fontSize: "14px", marginTop: "-6px" } }, "Друзья ваших друзей и люди из вашего города. Ищете кого-то конкретного? ", h("a", { href: "/search" }, "Воспользуйтесь поиском"), ".")),
          items.length ? h("div.people", items.map((p) => personRow(p, defaultPersonActions))) : empty("users", "Пока некого предложить", "Приглашайте друзей в Yarko!"))));
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

  // «Найти друзей по контактам»: на телефоне — из телефонной книги (с разрешения), на компьютере — вставить номера
  function contactsCard() {
    const results = h("div.people");
    const status = h("p.muted.fc-status", { style: { fontSize: "13px" } });
    const canPick = "contacts" in navigator && "select" in (navigator.contacts || {});
    const show = (items, checked) => {
      status.textContent = items.length ? `Нашлись в Yarko: ${items.length} из ${checked} номеров` : `Из ${checked} номеров пока никого нет в Yarko — пригласите их!`;
      results.replaceChildren(...items.map((p) => { p._relation = p.relation; return personRow(p, defaultPersonActions); }));
      if (!items.length) results.append(h("a.btn.soft.sm", { href: "/invite" }, icon("userAdd", "sm"), "Пригласить друзей"));
    };
    const search = async (list, btn) => {
      try {
        const r = await api.post("/api/friends/by-phones", { phones: list });
        show(r.items, r.checked);
      } catch (e) { toastError(e); }
    };
    const pickBtn = h("button.btn.primary", { type: "button", onclick: async (e) => {
      const btn = e.currentTarget;
      try {
        const picked = await navigator.contacts.select(["tel"], { multiple: true });
        const list = picked.flatMap((c) => c.tel || []).slice(0, 500);
        if (!list.length) return;
        btn.disabled = true; await search(list, btn); btn.disabled = false;
      } catch { /* человек закрыл окно выбора */ }
    } }, icon("users", "sm"), "Выбрать из контактов");
    const ta = h("textarea.textarea", { rows: 2, placeholder: "+7 912 345-67-89, 8 900 …", "aria-label": "Номера телефонов через запятую" });
    const pasteBtn = h("button.btn.soft", { type: "button", onclick: () => {
      const list = ta.value.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
      if (!list.length) { toast("Впишите хотя бы один номер", { icon: "alert" }); return; }
      search(list);
    } }, icon("search", "sm"), "Найти");
    return card(h("div.card-pad.fc-card",
      h("div.card-title", icon("smartphone", "sm"), "Найти друзей по контактам"),
      h("p.muted", { style: { fontSize: "13.5px", marginTop: "-6px" } },
        "Покажем, кто из ваших знакомых уже в Yarko. Номера только сравниваются и нигде не сохраняются."),
      canPick ? h("div.row", pickBtn) : h("div.stack", { style: { gap: "6px" } }, ta, h("div.row", pasteBtn)),
      status, results));
  }

  tabBar.append(...tabs.map((t) => {
    const n = t.badge ? state.counters[t.badge] : 0;
    return h("button", { type: "button", role: "tab", dataset: { tab: t.id }, onclick: () => { current = t.id; draw(); } },
      t.label, n ? h("span.badge", { dataset: { badge: t.badge, count: String(n) } }, String(n)) : null);
  }));
  draw();
  return h("div.stack", h("div.page-head", h("h1", "Друзья")),
    h("div.card", tabBar), content);
}
