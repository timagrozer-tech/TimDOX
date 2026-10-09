// Точка входа клиентского приложения.
import { api, state, loadMe, connectStream, on, clearApiCache } from "./api.js";
import { saveInitData, tgInitData } from "./components/tglink.js";
import { initTelegramApp } from "./tgapp.js";
import { h, avatar } from "./dom.js";
import { route, onRender, onLeave, start, navigate } from "./router.js";
import { stopAllMedia } from "./components/mediakit.js";
import { restoreLook } from "./look.js";
import { initPwa } from "./pwa.js";
import { render as rerender } from "./router.js";

/** «Потяните вниз, чтобы обновить» — на телефоне в ленте, уведомлениях, профиле и т. п. */
function initPullToRefresh() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const ALLOW = /^\/($|explore|notifications|u\/|friends|communities|c\/|events|guests|stats|music|bookmarks|tag\/)/;
  const ind = h("div.ptr", h("span.ptr-spin"));
  document.body.append(ind);
  let y0 = null, dist = 0, busyNow = false;
  addEventListener("touchstart", (e) => {
    if (busyNow || window.scrollY > 0 || !ALLOW.test(location.pathname) || document.querySelector(".modal-backdrop, .menu")) { y0 = null; return; }
    y0 = e.touches[0].clientY; dist = 0;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dist = Math.max(0, e.touches[0].clientY - y0);
    if (window.scrollY > 0) { y0 = null; dist = 0; }
    const d = Math.min(90, dist * .5);
    ind.style.transform = `translate(-50%, ${d - 50}px) rotate(${d * 4}deg)`;
    ind.classList.toggle("ready", d >= 60);
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 == null) return;
    const go = Math.min(90, dist * .5) >= 60;
    y0 = null;
    if (!go) { ind.style.transform = ""; ind.classList.remove("ready"); return; }
    busyNow = true;
    ind.classList.add("loading");
    navigator.vibrate?.(10);
    clearApiCache();
    try { await rerender(true); } catch { /* ошибка покажется на странице */ }
    setTimeout(() => { ind.classList.remove("loading", "ready"); ind.style.transform = ""; busyNow = false; }, 300);
  });
}
import { applyUserLook } from "./app-actions.js";
import { toast, closeAllModals, closeMenu, setTitle, applyTheme } from "./ui.js";
import { ensureShell, setActive, destroyShell } from "./components/layout.js";
import { notifText, notifLink } from "./components/notif.js";
import { initFx } from "./fx.js";
import { initMotion } from "./motion.js";
import { initLiquid } from "./liquid.js";

import * as authPages from "./pages/auth.js";
import { feedPage } from "./pages/feed.js";
import { queueTour, stopTour } from "./tour.js";

