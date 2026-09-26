// Каркас приложения: боковое меню, правая колонка, мобильные панели.
import { api, state, on } from "../api.js";
import { h, icon, avatar, logo, pl } from "../dom.js";
import { navigate } from "../router.js";
import { applyTheme, currentTheme, showMenu, toastError } from "../ui.js";
import { openComposerModal } from "./composer.js";
import { logout } from "../app-actions.js";

let shell = null;
let listenersBound = false;

const NAV = [
  { href: "/", icon: "home", label: "Лента", match: (p) => p === "/" || p === "/explore" },
  { href: () => `/u/${state.me.username}`, icon: "user", label: "Моя страница", match: (p) => p === `/u/${state.me.username}` },
  { href: "/friends", icon: "users", label: "Друзья", badge: "friend_requests", match: (p) => p.startsWith("/friends") },
  { href: "/messages", icon: "message", label: "Сообщения", badge: "messages", match: (p) => p.startsWith("/messages") },
  { href: "/notifications", icon: "bell", label: "Уведомления", badge: "notifications", match: (p) => p === "/notifications" },
  { href: "/communities", icon: "community", label: "Сообщества", match: (p) => p.startsWith("/communities") || p.startsWith("/c/") },
  { href: "/events", icon: "calendar", label: "Мероприятия", badge: "events", match: (p) => p.startsWith("/events") },
  { href: "/guests", icon: "eye", label: "Гости", badge: "guests", match: (p) => p === "/guests" },
  { href: "/search", icon: "search", label: "Поиск", match: (p) => p.startsWith("/search") || p.startsWith("/tag/") },
  { href: "/bookmarks", icon: "bookmark", label: "Закладки", match: (p) => p === "/bookmarks" },
  { href: "/settings", icon: "settings", label: "Настройки", match: (p) => p.startsWith("/settings") },
];

const hrefOf = (item) => (typeof item.href === "function" ? item.href() : item.href);

function badge(key) {
  const n = state.counters[key] || 0;
  return h("span.badge", { dataset: { badge: key, count: String(n) } }, n ? (n > 99 ? "99+" : String(n)) : "");
}

function themeToggle() {
  const btn = h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Тема оформления", title: "Тема оформления" });
  const paint = () => btn.replaceChildren(icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon"));
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    api.patch("/api/me/settings", { theme: next }).catch(() => {});
    paint();
  });
  paint();
  return btn;
}

function sidebar() {
  const nav = h("nav.nav", { "aria-label": "Основное меню" },
    NAV.map((item) => h("a", { href: hrefOf(item), dataset: { nav: item.label }, title: item.label },
      icon(item.icon), h("span", item.label), item.badge ? badge(item.badge) : null)));
  const userBox = h("div.row", { style: { gap: "4px" } },
    h("a.sidebar-user.grow", { href: `/u/${state.me.username}` },
      avatar(state.me, "", { presence: false }),
      h("div.grow", h("div.name", state.me.name), h("div.handle", `@${state.me.username}`))),
  );
  const moreBtn = h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Ещё", "aria-haspopup": "menu" }, icon("more"));
  moreBtn.addEventListener("click", () => showMenu(moreBtn, [
    { label: "Настройки", icon: "settings", onClick: () => navigate("/settings") },
    { label: "Выйти", icon: "logout", danger: true, onClick: logout },
  ]));
  return h("aside.sidebar", { "aria-label": "Навигация" },
    logo(),
    nav,
    h("button.btn.accent.create-btn", { type: "button", onclick: () => openComposerModal(), title: "Создать запись", "aria-label": "Создать запись" }, icon("plus"), h("span.create-label", "Создать запись")),
    h("div.spacer"),
    h("div.row", { style: { justifyContent: "center", flexWrap: "wrap" } }, themeToggle(), moreBtn),
    userBox);
}

function mobileMenu(btn) {
  showMenu(btn, [
    ...NAV.filter((n) => !["Лента", "Моя страница", "Сообщения"].includes(n.label)).map((n) => ({
      label: n.badge && state.counters[n.badge] ? `${n.label} (${state.counters[n.badge]})` : n.label,
      icon: n.icon, onClick: () => navigate(hrefOf(n)),
    })),
    "-",
    { label: "Выйти", icon: "logout", danger: true, onClick: logout },
  ]);
}

