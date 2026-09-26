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

export function navigate(url, { replace = false } = {}) {
  if (url === location.pathname + location.search && !replace) { render(true); return; }
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  render();
}

export function setCleanup(fn) {
  const prev = cleanup;
  cleanup = prev ? () => { prev(); fn(); } : fn;
}

export async function render(sameUrl = false) {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const path = location.pathname;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  await renderFn?.(match(path), query, sameUrl);
}

export function start() {
  window.addEventListener("popstate", () => render());
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