// Страницы грузятся только при первом заходе в раздел: на старте браузер скачивает и разбирает
// в несколько раз меньше кода (лента открывается быстрее, особенно на телефоне)
const lazy = (load, name) => (...args) => load().then((m) => m[name](...args));
const P = {
  profile: () => import("./pages/profile.js"), post: () => import("./pages/post.js"), friends: () => import("./pages/friends.js"),
  messages: () => import("./pages/messages.js"), notifications: () => import("./pages/notifications.js"),
  search: () => import("./pages/search.js"), bookmarks: () => import("./pages/bookmarks.js"), settings: () => import("./pages/settings.js"),
  collection: () => import("./pages/collection.js"), calltest: () => import("./pages/calltest.js"), reels: () => import("./pages/reels.js"),
  stickers: () => import("./pages/stickers.js"), legal: () => import("./pages/legal.js"), communities: () => import("./pages/communities.js"),
  events: () => import("./pages/events.js"), guests: () => import("./pages/guests.js"), admin: () => import("./pages/admin.js"),
  world: () => import("./pages/world.js"), stats: () => import("./pages/stats.js"), invite: () => import("./pages/invite.js"),
  wallet: () => import("./pages/wallet.js"), shop: () => import("./pages/shop.js"), market: () => import("./pages/market.js"),
  welcome: () => import("./pages/welcome.js"), music: () => import("./pages/music.js"),
};
const legalPage = (kind) => (...args) => P.legal().then((m) => m.legalPage(kind)(...args));
const profilePage = lazy(P.profile, "profilePage"), postPage = lazy(P.post, "postPage"), friendsPage = lazy(P.friends, "friendsPage");
const messagesPage = lazy(P.messages, "messagesPage"), notificationsPage = lazy(P.notifications, "notificationsPage");
const searchPage = lazy(P.search, "searchPage"), tagPage = lazy(P.search, "tagPage"), bookmarksPage = lazy(P.bookmarks, "bookmarksPage");
const settingsPage = lazy(P.settings, "settingsPage"), collectionPage = lazy(P.collection, "collectionPage");
const callTestPage = lazy(P.calltest, "callTestPage"), reelsPage = lazy(P.reels, "reelsPage"), stickersPage = lazy(P.stickers, "stickersPage");
const communitiesPage = lazy(P.communities, "communitiesPage"), communityPage = lazy(P.communities, "communityPage");
const eventsPage = lazy(P.events, "eventsPage"), eventPage = lazy(P.events, "eventPage"), guestsPage = lazy(P.guests, "guestsPage");
const adminPage = lazy(P.admin, "adminPage"), worldPage = lazy(P.world, "worldPage"), statsPage = lazy(P.stats, "statsPage");
const invitePage = lazy(P.invite, "invitePage"), walletPage = lazy(P.wallet, "walletPage"), shopPage = lazy(P.shop, "shopPage");
const marketPage = lazy(P.market, "marketPage"), welcomePage = lazy(P.welcome, "welcomePage");
const musicPage = lazy(P.music, "musicPage"), genrePage = lazy(P.music, "genrePage"), playlistPage = lazy(P.music, "playlistPage");
const showReveal = (...a) => P.collection().then((m) => m.showReveal(...a));
// звонки должны слушать события с самого начала — модуль грузится сразу, но параллельно, не задерживая первый показ
const callsReady = import("./call/call.js").then((m) => m.initCalls()).catch((e) => console.error(e));
// нажали на пункт меню — пока палец поднимается, уже грузим код раздела и его данные
const pf = (u) => api.get(u).catch(() => {});
const PREFETCH = [
  [/^\/$/, () => { pf("/api/feed"); pf("/api/stories"); }],
  [/^\/messages$/, () => { P.messages().catch(() => {}); pf("/api/conversations"); }],
  [/^\/notifications$/, () => { P.notifications().catch(() => {}); pf("/api/notifications"); }],
  [/^\/reels$/, () => { P.reels().catch(() => {}); pf("/api/reels"); }],
  [/^\/u\/([^/]+)$/, (m) => { P.profile().catch(() => {}); pf(`/api/users/${encodeURIComponent(decodeURIComponent(m[1]))}`); }],
  [/^\/music$/, () => { P.music().catch(() => {}); }],
];
document.addEventListener("pointerdown", (e) => {
  const a = e.target.closest?.(".tabbar a[href], .sidebar a[href], .topbar a[href], .nav a[href]");
  if (!a || !state.me || a.origin !== location.origin || a.pathname === location.pathname) return;
  for (const [re, fn] of PREFETCH) { const m = a.pathname.match(re); if (m) { try { fn(m); } catch { /* */ } break; } }
}, { passive: true, capture: true });
// самые частые разделы подгружаем заранее, когда браузер свободен, — переход будет мгновенным
const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
setTimeout(() => idle(() => { for (const k of ["messages", "profile", "notifications", "reels", "post"]) P[k]().catch(() => {}); }), 4000);