function topbar() {
  const menuBtn = h("button.btn.ghost.icon-only.icon-btn", { type: "button", "aria-label": "Меню", "aria-haspopup": "menu" }, icon("menu"), badge("guests"));
  menuBtn.addEventListener("click", () => mobileMenu(menuBtn));
  return h("header.topbar",
    logo(),
    h("div.spacer"),
    themeToggle(),
    h("a.btn.ghost.icon-only.icon-btn", { href: "/notifications", "aria-label": "Уведомления" }, icon("bell"), badge("notifications")),
    h("a.btn.ghost.icon-only.icon-btn", { href: "/friends", "aria-label": "Друзья" }, icon("users"), badge("friend_requests")),
    menuBtn);
}

function tabbar() {
  return h("nav.tabbar", { "aria-label": "Меню" },
    h("a", { href: "/", dataset: { nav: "Лента" } }, icon("home"), "Лента"),
    h("a", { href: "/search", dataset: { nav: "Поиск" } }, icon("search"), "Поиск"),
    h("a", { href: "#", "aria-label": "Создать запись", onclick: (e) => { e.preventDefault(); openComposerModal(); } }, h("span.create", icon("plus"))),
    h("a", { href: "/messages", dataset: { nav: "Сообщения" } }, icon("message"), "Чаты", badge("messages")),
    h("a", { href: `/u/${state.me.username}`, dataset: { nav: "Моя страница" } }, icon("user"), "Профиль"));
}

// ---------------------------------------------------------------- Правая колонка
function widget(title, iconName, content, link) {
  return h("section.card.card-pad", h("h2.card-title", icon(iconName, "sm"), title, link || null), content);
}

async function fillAside(aside) {
  const search = h("form.search-box", { role: "search", onsubmit: (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) navigate(`/search?q=${encodeURIComponent(q)}`); } },
    icon("search"), h("input.input", { name: "q", type: "search", placeholder: "Поиск людей, записей, #тегов", "aria-label": "Поиск" }));
  const online = h("div.online-strip", h("div.skeleton", { style: { height: "36px", width: "100%" } }));
  const trends = h("div", h("div.skeleton", { style: { height: "80px" } }));
  const sugg = h("div.mini-people", h("div.skeleton", { style: { height: "80px" } }));
  const events = h("div.mini-people");
  const eventsWidget = widget("Ближайшие мероприятия", "calendar", events, h("a", { href: "/events" }, "Все"));
  const onlineTitle = h("span", "Друзья онлайн");
  aside.replaceChildren(
    search,
    widget(onlineTitle, "users", online),
    eventsWidget,
    widget("Актуальное", "trend", trends),
    widget("Возможно, вы знакомы", "userPlus", sugg, h("a", { href: "/friends?tab=suggestions" }, "Все")),
    h("footer.aside-footer", h("a", { href: "/privacy" }, "Конфиденциальность"), h("a", { href: "/terms" }, "Правила"), h("span", "© 2026 Круг")));

  const loadOnline = async () => {
    try {
      const { items, total } = await api.get("/api/friends/online");
      onlineTitle.textContent = total ? `Друзья онлайн · ${total}` : "Друзья онлайн";
      online.replaceChildren(...(items.length ? items.map((u) => h("a", { href: `/u/${u.username}`, title: u.name, "aria-label": u.name }, avatar(u))) : [h("p.muted", { style: { fontSize: "14px" } }, "Сейчас никого нет в сети")]));
    } catch { online.replaceChildren(); }
  };
  loadOnline();
  aside._reloadOnline = loadOnline;

  eventsWidget.classList.add("hidden");
  api.get("/api/events", { tab: "mine" }).then(async ({ items }) => {
    if (!items.length) items = (await api.get("/api/events", { tab: "upcoming" })).items;
    if (!items.length) return;
    const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    events.replaceChildren(...items.slice(0, 3).map((e) => {
      const d = new Date(e.starts_at);
      return h("a.mini-person", { href: `/events/${e.id}` },
        h("span.date-badge.sm", h("small", MONTHS[d.getMonth()]), h("b", String(d.getDate()))),
        h("div.who", h("span.name", e.title), h("span.sub", e.place || `${e.going} идут`)));
    }));
    eventsWidget.classList.remove("hidden");
  }).catch(() => {});

  api.get("/api/trends").then(({ items }) => {
    trends.replaceChildren(...(items.length ? items.map((t) => h("a.trend", { href: `/tag/${encodeURIComponent(t.tag)}` }, h("b", `#${t.tag}`), h("small", pl(t.n, ["запись", "записи", "записей"])))) : [h("p.muted", { style: { fontSize: "14px" } }, "Пока нет популярных тем")]));
  }).catch(() => trends.replaceChildren());

  api.get("/api/friends/suggestions").then(({ items }) => {
    sugg.replaceChildren(...(items.length ? items.slice(0, 4).map((p) => {
      const add = h("button.btn.soft.sm.icon-only", { type: "button", "aria-label": `Добавить ${p.name} в друзья`, title: "Добавить в друзья" }, icon("userPlus", "sm"));
      add.addEventListener("click", async () => {
        try { await api.post(`/api/people/${p.id}/friend`); add.replaceChildren(icon("check", "sm")); add.disabled = true; } catch (e) { toastError(e); }
      });
      return h("div.mini-person", h("a", { href: `/u/${p.username}` }, avatar(p, "sm")),
        h("a.who", { href: `/u/${p.username}`, style: { color: "inherit", textDecoration: "none" } }, h("span.name", p.name),
          h("span.sub", p.mutual ? pl(p.mutual, ["общий друг", "общих друга", "общих друзей"]) : (p.city || `@${p.username}`))), add);
    }) : [h("p.muted", { style: { fontSize: "14px" } }, "Пока некого предложить")]));
  }).catch(() => sugg.replaceChildren());
}

