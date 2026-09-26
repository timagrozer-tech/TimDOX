// Мероприятия: список, создание, страница мероприятия, ответы и приглашения.
import { api, state, setCounters } from "../api.js";
import { h, icon, avatar, pl, hm } from "../dom.js";
import { setTitle, toast, toastError, modal, busy, confirmDialog } from "../ui.js";
import { navigate } from "../router.js";
import { pickFriends } from "../components/people.js";

const MONTHS = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const STATUS = { going: "Пойду", maybe: "Возможно", declined: "Не пойду" };

export function dateBadge(iso) {
  const d = new Date(iso);
  return h("div.date-badge", h("small", MONTHS[d.getMonth()]), h("b", String(d.getDate())));
}

export function eventWhen(e) {
  const d = new Date(e.starts_at);
  let s = `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_FULL[d.getMonth()]} в ${hm(d)}`;
  if (e.ends_at) {
    const x = new Date(e.ends_at);
    s += x.toDateString() === d.toDateString() ? ` – ${hm(x)}` : ` – ${x.getDate()} ${MONTHS_FULL[x.getMonth()]} ${hm(x)}`;
  }
  return s;
}

export function eventCard(e) {
  const status = e.my_status === "invited" ? h("span.status-pill.invite", "Вас пригласили") : e.my_status && STATUS[e.my_status] ? h("span.status-pill", STATUS[e.my_status]) : null;
  return h("a.event-card", { href: `/events/${e.id}` },
    e.cover ? h("div.event-cover", h("img", { src: e.cover.replace(/\.webp$/, "_t.webp"), alt: "", loading: "lazy" })) : null,
    h("div.event-body", dateBadge(e.starts_at),
      h("div.grow",
        h("b.event-title", e.title),
        h("div.sub", eventWhen(e)),
        e.place ? h("div.sub", icon("pin", "sm"), " ", e.place) : null,
        h("div.sub", `${pl(e.going, ["участник", "участника", "участников"])}${e.maybe ? ` · ${e.maybe} возможно` : ""}`),
        status)));
}

export async function eventsPage({ query }) {
  setTitle("Мероприятия");
  let tab = ["upcoming", "mine", "invites", "past"].includes(query.tab) ? query.tab : (state.counters.events ? "invites" : "upcoming");
  const tabBar = h("div.tabs", { role: "tablist" });
  const list = h("div.stack");
  async function draw() {
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    history.replaceState({}, "", tab === "upcoming" ? "/events" : `/events?tab=${tab}`);
    list.replaceChildren(h("div.spinner"));
    try {
      const { items } = await api.get("/api/events", { tab });
      list.replaceChildren(...(items.length ? [h("div.event-grid", items.map(eventCard))] : [h("div.card.empty", icon("calendar"),
        h("h3", { upcoming: "Ближайших мероприятий нет", mine: "Вы пока никуда не собираетесь", invites: "Приглашений нет", past: "Прошедших мероприятий нет" }[tab]),
        tab !== "past" ? h("button.btn.accent", { type: "button", onclick: () => createEvent() }, icon("plus", "sm"), "Создать мероприятие") : null)]));
    } catch (e) { list.replaceChildren(h("p.muted", e.message)); }
  }
  tabBar.append(...[["upcoming", "Ближайшие"], ["mine", "Я иду"], ["invites", "Приглашения", "events"], ["past", "Прошедшие"]].map(([id, label, badge]) =>
    h("button", { type: "button", role: "tab", dataset: { tab: id }, onclick: () => { tab = id; draw(); } }, label,
      badge && state.counters[badge] ? h("span.badge", { dataset: { badge, count: String(state.counters[badge]) } }, String(state.counters[badge])) : null)));
  draw();
  return h("div.stack",
    h("div.page-head", h("h1", "Мероприятия"), h("div.spacer"), h("button.btn.accent.sm", { type: "button", onclick: () => createEvent() }, icon("plus", "sm"), "Создать")),
    h("div.card", tabBar), list);
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createEvent({ community = null } = {}) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(19, 0, 0, 0);
  const title = h("input.input", { maxlength: 120, placeholder: "Например, «Встреча выпускников»" });
  const starts = h("input.input", { type: "datetime-local", value: toLocalInput(tomorrow) });
  const ends = h("input.input", { type: "datetime-local" });
  const place = h("input.input", { maxlength: 200, placeholder: "Адрес или название места" });
  const desc = h("textarea.textarea", { rows: 3, maxlength: 3000, placeholder: "Что будет, что взять с собой…" });
  const vis = h("select.select", h("option", { value: "public" }, "Все"), h("option", { value: "friends" }, "Друзья"), h("option", { value: "invited" }, "Только приглашённые"));
  const cover = h("input", { type: "file", accept: "image/*" });
  const err = h("div.form-error.hidden");
  const create = h("button.btn.primary", { type: "button" }, "Создать");
  const m = modal({
    title: community ? `Мероприятие сообщества «${community.name}»` : "Новое мероприятие",
    body: h("div.stack", err,
      h("div.field", h("label", "Название"), title),
      h("div.grid-2", h("div.field", h("label", "Начало"), starts), h("div.field", h("label", "Окончание (необязательно)"), ends)),
      h("div.field", h("label", "Место"), place),
      h("div.field", h("label", "Описание"), desc),
      community ? null : h("div.field", h("label", "Кто видит"), vis),
      h("div.field", h("label", "Обложка (необязательно)"), cover)),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), create],
  });
  create.addEventListener("click", () => busy(create, async () => {
    const fd = new FormData();
    fd.append("title", title.value);
    if (starts.value) fd.append("starts_at", new Date(starts.value).toISOString());
    if (ends.value) fd.append("ends_at", new Date(ends.value).toISOString());
    fd.append("place", place.value);
    fd.append("description", desc.value);
    fd.append("visibility", vis.value);
    if (community) fd.append("community_id", community.id);
    if (cover.files[0]) fd.append("cover", cover.files[0]);
    try {
      const e = await api.form("/api/events", fd);
      m.close();
      toast("Мероприятие создано. Пригласите друзей!", { icon: "calendar" });
      navigate(`/events/${e.id}`);
    } catch (e) {
      err.textContent = Object.values(e.fields || {}).join(". ") || e.message;
      err.classList.remove("hidden");
    }
  }));
  setTimeout(() => title.focus(), 50);
}

