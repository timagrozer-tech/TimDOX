// Каркас приложения: боковое меню, правая колонка, мобильные панели.
import { api, state, on } from "../api.js";
import { h, icon, avatar, vmark, logo, pl } from "../dom.js";
import { navigate } from "../router.js";
import { showMenu, toastError } from "../ui.js";
import { openComposerModal } from "./composer.js";
import { logout } from "../app-actions.js";
import { canInstall, install, installButton } from "../pwa.js";

let shell = null;
let listenersBound = false;

const NAV = [
  { href: () => `/u/${state.me.username}`, icon: "user", label: "Моя страница", match: (p) => p === `/u/${state.me.username}` },
  { href: "/messages", icon: "message", label: "Сообщения", badge: "messages", match: (p) => p.startsWith("/messages") },
  { href: "/", icon: "home", label: "Лента", match: (p) => p === "/" || p === "/explore" },
  { href: "/reels", icon: "film", label: "Клипы", match: (p) => p.startsWith("/reels") },
  { href: "/friends", icon: "users", label: "Друзья", badge: "friend_requests", match: (p) => p.startsWith("/friends") },
  { href: "/notifications", icon: "bell", label: "Уведомления", badge: "notifications", match: (p) => p === "/notifications" },
  { href: "/communities", icon: "community", label: "Сообщества", match: (p) => p.startsWith("/communities") || p.startsWith("/c/") },
  { href: "/events", icon: "calendar", label: "Мероприятия", badge: "events", match: (p) => p.startsWith("/events") },
  { href: "/guests", icon: "eye", label: "Гости", badge: "guests", match: (p) => p === "/guests" },
  { href: "/collection", icon: "gift", label: "Коллекция", match: (p) => p === "/collection" },
  { href: "/stickers", icon: "sticker", label: "Стикеры", match: (p) => p.startsWith("/stickers") },
  { href: "/bookmarks", icon: "bookmark", label: "Закладки", match: (p) => p === "/bookmarks" },
  { href: "/search", icon: "search", label: "Поиск", cls: "nav-search", match: (p) => p.startsWith("/search") || p.startsWith("/tag/") },
  { href: "/settings", icon: "settings", label: "Настройки", match: (p) => p.startsWith("/settings") },
  { href: "/admin", icon: "shield", label: "Модерация", badge: "reports", admin: true, match: (p) => p.startsWith("/admin") },
];
const navItems = () => NAV.filter((n) => !n.admin || state.me?.is_admin);

const hrefOf = (item) => (typeof item.href === "function" ? item.href() : item.href);

function badge(key) {
  const n = state.counters[key] || 0;
  return h("span.badge", { dataset: { badge: key, count: String(n) } }, n ? (n > 99 ? "99+" : String(n)) : "");
}

function sidebar() {
  const nav = h("nav.nav", { "aria-label": "Основное меню" },
    navItems().map((item) => h(`a${item.cls ? "." + item.cls : ""}`, { href: hrefOf(item), dataset: { nav: item.label }, title: item.label },
      icon(item.icon), h("span", item.label), item.badge ? badge(item.badge) : null)));
  return h("aside.sidebar", { "aria-label": "Навигация" },
    logo(),
    nav,
    h("button.btn.accent.create-btn", { type: "button", onclick: () => openComposerModal(), title: "Создать запись", "aria-label": "Создать запись" }, icon("plus"), h("span.create-label", "Создать запись")),
    installButton("btn.ghost.sm.install-side"));
}

function mobileMenu(btn) {
  showMenu(btn, [
    ...navItems().filter((n) => !["Лента", "Моя страница", "Сообщения", "Клипы"].includes(n.label)).map((n) => ({
      label: n.badge && state.counters[n.badge] ? `${n.label} (${state.counters[n.badge]})` : n.label,
      icon: n.icon, onClick: () => navigate(hrefOf(n)),
    })),
    "-",
    canInstall() ? { label: "Установить приложение", icon: "install", onClick: install } : null,
    { label: "Выйти", icon: "logout", danger: true, onClick: logout },
  ]);
}

function topbar() {
  const menuBtn = h("button.btn.ghost.icon-only.icon-btn", { type: "button", "aria-label": "Меню", "aria-haspopup": "menu" }, icon("menu"), badge("friend_requests"));
  menuBtn.addEventListener("click", () => mobileMenu(menuBtn));
  return h("header.topbar",
    logo(),
    h("div.spacer"),
    h("a.btn.ghost.icon-only.icon-btn", { href: "/search", "aria-label": "Поиск" }, icon("search")),
    h("a.btn.ghost.icon-only.icon-btn", { href: "/notifications", "aria-label": "Уведомления" }, icon("bell"), badge("notifications")),
    menuBtn);
}

/** «+» внизу: что создать — запись, историю или клип */
function createMenu(btn) {
  btn.classList.add("open");
  showMenu(btn, [
    { label: "Запись", hint: "Текст, фото, видео или опрос", icon: "edit", onClick: () => openComposerModal() },
    { label: "История", hint: "Фото или текст на 24 часа", icon: "story", onClick: async () => {
      const { createStory } = await import("./stories.js");
      createStory(() => document.querySelector(".stories-card")?._reload?.());
    } },
    { label: "Клип", hint: "Короткое вертикальное видео", icon: "film", onClick: async () => {
      const { openUpload } = await import("../pages/reels.js");
      openUpload(() => navigate("/reels"));
    } },
  ], { onClose: () => btn.classList.remove("open"), title: "Создать" });
}