// public: доступна без входа; guestOnly: только для гостей
route("/login", authPages.loginPage, { public: true, guestOnly: true });
route("/register", authPages.registerPage, { public: true, guestOnly: true });
route("/forgot", authPages.forgotPage, { public: true, guestOnly: true });
route("/reset", authPages.resetPage, { public: true });
route("/verify", authPages.verifyPage, { public: true });
route("/privacy", legalPage("privacy"), { public: true });
route("/terms", legalPage("terms"), { public: true });
route("/consent", legalPage("consent"), { public: true });
route("/cookies", legalPage("cookies"), { public: true });
route("/ai-consent", legalPage("ai"), { public: true });
route("/", feedPage);
route("/explore", feedPage);
route("/u/:username", profilePage);
route("/post/:id", postPage);
route("/friends", friendsPage);
route("/messages", messagesPage, { wide: true });
route("/messages/:id", messagesPage, { wide: true });
route("/notifications", notificationsPage);
route("/search", searchPage);
route("/tag/:tag", tagPage);
route("/bookmarks", bookmarksPage);
route("/invite", invitePage);
route("/wallet", walletPage);
route("/shop", shopPage);
route("/market", marketPage);
route("/welcome", welcomePage, { bare: true });
route("/settings", settingsPage);
route("/communities", communitiesPage);
route("/c/:slug", communityPage);
route("/events", eventsPage);
route("/events/:id", eventPage);
route("/guests", guestsPage);
route("/stats", statsPage);
route("/music", musicPage);
route("/music/genre/:slug", genrePage);
route("/music/playlist/:id", playlistPage);
route("/admin", adminPage);
route("/world", worldPage);
route("/collection", collectionPage);
route("/calltest", callTestPage);
route("/reels", reelsPage);
route("/reels/:id", reelsPage);
route("/stickers", stickersPage);
route("/stickers/:slug", stickersPage);

const root = document.getElementById("app");

// Страницы для мгновенного «Назад»: лента, профили, сообщества и т.п. сохраняются вместе с прокруткой
const pageCache = new Map();
const CACHEABLE = /^\/($|explore$|u\/[^/]+$|tag\/[^/]+$|c\/[^/]+$|bookmarks$|search$|communities$|events$|friends$|notifications$|guests$)/;
let shown = null;
onLeave((key) => {
  if (!key || !shown?.node?.isConnected || !CACHEABLE.test(shown.path)) return;
  pageCache.set(key, { url: shown.url, node: shown.node, scroll: window.scrollY, title: document.title });
  while (pageCache.size > 8) pageCache.delete(pageCache.keys().next().value);
});

let renderGen = 0;
onRender(async (m, query, sameUrl, backKey) => {
  const myGen = ++renderGen;
  closeAllModals();
  closeMenu();
  stopTour();
  stopAllMedia();
  const path = location.pathname;
  if (!m) {
    if (!state.me) return navigate("/login", { replace: true });
    const shell = ensureShell(root);
    setActive(path);
    setTitle("Страница не найдена");
    shell.main.replaceChildren(h("div.card.empty", h("h2", "Страница не найдена"), h("p", "Возможно, ссылка устарела."), h("a.btn.primary", { href: "/" }, "На главную")));
    return;
  }
  if (!m.opts.public && !state.me) {
    return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
  }
  if (m.opts.guestOnly && state.me && !(path === "/login" && query.add)) return navigate("/", { replace: true });

  const useShell = !!state.me && !m.opts.guestOnly && !m.opts.bare && !["/reset", "/verify"].includes(path);
  let container;
  if (useShell) {
    const shell = ensureShell(root);
    setActive(path, !!m.opts.wide);
    container = shell.main;
  } else {
    destroyShell();
    document.body.classList.remove("wide");
    container = root;
  }
  const cached = backKey && useShell ? pageCache.get(backKey) : null;
  if (cached && cached.url === location.pathname + location.search) {
    pageCache.delete(backKey);
    container.replaceChildren(cached.node);
    document.title = cached.title;
    shown = { url: cached.url, path, node: cached.node };
    requestAnimationFrame(() => window.scrollTo(0, cached.scroll));
    return;
  }
  container.replaceChildren(h("div.spinner", { role: "status", "aria-label": "Загрузка" }));
  let node = null;
  try {
    node = await m.handler({ params: m.params, query, path });
    if (myGen !== renderGen) return; // пользователь уже ушёл на другую страницу (или сменил вкладку в адресе)
    node.classList?.add("page-enter");
    container.replaceChildren(node);
  } catch (e) {
    if (myGen !== renderGen) return;
    console.error(e);
    container.replaceChildren(h("div.card.empty", h("h2", e.status === 404 ? "Не найдено" : "Не удалось загрузить страницу"), h("p", e.message),
      h("a.btn.primary", { href: "/" }, "На главную")));
  }
  shown = { url: location.pathname + location.search, path, node };
  window.scrollTo(0, 0);
  if (useShell && node) queueTour(path, query); // обучение при первом заходе в раздел
  if (useShell && document.activeElement === document.body) container.focus({ preventScroll: true });
});

