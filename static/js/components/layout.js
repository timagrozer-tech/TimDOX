// Каркас приложения: боковое меню, правая колонка, мобильные панели.
import { api, state, on } from "../api.js";
import { h, icon, avatar, vmark, logo, pl } from "../dom.js";
import { navigate } from "../router.js";
import { showMenu, toastError } from "../ui.js";
import { openComposerModal } from "./composer.js";
import { logout } from "../app-actions.js";
import { canInstall, install, installButton } from "../pwa.js";
import { openAccounts, longPress } from "./accounts.js";
import { attachPill, syncPills, refract } from "../liquid.js";

let shell = null;
let listenersBound = false;

// Основное меню — 8 главных разделов; редкие спрятаны в «Ещё» (меньше пунктов — быстрее находишь нужное)
const NAV = [
  { href: "/", icon: "home", label: "Лента", match: (p) => p === "/" || p === "/explore" },
  { href: "/reels", icon: "film", label: "Клипы", match: (p) => p.startsWith("/reels") },
  { href: "/messages", icon: "message", label: "Сообщения", badge: "messages", match: (p) => p.startsWith("/messages") },
  { href: "/notifications", icon: "bell", label: "Уведомления", badge: "notifications", match: (p) => p === "/notifications" },
  { href: "/friends", icon: "users", label: "Друзья", badge: "friend_requests", match: (p) => p.startsWith("/friends") },
  { href: "/music", icon: "music", label: "Музыка", cls: "nav-music", match: (p) => p.startsWith("/music") },
  { href: "/communities", icon: "community", label: "Сообщества", match: (p) => p.startsWith("/communities") || p.startsWith("/c/") },
  { href: "/invite", icon: "userAdd", label: "Пригласить", cls: "nav-invite", match: (p) => p === "/invite" },
  { href: () => `/u/${state.me.username}`, icon: "user", label: "Моя страница", match: (p) => p === `/u/${state.me.username}` },
  { href: "/wallet", icon: "coin", label: "Кошелёк", cls: "nav-wallet", more: true, match: (p) => p === "/wallet" },
  { href: "/shop", icon: "gift", label: "Магазин", more: true, match: (p) => p === "/shop" },
  { href: "/market", icon: "repeat", label: "Рынок", more: true, match: (p) => p === "/market" },
  { href: "/bookmarks", icon: "bookmark", label: "Закладки", more: true, match: (p) => p === "/bookmarks" },
  { href: "/search", icon: "search", label: "Поиск", cls: "nav-search", more: true, match: (p) => p.startsWith("/search") || p.startsWith("/tag/") },
  { href: "/settings", icon: "settings", label: "Настройки", more: true, match: (p) => p.startsWith("/settings") },
  { href: "/admin", icon: "shield", label: "Модерация", badge: "reports", admin: true, more: true, match: (p) => p.startsWith("/admin") },
];
// стиль «Ретро 2010»: меню по-старому — «Моя Страница», «Мои Друзья»… и в привычном порядке
const RETRO = { "Моя страница": "Моя Страница", "Друзья": "Мои Друзья", "Клипы": "Мои Видеозаписи", "Музыка": "Мои Аудиозаписи",
  "Сообщения": "Мои Сообщения", "Сообщества": "Мои Группы", "Уведомления": "Мои Ответы", "Лента": "Мои Новости", "Закладки": "Мои Закладки", "Настройки": "Мои Настройки" };
const RETRO_ORDER = ["Моя страница", "Друзья", "Клипы", "Музыка", "Сообщения", "Сообщества", "Уведомления", "Лента"];
const isRetro = () => document.documentElement.dataset.skin === "retro";
const navItems = () => {
  const list = NAV.filter((n) => !n.admin || state.me?.is_admin);
  if (!isRetro()) return list;
  const rank = (n) => (RETRO_ORDER.includes(n.label) ? RETRO_ORDER.indexOf(n.label) : 50);
  return [...list].sort((a, b) => rank(a) - rank(b));
};

const hrefOf = (item) => (typeof item.href === "function" ? item.href() : item.href);

function badge(key) {
  const n = state.counters[key] || 0;
  return h("span.badge", { dataset: { badge: key, count: String(n) } }, n ? (n > 99 ? "99+" : String(n)) : "");
}

function navLink(item) {
  const label = isRetro() ? RETRO[item.label] || item.label : item.label;
  return h(`a${item.cls ? "." + item.cls : ""}`, { href: hrefOf(item), dataset: { nav: item.label }, title: label },
    icon(item.icon), h("span", label), item.badge ? badge(item.badge) : null);
}