function tabbar() {
  return h("nav.tabbar", { "aria-label": "Меню" },
    h("a", { href: "/", dataset: { nav: "Лента" } }, icon("home"), "Лента"),
    h("a", { href: "/reels", dataset: { nav: "Клипы" } }, icon("film"), "Клипы"),
    h("a.tab-create", { href: "#", "aria-label": "Создать", "aria-haspopup": "menu", onclick: (e) => { e.preventDefault(); createMenu(e.currentTarget); } }, h("span.create", icon("plus"))),
    h("a", { href: "/messages", dataset: { nav: "Сообщения" } }, icon("message"), "Чаты", badge("messages")),
    h("a", { href: `/u/${state.me.username}`, dataset: { nav: "Моя страница" } }, icon("user"), "Профиль"));
}

// ---------------------------------------------------------------- Правая колонка
function widget(title, iconName, content, link) {
  return h("section.card.card-pad", h("h2.card-title", icon(iconName, "sm"), title, link || null), content);
}

async function fillAside(aside) {
  const online = h("div.online-strip", h("div.skeleton", { style: { height: "36px", width: "100%" } }));
  const trends = h("div", h("div.skeleton", { style: { height: "80px" } }));
  const sugg = h("div.mini-people", h("div.skeleton", { style: { height: "80px" } }));
  const events = h("div.mini-people");
  const eventsWidget = widget("Ближайшие мероприятия", "calendar", events, h("a", { href: "/events" }, "Все"));
  const onlineTitle = h("span", "Друзья онлайн");
  const onlineWidget = widget(onlineTitle, "users", online);
  onlineWidget.classList.add("hidden");
  const search = h("form.side-search.aside-search", { role: "search", onsubmit: (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  } },
  h("span.side-search-icon", icon("search")),
  h("input", { name: "q", type: "search", placeholder: "Поиск людей, записей, #тегов", "aria-label": "Поиск людей, записей и #тегов", autocomplete: "off" }));
  aside.replaceChildren(
    search,
    onlineWidget,
    eventsWidget,
    widget("Возможно, вы знакомы", "userPlus", sugg, h("a", { href: "/friends?tab=suggestions" }, "Все")),
    widget("Актуальное", "trend", trends),
    h("footer.aside-footer", h("a", { href: "/privacy" }, "Конфиденциальность"), h("a", { href: "/terms" }, "Правила"), h("span", "© 2026 Круг")));

  const loadOnline = async () => {
    try {
      const { items, total } = await api.get("/api/friends/online");
      onlineTitle.textContent = total ? `Друзья онлайн · ${total}` : "Друзья онлайн";
      onlineWidget.classList.toggle("hidden", !total);
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
    trends.replaceChildren(...(items.length ? items.slice(0, 5).map((t) => h("a.trend", { href: `/tag/${encodeURIComponent(t.tag)}` }, h("b", `#${t.tag}`), h("small", pl(t.n, ["запись", "записи", "записей"])))) : [h("p.muted", { style: { fontSize: "14px" } }, "Пока нет популярных тем")]));
  }).catch(() => trends.replaceChildren());

  api.get("/api/friends/suggestions").then(({ items }) => {
    sugg.replaceChildren(...(items.length ? items.slice(0, 4).map((p) => {
      const add = h("button.btn.soft.sm.icon-only", { type: "button", "aria-label": `Добавить ${p.name} в друзья`, title: "Добавить в друзья" }, icon("userPlus", "sm"));
      add.addEventListener("click", async () => {
        try { await api.post(`/api/people/${p.id}/friend`); add.replaceChildren(icon("check", "sm")); add.disabled = true; } catch (e) { toastError(e); }
      });
      return h("div.mini-person", h("a", { href: `/u/${p.username}` }, avatar(p, "sm")),
        h("a.who", { href: `/u/${p.username}`, style: { color: "inherit", textDecoration: "none" } }, h("span.name", p.name, vmark(p)),
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
  let onlineTimer = null;
  on("presence", ({ user_id, online }) => {
    document.querySelectorAll(`.avatar[data-user-id="${user_id}"]`).forEach((a) => {
      if (online) a.dataset.online = "true"; else delete a.dataset.online;
    });
    // список «Друзья онлайн» обновляем не чаще раза в 5 секунд
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(() => shell?.aside?._reloadOnline?.(), 5000);
  });
  return shell;
}

export function destroyShell() { shell = null; }

export function setActive(path, wide = false) {
  document.body.classList.toggle("wide", wide);
  // на странице поиска своё поле — второе в правой колонке не нужно
  document.body.classList.toggle("on-search", path.startsWith("/search"));
  // открытый чат на телефоне — во весь экран, без общих панелей
  document.body.classList.toggle("in-chat", /^\/messages\/\d+/.test(path));
  // правая колонка нужна только в ленте, на профилях и записях
  document.body.classList.toggle("no-aside", !/^\/($|explore|u\/|tag\/|post\/|c\/)/.test(path));
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
