// Маршрутизация на History API.
const routes = [];
let renderFn = null;
let cleanup = null;

export function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  routes.push({ re, keys, handler, opts });
}

export function onRender(fn) { renderFn = fn; }

export function match(path) {
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { ...r, params };
    }
  }
  return null;
}

// Каждая запись истории получает ключ — по нему страница «Назад» восстанавливается мгновенно, с прокруткой
const newKey = () => Math.random().toString(36).slice(2, 10);
let curKey = null;
let leaveHook = null;
/** fn(key) вызывается перед уходом со страницы — чтобы сохранить её для кнопки «Назад» */
export function onLeave(fn) { leaveHook = fn; }
export function currentKey() { return curKey; }

// ---------------------------------------------------------------- Окна поверх страницы и кнопка «Назад»
// Открытое окно (фото, история, диалог) добавляет запись в историю: «Назад» на телефоне закрывает окно, а не страницу.
const overlays = [];
let ignorePop = false, pendingBack = false;
export function pushOverlay(close) {
  const o = { close, done: false };
  overlays.push(o);
  try { history.pushState({ ...(history.state || {}), overlay: true }, ""); } catch { /* ничего */ }
  return function release() {
    if (o.done) return;
    o.done = true;
    const i = overlays.indexOf(o);
    if (i >= 0) overlays.splice(i, 1);
    if (history.state?.overlay) {
      pendingBack = true;
      setTimeout(() => { if (pendingBack) { pendingBack = false; ignorePop = true; history.back(); } }, 0);
    }
  };
}

export function navigate(url, { replace = false } = {}) {
  // на сервере вышло обновление — открываем страницу заново, чтобы подтянулся новый интерфейс
  // …но не посреди песни: пока играет музыка Круга, обновимся при следующем переходе
  if (window.__krugUpdate && !window.__krugMusicPlaying) { location[replace ? "replace" : "assign"](url); return; }
  if (pendingBack || history.state?.overlay) { pendingBack = false; replace = true; } // запись окна заменяем новой страницей
  if (url === location.pathname + location.search && !replace) { render(true); return; }
  if (!replace) leaveHook?.(curKey);
  curKey = newKey();
  history[replace ? "replaceState" : "pushState"]({ key: curKey }, "", url);
  render();
}

export function setCleanup(fn) {
  const prev = cleanup;
  cleanup = prev ? () => { prev(); fn(); } : fn;
}

export async function render(sameUrl = false, back = false) {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const path = location.pathname;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  await renderFn?.(match(path), query, sameUrl, back ? curKey : null);
}

export function start() {
  try { history.scrollRestoration = "manual"; } catch { /* старые браузеры */ }
  curKey = history.state?.key || newKey();
  if (!history.state?.key) history.replaceState({ ...(history.state || {}), key: curKey }, "");
  window.addEventListener("popstate", () => {
    if (ignorePop) { ignorePop = false; return; }
    if (overlays.length) { // «Назад» закрывает открытое окно
      const o = overlays.pop();
      o.done = true;
      o.close();
      return;
    }
    if (history.state?.overlay) { history.back(); return; } // «висящая» запись закрытого окна — пропускаем
    leaveHook?.(curKey);
    curKey = history.state?.key || newKey();
    render(false, true);
  });
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/") || href.startsWith("/uploads/")) return;
    e.preventDefault();
    navigate(href);
  });
  render();
}