function sidebar() {
  const items = navItems();
  const extra = items.filter((n) => n.more);
  let open = false;
  try { open = localStorage.getItem("krug-nav-more") === "1"; } catch { /* приватный режим */ }
  const more = h("details.nav-more", { open },
    h("summary", { dataset: { navMore: "1" } }, icon("more"), h("span", "Ещё"), h("span.badge.nav-more-badge", { dataset: { count: "0" } }), h("span.nav-more-chev", icon("down", "sm"))),
    h("div.nav-more-list", extra.map(navLink)));
  more.addEventListener("toggle", () => { try { localStorage.setItem("krug-nav-more", more.open ? "1" : "0"); } catch { /* ничего */ } });
  const nav = h("nav.nav", { "aria-label": "Основное меню" }, items.filter((n) => !n.more).map(navLink), more);
  return h("aside.sidebar", { "aria-label": "Навигация" },
    logo(),
    nav,
    h("a.sidebar-wallet", { href: "/wallet", title: "Кошелёк и задания" }, h("span.sw-ic", "🪙"), h("b.sw-kc", "—"), h("small.sw-lvl", "")),
    h("button.btn.accent.create-btn", { type: "button", onclick: () => openComposerModal(), title: "Создать запись", "aria-label": "Создать запись" }, icon("plus"), h("span.create-label", "Создать запись")),
    h("button.sidebar-acc", { type: "button", onclick: openAccounts, title: "Аккаунты: переключить или добавить", "aria-label": "Аккаунты" },
      avatar(state.me, "sm", { presence: false }), h("span.grow", h("b", state.me.name), h("small", `@${state.me.username}`)), icon("chevronsUpDown", "sm")),
    installButton("btn.ghost.sm.install-side"));
}

function mobileMenu(btn) {
  showMenu(btn, [
    { label: "Аккаунты", hint: `@${state.me.username} · переключить или добавить`, icon: "users", onClick: openAccounts },
    "-",
    ...navItems().filter((n) => !["Лента", "Моя страница", "Сообщения", "Клипы", "Уведомления", "Поиск"].includes(n.label)).map((n) => ({
      label: n.badge && state.counters[n.badge] ? `${n.label} (${state.counters[n.badge]})` : n.label,
      icon: n.icon, onClick: () => navigate(hrefOf(n)),
    })),
    "-",
    canInstall() ? { label: "Установить приложение", icon: "install", onClick: install } : null,
    { label: "Выйти", icon: "logout", danger: true, onClick: logout },
  ]);
}

function topbar() {
  const menuBtn = h("button.btn.ghost.icon-only.icon-btn", { type: "button", "aria-label": "Меню", "aria-haspopup": "menu" }, icon("menu"));
  menuBtn.addEventListener("click", () => mobileMenu(menuBtn));
  return h("header.topbar",
    logo(),
    h("div.spacer"),
    h("div.lg-group",
      h("a.btn.ghost.icon-only.icon-btn", { href: "/search", "aria-label": "Поиск" }, icon("search")),
      h("a.btn.ghost.icon-only.icon-btn", { href: "/notifications", "aria-label": "Уведомления" }, icon("bell"), badge("notifications")),
      menuBtn));
}

/** «+» внизу: что создать — запись, историю или клип */
function createMenu(btn) {
  btn.classList.add("open");
  showMenu(btn, [
    { label: "Запись", hint: "Текст, фото, видео или опрос", icon: "edit", onClick: () => openComposerModal() },
    { label: "Клип", hint: "Вертикальное видео до 90 секунд", icon: "film", onClick: async () => {
      const { openUpload } = await import("../pages/reels.js");
      openUpload((r) => navigate(`/reels/${r.id}`));
    } },
    { label: "История", hint: "Фото или текст на 24 часа", icon: "story", onClick: async () => {
      const { createStory } = await import("./stories.js");
      createStory(() => document.querySelector(".stories-card")?._reload?.());
    } },
  ], { onClose: () => btn.classList.remove("open"), title: "Создать" });
}