export async function eventPage({ params }) {
  let e = await api.get(`/api/events/${encodeURIComponent(params.id)}`);
  setTitle(e.title);
  const root = h("div.stack");

  function render() {
    const rsvp = h("div.segmented.rsvp", { role: "group", "aria-label": "Ваш ответ" },
      Object.entries(STATUS).map(([k, label]) => h("button", { type: "button", "aria-pressed": String(e.my_status === k), onclick: () => answer(k) }, label)));
    const going = e.attendees.filter((a) => a.status === "going");
    const maybe = e.attendees.filter((a) => a.status === "maybe");
    const past = new Date(e.ends_at || e.starts_at) < new Date();
    root.replaceChildren(
      h("div.page-head", h("button.btn.ghost.icon-only.back", { type: "button", "aria-label": "Назад", onclick: () => (history.length > 1 ? history.back() : navigate("/events")) }, icon("back")), h("h1", "Мероприятие")),
      h("section.card.profile-card",
        h("div.cover.event-hero", e.cover ? h("img", { src: e.cover, alt: "" }) : null),
        h("div.profile-main.event-main",
          h("div.row", { style: { alignItems: "flex-start", gap: "14px", marginTop: "16px" } }, dateBadge(e.starts_at),
            h("div.grow", h("h1.event-h1", e.title),
              h("div.text-2", eventWhen(e)),
              e.place ? h("div.text-2", icon("pin", "sm"), " ", e.place) : null)),
          e.description ? h("p.profile-bio", e.description) : null,
          h("div.profile-info",
            e.community ? h("span", icon("users"), "Сообщество ", h("a", { href: `/c/${e.community.slug}` }, e.community.name))
              : h("span", icon("user"), "Организатор ", h("a", { href: `/u/${e.creator.username}` }, e.creator.name)),
            h("span", icon(e.visibility === "public" ? "globe" : e.visibility === "friends" ? "users" : "lock"),
              { public: "Открытое мероприятие", friends: "Для друзей организатора", invited: "Только по приглашениям" }[e.visibility])),
          past ? h("p.muted", { style: { marginTop: "12px" } }, "Мероприятие уже прошло") : h("div.row", { style: { marginTop: "14px", flexWrap: "wrap" } }, rsvp,
            h("div.spacer"),
            e.visibility !== "invited" || e.can_edit ? h("button.btn.soft", { type: "button", onclick: invite }, icon("userPlus", "sm"), "Пригласить друзей") : null,
            e.can_edit ? h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Удалить мероприятие", title: "Удалить", onclick: remove }, icon("trash")) : null))),
      h("section.card.card-pad",
        h("h2.card-title", icon("users", "sm"), `Пойдут · ${going.length}`),
        going.length ? h("div.online-strip", going.map((a) => h("a", { href: `/u/${a.username}`, title: a.name }, avatar(a)))) : h("p.muted", "Пока никто не отметился"),
        maybe.length ? [h("h2.card-title", { style: { marginTop: "16px" } }, `Возможно · ${maybe.length}`),
          h("div.online-strip", maybe.map((a) => h("a", { href: `/u/${a.username}`, title: a.name }, avatar(a))))] : null));
  }
  async function answer(status) {
    try {
      const fresh = await api.post(`/api/events/${e.id}/rsvp`, { status });
      e = { ...(await api.get(`/api/events/${e.id}`)), ...{ my_status: fresh.my_status } };
      render();
      toast(status === "going" ? "Отлично, вас ждут!" : "Ответ сохранён", { icon: "check" });
      api.get("/api/counters").then(setCounters).catch(() => {});
    } catch (err) { toastError(err); }
  }
  async function invite() {
    const ids = await pickFriends({ title: "Пригласить друзей", confirm: "Пригласить", exclude: e.attendees.map((a) => a.id) });
    if (!ids?.length) return;
    try {
      const { invited } = await api.post(`/api/events/${e.id}/invite`, { user_ids: ids });
      toast(invited ? `Отправлено приглашений: ${invited}` : "Эти друзья уже приглашены", { icon: "check" });
    } catch (err) { toastError(err); }
  }
  async function remove() {
    if (!await confirmDialog({ title: "Удалить мероприятие?", text: "Участники больше не увидят его.", confirm: "Удалить", danger: true })) return;
    try { await api.del(`/api/events/${e.id}`); toast("Мероприятие удалено"); navigate("/events"); } catch (err) { toastError(err); }
  }
  render();
  return root;
}