// ---------------------------------------------------------------- События реального времени
on("notification", (n) => {
  if (n.type === "item" && n.extra?.item) {
    showReveal({ id: n.extra.item, name: n.extra.name, slot: n.extra.slot, rarity: n.extra.rarity });
    return;
  }
  if (location.pathname === "/notifications") return;
  toast(notifText(n), { title: n.actor.name, avatar: avatar(n.actor, "sm", { presence: false }), href: notifLink(n) });
});
on("message", ({ message, sender }) => {
  if (!state.me || sender.id === state.me.id) return;
  if (location.pathname === `/messages/${message.conversation_id}`) return;
  P.messages().then(({ previewOf }) => toast(previewOf(message), { title: sender.name, avatar: avatar(sender, "sm", { presence: false }), href: `/messages/${message.conversation_id}` }));
});
on("logged-out", () => {
  state.me = null;
  destroyShell();
  navigate("/login", { replace: true });
});

// ---------------------------------------------------------------- Запуск
restoreLook();
initMotion();
initLiquid();
initFx();
initAvatarFallback();
initPwa();
initPullToRefresh();

// Открыто из бота Telegram (мини-приложение): если аккаунт привязан — входим без пароля
async function telegramLogin() {
  if (!location.hash.includes("tgWebAppData")) {
    if (tgInitData()) document.documentElement.classList.add("in-telegram");
    return;
  }
  const initData = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
  history.replaceState(history.state, "", location.pathname + location.search);
  document.documentElement.classList.add("in-telegram");
  if (initData) saveInitData(initData);
  if (!initData || state.me) return;
  try {
    await api.post("/api/auth/telegram", { init_data: initData });
    await loadMe();
  } catch (e) {
    if (e?.code && e.code !== "tg_not_linked") toast(e.message);
  }
}

// 3D-стикеры стали живыми: у тех, кто собрал персонажа раньше, один раз тихо пересобираем набор
async function upgradeAvatarStickers() {
  const KEY = "krug:a3dLive:v1";
  try { if (localStorage.getItem(KEY) || document.hidden || !state.me?.username) return; } catch { return; }
  try {
    const u = await api.get(`/api/users/${encodeURIComponent(state.me.username)}`);
    if (!u.avatar3d) { localStorage.setItem(KEY, "none"); return; }
    const m = await import("./components/avatar3d-stickers.js");
    const pack = await m.buildAvatarStickers(u.avatar3d, { quiet: true });
    if (pack) {
      localStorage.setItem(KEY, "1");
      toast("Ваши 3D-стикеры ожили — загляните в смайлики чата 😎", { icon: "sparkle", duration: 5000 });
    }
  } catch { /* попробуем в следующий раз */ }
}

(async function boot() {
  try {
    await loadMe();
  } catch {
    // сервер недоступен — покажем страницу входа, она сообщит об ошибке
  }
  try { await telegramLogin(); } catch { /* вход из Telegram — необязателен */ }
  if (state.me) {
    applyUserLook();
    await callsReady;
    connectStream();
    import("./music/player.js").then((m) => m.initPlayer()).catch(() => {});
    P.wallet().then((m) => m.initCheckin()).catch(() => {});
  }
  start();
  try { initTelegramApp(); } catch { /* вне Telegram или старый клиент */ }
  if (state.me) setTimeout(upgradeAvatarStickers, 7000);
  if (state.me) setTimeout(() => import("./perfbeacon.js").then((m) => m.startPerfBeacon()).catch(() => {}), 2000);
  setTimeout(() => import("./components/consent.js").then((m) => m.cookieNotice()).catch(() => {}), 1500);
})();

// Аватары: если миниатюра не загрузилась — пробуем оригинал, если и он недоступен — показываем инициалы.
// Один обработчик на всё приложение — работает в ленте, чатах, уведомлениях, поиске и везде, где есть .avatar
function initAvatarFallback() {
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const box = img.closest(".avatar, .tc-by");
    if (!box) return;
    if (img.src.includes("_t.webp") && !img.dataset.retried) { img.dataset.retried = "1"; img.src = img.src.replace("_t.webp", ".webp"); return; }
    const name = box.dataset.name || box.getAttribute("title") || box.closest("[aria-label]")?.getAttribute("aria-label") || img.alt || "";
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•";
    img.remove();
    box.classList.add("initials");
    if (!box.textContent.trim()) box.prepend(initials);
  }, true);
}
