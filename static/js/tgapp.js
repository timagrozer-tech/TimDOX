// Yarko как мини-приложение Telegram: на весь экран, системная кнопка «Назад», цвета шапки под тему,
// лёгкая вибрация на нажатиях и защита от случайного закрытия свайпом вниз.
// Работаем напрямую по протоколу Telegram WebView (postEvent / receiveEvent) — без внешних скриптов.
import { canGoBack, navigate } from "./router.js";

const handlers = {};
let isTg = false;

function post(type, data = {}) {
  try {
    const proxy = window.TelegramWebviewProxy;
    if (proxy?.postEvent) proxy.postEvent(type, JSON.stringify(data));
    else if (window.external?.notify) window.external.notify(JSON.stringify({ eventType: type, eventData: data }));
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), "https://web.telegram.org");
  } catch { /* старый клиент Telegram — просто без этой возможности */ }
}

function receive(type, data) {
  try { handlers[type]?.(data); } catch (e) { console.error(e); }
}

function hex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || "");
  return m ? "#" + m.slice(1, 4).map((x) => (+x).toString(16).padStart(2, "0")).join("") : null;
}

function paintChrome() {
  const bg = hex(getComputedStyle(document.body).backgroundColor) || (document.documentElement.dataset.theme === "dark" ? "#08080f" : "#fbfaff");
  post("web_app_set_header_color", { color: bg });
  post("web_app_set_background_color", { color: bg });
  post("web_app_set_bottom_bar_color", { color: bg });
}

let backShown = null;
function syncBack() {
  const show = !!canGoBack();
  if (show !== backShown) { backShown = show; post("web_app_setup_back_button", { is_visible: show }); }
}

let lastBuzz = 0;
export function haptic(kind = "light") {
  if (!isTg) return;
  const now = Date.now();
  if (now - lastBuzz < 60) return;
  lastBuzz = now;
  if (kind === "success" || kind === "error" || kind === "warning") post("web_app_trigger_haptic_feedback", { type: "notification", notification_type: kind });
  else if (kind === "select") post("web_app_trigger_haptic_feedback", { type: "selection_change" });
  else post("web_app_trigger_haptic_feedback", { type: "impact", impact_style: kind });
}

export function inTelegramApp() { return isTg; }

export function initTelegramApp() {
  isTg = document.documentElement.classList.contains("in-telegram");
  if (!isTg) return;
  // приём событий: нативные клиенты вызывают Telegram.WebView.receiveEvent, веб-версия присылает postMessage
  window.Telegram = window.Telegram || {};
  const prev = window.Telegram.WebView?.receiveEvent;
  window.Telegram.WebView = { ...(window.Telegram.WebView || {}), receiveEvent(type, data) { receive(type, data); prev?.(type, data); } };
  window.TelegramGameProxy_receiveEvent = window.Telegram.WebView.receiveEvent;
  window.addEventListener("message", (e) => {
    if (e.origin !== "https://web.telegram.org") return;
    try { const m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; if (m?.eventType) receive(m.eventType, m.eventData); } catch { /* чужое */ }
  });

  handlers.back_button_pressed = () => {
    haptic("light");
    if (canGoBack()) history.back(); else navigate("/", { replace: true });
  };
  handlers.theme_changed = () => setTimeout(paintChrome, 50);

  post("web_app_ready");
  post("web_app_expand");
  post("web_app_setup_swipe_behavior", { allow_vertical_swipe: false }); // прокрутка ленты вверх больше не сворачивает Yarko
  paintChrome();
  syncBack();

  // кнопка «Назад» и цвета — следим за переходами, окнами и сменой темы
  window.addEventListener("popstate", () => setTimeout(syncBack, 0));
  const _push = history.pushState.bind(history), _replace = history.replaceState.bind(history);
  history.pushState = (...a) => { _push(...a); setTimeout(syncBack, 0); };
  history.replaceState = (...a) => { _replace(...a); setTimeout(syncBack, 0); };
  new MutationObserver(() => setTimeout(paintChrome, 30)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "data-bg"] });

  // вибрация: лёгкая на кнопках и ссылках, «щелчок» на вкладках и переключателях
  document.addEventListener("click", (e) => {
    const t = e.target.closest?.('button, a[href], [role="tab"], input[type="checkbox"], .tab, summary');
    if (!t || t.disabled) return;
    haptic(t.matches('[role="tab"], input[type="checkbox"], .tab, summary') ? "select" : "light");
  }, true);
}