function tabbar() {
  const profileTab = h("a", { href: `/u/${state.me.username}`, dataset: { nav: "Моя страница" }, title: "Профиль · удерживайте, чтобы сменить аккаунт" }, icon("user"), "Профиль");
  longPress(profileTab, openAccounts);
  return h("nav.tabbar", { "aria-label": "Меню" },
    h("a", { href: "/", dataset: { nav: "Лента" } }, icon("home"), "Лента"),
    h("a", { href: "/reels", dataset: { nav: "Клипы" } }, icon("film"), "Клипы"),
    h("a.tab-create", { href: "#", "aria-label": "Создать", "aria-haspopup": "menu", onclick: (e) => { e.preventDefault(); createMenu(e.currentTarget); } }, h("span.create", icon("plus"))),
    h("a", { href: "/messages", dataset: { nav: "Сообщения" } }, icon("message"), "Чаты", badge("messages")),
    profileTab);
}

// ---------------------------------------------------------------- Правая колонка
function widget(title, iconName, content, link) {
  return h("section.card.card-pad", h("h2.card-title", icon(iconName, "sm"), title, link || null), content);
}

async function fillAside(aside) {
  const online = h("div.online-strip", h("div.skeleton", { style: { height: "36px", width: "100%" } }));
  const trends = h("div", h("div.skeleton", { style: { height: "80px" } }));
  const sugg = h("div.mini-people", h("div.skeleton", { style: { height: "80px" } }));
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
    widget("Возможно, вы знакомы", "userPlus", sugg, h("a", { href: "/friends?tab=suggestions" }, "Все")),
    widget("Актуальное", "trend", trends),
    h("footer.aside-footer", h("a", { href: "/privacy" }, "Конфиденциальность"), h("a", { href: "/terms" }, "Правила"), h("span", "© 2026 Yarko")));

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
  // Liquid Glass: капсула активного пункта перетекает между вкладками; края дока и панели преломляют фон
  const dock = el.querySelector(".tabbar"), side = el.querySelector(".sidebar");
  attachPill(dock, "a.active:not(.tab-create)", { x: 3, y: 6 });
  attachPill(el.querySelector(".sidebar .nav"), "a.active");
  refract(dock, { bezel: 16, scale: 30 });
  refract(side, { bezel: 20, scale: 36 });
  el.querySelectorAll(".topbar .lg-group, .topbar .logo").forEach((g) => refract(g, { bezel: 12, scale: 22 }));
  if (listenersBound) return shell;
  listenersBound = true;

  on("counters", (c) => {
    document.querySelectorAll("[data-badge]").forEach((b) => {
      const n = c[b.dataset.badge] || 0;
      b.dataset.count = String(n);
      b.textContent = n ? (n > 99 ? "99+" : String(n)) : "";
    });
    // сумма счётчиков разделов, спрятанных в «Ещё», — чтобы не пропустить заявку или гостя
    const hidden = NAV.filter((n) => n.more && n.badge && (!n.admin || state.me?.is_admin)).reduce((s, n) => s + (c[n.badge] || 0), 0);
    document.querySelectorAll(".nav-more-badge").forEach((b) => { b.dataset.count = String(hidden); b.textContent = hidden ? (hidden > 99 ? "99+" : String(hidden)) : ""; });
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
    if (active) { const d = a.closest("details.nav-more"); if (d) d.open = true; }
  });
  requestAnimationFrame(() => syncPills(true));
  refreshWallet(path === "/wallet");
  // правую колонку обновляем не чаще раза в минуту
  if (shell && !wide && Date.now() - shell.asideLoaded > 60000 && getComputedStyle(shell.aside).display !== "none") {
    shell.asideLoaded = Date.now();
    fillAside(shell.aside);
  }
}

export function refreshAside() { if (shell) { shell.asideLoaded = 0; } }
/** Баланс в боковом меню: тихо, без отдельного запроса на каждой странице — раз в минуту */
let walletAt = 0;
document.addEventListener("wallet:changed", () => refreshWallet(true));
export async function refreshWallet(force = false) {
  if (!force && Date.now() - walletAt < 60000) return;
  walletAt = Date.now();
  try {
    const w = await api.get("/api/wallet");
    document.querySelectorAll(".sw-kc").forEach((b) => { b.textContent = w.kc.toLocaleString("ru-RU"); });
    document.querySelectorAll(".sw-lvl").forEach((b) => { b.textContent = `ур. ${w.level.level}`; });
  } catch { /* не важно */ }
}

export function refreshSidebarUser() {
  document.querySelectorAll(".sidebar-user").forEach((box) => {
    box.setAttribute("href", `/u/${state.me.username}`);
    box.replaceChildren(avatar(state.me, "", { presence: false }),
      h("div.grow", h("div.name", state.me.name), h("div.handle", `@${state.me.username}`)));
  });
  document.querySelectorAll('[data-nav="Моя страница"]').forEach((a) => a.setAttribute("href", `/u/${state.me.username}`));
}
