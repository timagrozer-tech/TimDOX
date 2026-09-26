// Точка входа клиентского приложения.
import { state, loadMe, connectStream, on } from "./api.js";
import { h, avatar } from "./dom.js";
import { route, onRender, start, navigate } from "./router.js";
import { toast, closeAllModals, closeMenu, setTitle, applyTheme } from "./ui.js";
import { ensureShell, setActive, destroyShell } from "./components/layout.js";
import { notifText, notifLink } from "./components/notif.js";

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
import { legalPage } from "./pages/legal.js";

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
route("/settings", settingsPage);

const root = document.getElementById("app");

onRender(async (m, query) => {
  closeAllModals();
  closeMenu();
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
  container.replaceChildren(h("div.spinner", { role: "status", "aria-label": "Загрузка" }));
  try {
    const node = await m.handler({ params: m.params, query, path });
    if (location.pathname !== path) return; // пользователь уже ушёл на другую страницу
    container.replaceChildren(node);
  } catch (e) {
    console.error(e);
    container.replaceChildren(h("div.card.empty", h("h3", e.status === 404 ? "Не найдено" : "Не удалось загрузить страницу"), h("p", e.message),
      h("a.btn.primary", { href: "/" }, "На главную")));
  }
  if (!history.state?.keepScroll) window.scrollTo(0, 0);
  if (useShell && document.activeElement === document.body) container.focus({ preventScroll: true });
});

// ---------------------------------------------------------------- События реального времени
on("notification", (n) => {
  if (location.pathname === "/notifications") return;
  toast(notifText(n), { title: n.actor.name, avatar: avatar(n.actor, "sm", { presence: false }), href: notifLink(n) });
});
on("message", ({ message, sender }) => {
  if (!state.me || sender.id === state.me.id) return;
  if (location.pathname === `/messages/${message.conversation_id}`) return;
  toast(message.text, { title: sender.name, avatar: avatar(sender, "sm", { presence: false }), href: `/messages/${message.conversation_id}` });
});
on("logged-out", () => {
  state.me = null;
  destroyShell();
  navigate("/login", { replace: true });
});

// ---------------------------------------------------------------- Запуск
(async function boot() {
  try {
    await loadMe();
  } catch {
    // сервер недоступен — покажем страницу входа, она сообщит об ошибке
  }
  if (state.me) {
    if (state.me.theme && state.me.theme !== "system") applyTheme(state.me.theme);
    connectStream();
  }
  start();
})();