// ---------------------------------------------------------------- Публичные функции
export function ensureShell(root) {
  if (shell && root.contains(shell.el)) return shell;
  const main = h("main.main", { id: "main", tabindex: "-1" });
  const aside = h("aside.aside", { "aria-label": "Дополнительно" });
  const el = h("div.app", topbar(), h("div.layout", sidebar(), main, aside), tabbar());
  root.replaceChildren(el);
  shell = { el, main, aside, asideLoaded: 0 };
  if (listenersBound) return shell;
  listenersBound = true;

  on("counters", (c) => {
    document.querySelectorAll("[data-badge]").forEach((b) => {
      const n = c[b.dataset.badge] || 0;
      b.dataset.count = String(n);
      b.textContent = n ? (n > 99 ? "99+" : String(n)) : "";
    });
    const total = (c.notifications || 0) + (c.messages || 0);
    document.title = document.title.replace(/^\(\d+\) /, "");
    if (total) document.title = `(${total}) ${document.title}`;
  });
  on("presence", ({ user_id, online }) => {
    document.querySelectorAll(`.avatar[data-user-id="${user_id}"]`).forEach((a) => {
      if (online) a.dataset.online = "true"; else delete a.dataset.online;
    });
    shell?.aside?._reloadOnline?.();
  });
  return shell;
}

export function destroyShell() { shell = null; }

export function setActive(path, wide = false) {
  document.body.classList.toggle("wide", wide);
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const item = NAV.find((n) => n.label === a.dataset.nav);
    const active = item ? item.match(path) : false;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  // правую колонку обновляем не чаще раза в минуту
  if (shell && !wide && Date.now() - shell.asideLoaded > 60000 && getComputedStyle(shell.aside).display !== "none") {
    shell.asideLoaded = Date.now();
    fillAside(shell.aside);
  }
}

export function refreshAside() { if (shell) { shell.asideLoaded = 0; } }
export function refreshSidebarUser() {
  document.querySelectorAll(".sidebar-user").forEach((box) => {
    box.setAttribute("href", `/u/${state.me.username}`);
    box.replaceChildren(avatar(state.me, "", { presence: false }),
      h("div.grow", h("div.name", state.me.name), h("div.handle", `@${state.me.username}`)));
  });
  document.querySelectorAll('[data-nav="Моя страница"]').forEach((a) => a.setAttribute("href", `/u/${state.me.username}`));
}
