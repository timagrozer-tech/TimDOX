// Точка входа клиентского приложения.
import { state, loadMe, connectStream, on } from "./api.js";
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
    try { await rerender(true); } catch { /* ошибка покажется на странице */ }
    setTimeout(() => { ind.classList.remove("loading", "ready"); ind.style.transform = ""; busyNow = false; }, 300);
  });
}
import { applyUserLook } from "./app-actions.js";
import { toast, closeAllModals, closeMenu, setTitle, applyTheme } from "./ui.js";
import { ensureShell, setActive, destroyShell } from "./components/layout.js";
import { notifText, notifLink } from "./components/notif.js";
import { initFx } from "./fx.js";

import * as authPages from "./pages/auth.js";
import { feedPage } from "./pages/feed.js";
import { profilePage } from "./pages/profile.js";
import { postPage } from "./pages/post.js";
import { friendsPage } from "./pages/friends.js";
import { messagesPage } from "./pages/messages.js";
import { notificationsPage } from "./pages/notifications.js";
import { searchPage, tagPage } from "./pages/search.js";
import { bookmarksPage } from "./pages/bookmarks.js";
import { settingsPage } from "./pages/settings.js";
import { collectionPage, showReveal } from "./pages/collection.js";
import { reelsPage } from "./pages/reels.js";
import { stickersPage } from "./pages/stickers.js";
import { previewOf } from "./pages/messages.js";
import { legalPage } from "./pages/legal.js";
import { communitiesPage, communityPage } from "./pages/communities.js";
import { eventsPage, eventPage } from "./pages/events.js";
import { guestsPage } from "./pages/guests.js";
import { adminPage } from "./pages/admin.js";
import { worldPage } from "./pages/world.js";
import { statsPage } from "./pages/stats.js";
import { invitePage } from "./pages/invite.js";
import { musicPage, genrePage, playlistPage } from "./pages/music.js";
import { initPlayer } from "./music/player.js";

// public: доступна без входа; guestOnly: только для гостей
route("/login", authPages.loginPage, { public: true, guestOnly: true });
route("/register", authPages.registerPage, { public: true, guestOnly: true });
route("/forgot", authPages.forgotPage, { public: true, guestOnly: true });
route("/reset", authPages.resetPage, { public: true });
route("/verify", authPages.verifyPage, { public: true });
route("/privacy", legalPage("privacy"), { public: true });
route("/terms", legalPage("terms"), { public: true });
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
  stopAllMedia();
  const path = location.pathname;
  if (!m) {
    if (!state.me) return navigate("/login", { replace: true });
    const shell = ensureShell(root);
    setActive(path);
    setTitle("Страница не найдена");
    shell.main.replaceChildren(h("div.card.empty", h("h3", "Страница не найдена"), h("p", "Возможно, ссылка устарела."), h("a.btn.primary", { href: "/" }, "На главную")));
    return;
  }
  if (!m.opts.public && !state.me) {
    return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
  }
  if (m.opts.guestOnly && state.me) return navigate("/", { replace: true });

  const useShell = !!state.me && !m.opts.guestOnly && !["/reset", "/verify"].includes(path);
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
    container.replaceChildren(h("div.card.empty", h("h3", e.status === 404 ? "Не найдено" : "Не удалось загрузить страницу"), h("p", e.message),
      h("a.btn.primary", { href: "/" }, "На главную")));
  }
  shown = { url: location.pathname + location.search, path, node };
  window.scrollTo(0, 0);
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
  toast(previewOf(message), { title: sender.name, avatar: avatar(sender, "sm", { presence: false }), href: `/messages/${message.conversation_id}` });
});
on("logged-out", () => {
  state.me = null;
  destroyShell();
  navigate("/login", { replace: true });
});

// ---------------------------------------------------------------- Запуск
restoreLook();
initFx();
initPwa();
initPullToRefresh();

(async function boot() {
  try {
    await loadMe();
  } catch {
    // сервер недоступен — покажем страницу входа, она сообщит об ошибке
  }
  if (state.me) {
    applyUserLook();
    connectStream();
    initPlayer();
  }
  start();
})();
