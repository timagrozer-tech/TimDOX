// Общие элементы интерфейса: всплывающие сообщения, модальные окна, меню, просмотр фото, бесконечные списки.
import { updateThemeColor } from "./look.js";
import { h, icon, clear } from "./dom.js";
import { navigate, pushOverlay } from "./router.js";

// ---------------------------------------------------------------- Тосты
export function toast(text, opts = {}) {
  const box = document.getElementById("toasts");
  const el = h(`div.toast${opts.error ? ".error" : ""}${opts.href ? ".clickable" : ""}`, { role: opts.error ? "alert" : "status" },
    opts.avatar || (opts.icon ? icon(opts.icon) : null),
    h("div.t-body", opts.title ? h("b", opts.title) : null, h("span", text)));
  if (opts.href) el.addEventListener("click", () => { navigate(opts.href); dismiss(); });
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  const dismiss = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 200); };
  setTimeout(dismiss, opts.duration || 3800);
  return el;
}
export const toastError = (err) => toast(err?.message || String(err), { error: true, icon: "x" });

// ---------------------------------------------------------------- Модальные окна
let openModals = [];

/** Окно поверх страницы: закрывается при переходе на другую страницу и кнопкой «Назад».
 *  closeFn — как закрыть окно; возвращает done(), которую окно вызывает, когда закрылось само. */
export function trackOverlay(closeFn) {
  let finished = false;
  const entry = () => closeFn();
  openModals.push(entry);
  const finish = () => { if (finished) return false; finished = true; openModals = openModals.filter((m) => m !== entry); return true; };
  const release = pushOverlay(() => { if (finish()) closeFn(); });
  return () => { finish(); release(); };
}

/** Tab не уходит из открытого окна */
function trapFocus(e, root) {
  if (e.key !== "Tab") return;
  const items = [...root.querySelectorAll("button:not([disabled]), [href], input:not([type=hidden]):not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function modal({ title, body, footer, narrow = false, wide = false, sheet = true, onClose }) {
  const prevFocus = document.activeElement;
  let closed = false, done = null;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    done?.();
    document.removeEventListener("keydown", onKey);
    if (!document.querySelector(".modal-backdrop, .lightbox, .story-viewer, .story-editor")) document.body.style.overflow = "";
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => {
    if (document.querySelectorAll(".modal-backdrop").length && [...document.querySelectorAll(".modal-backdrop")].at(-1) !== backdrop) return;
    if (e.key === "Escape") close();
    trapFocus(e, dialog);
  };
  const dialog = h(`div.modal${narrow ? ".narrow" : ""}${wide ? ".wide" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": title || "Окно" },
    title ? h("div.modal-head", h("h2", title),
      h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Закрыть", onclick: close }, icon("x"))) : null,
    h("div.modal-body", body),
    footer ? h("div.modal-foot", footer) : null);
  const backdrop = h(`div.modal-backdrop${sheet ? ".sheet" : ""}`, { onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  done = trackOverlay(close);
  requestAnimationFrame(() => (dialog.querySelector("textarea, input:not([type=hidden]), select, .btn.primary, .btn.accent") || dialog.querySelector("button"))?.focus());
  return { close, dialog };
}

export function closeAllModals() { [...openModals].reverse().forEach((c) => c()); }

export function confirmDialog({ title, text, confirm = "Подтвердить", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({
      title, narrow: true, sheet: false,
      body: h("p.text-2", text),
      footer: [
        h("button.btn.ghost", { type: "button", onclick: () => finish(false) }, "Отмена"),
        h(`button.btn.${danger ? "danger" : "primary"}`, { type: "button", onclick: () => finish(true) }, confirm),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, placeholder = "", confirm = "Отправить", options, value = "" }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h("textarea.textarea", { placeholder, maxlength: 500, rows: 3 });
    input.value = value;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const opts = options ? h("div.stack", { style: { gap: "6px", marginBottom: "12px" } },
      options.map((o) => h("label.check", h("input", { type: "radio", name: "opt", value: o, onchange: () => { input.value = o; } }), o))) : null;
    const m = modal({
      title, narrow: true, sheet: false,
      body: h("div.field", opts, label ? h("label", label) : null, input),
      footer: [
        h("button.btn.ghost", { type: "button", onclick: () => finish(null) }, "Отмена"),
        h("button.btn.primary", { type: "button", onclick: () => finish(input.value.trim() || options?.[0] || "") }, confirm),
      ],
      onClose: () => finish(null),
    });
  });
}

// ---------------------------------------------------------------- Выпадающее меню
let openMenu = null;
export function showMenu(anchor, items, { onClose = null, title = null } = {}) {
  closeMenu();
  const menu = h("div.menu", { role: "menu" }, title ? h("div.menu-title", title) : null,
    items.filter(Boolean).map((it) => it === "-" ? h("hr") :
      h(`button${it.danger ? ".danger" : ""}${it.checked ? ".checked" : ""}`, { type: "button", role: it.checked != null ? "menuitemradio" : "menuitem", "aria-checked": it.checked != null ? String(!!it.checked) : null, onclick: () => { closeMenu(); it.onClick(); } },
        it.icon ? icon(it.icon) : null,
        it.hint ? h("span.mi-text", h("span", it.label), h("small", it.hint)) : it.label,
        it.checked ? h("span.mi-check", icon("check", "sm")) : null)));
  if (items.some((it) => it && it.hint)) menu.classList.add("rich");
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  // На телефоне меню — лист снизу: своё затемнение (закрывает касанием), страница под ним не прокручивается,
  // а прокрутка самого листа или случайный сдвиг страницы меню не закрывают.
  const sheet = matchMedia("(max-width: 719px)").matches;
  let backdrop = null;
  if (sheet) {
    backdrop = h("div.menu-backdrop", { "aria-hidden": "true" });
    backdrop.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); });
    backdrop.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    menu.before(backdrop);
    document.documentElement.classList.add("menu-lock");
  } else {
    menu.querySelector("button")?.focus();
  }
  const opened = performance.now();
  const onDoc = (e) => {
    if (sheet || performance.now() - opened < 300) return;
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { closeMenu(); anchor.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const btns = [...menu.querySelectorAll("button")];
      const i = btns.indexOf(document.activeElement);
      btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
      e.preventDefault();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDoc));
  document.addEventListener("keydown", onKey);
  const y0 = window.scrollY;
  const onScroll = () => { if (!sheet && Math.abs(window.scrollY - y0) > 40) closeMenu(); };
  window.addEventListener("scroll", onScroll, { passive: true });
  openMenu = () => {
    menu.remove();
    backdrop?.remove();
    onClose?.();
    document.documentElement.classList.remove("menu-lock");
    document.removeEventListener("mousedown", onDoc);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll);
  };
}
export function closeMenu() { openMenu?.(); openMenu = null; }

// ---------------------------------------------------------------- Просмотр фото
export function lightbox(items, index = 0) {
  let i = index;
  const img = h("img", { alt: "" });
  const count = h("div.lb-count");
  const alt = h("div.lb-alt");
  let show = () => {
    img.src = items[i].url;
    img.alt = items[i].alt || "Фото";
    count.textContent = items.length > 1 ? `${i + 1} из ${items.length}` : "";
    alt.textContent = items[i].alt || "";
  };
  let done = null;
  const prevFocus = document.activeElement;
  const close = () => {
    if (!box.isConnected) return;
    box.classList.add("leaving");
    setTimeout(() => box.remove(), 160);
    done?.();
    document.removeEventListener("keydown", onKey);
    if (!document.querySelector(".modal-backdrop, .story-viewer, .story-editor")) document.body.style.overflow = "";
    prevFocus?.focus?.();
  };
  const go = (d) => { i = (i + d + items.length) % items.length; show(); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
  };
  const multi = items.length > 1;
  const dots = multi && items.length <= 10 ? h("div.lb-dots", items.map(() => h("i"))) : null;
  const box = h("div.lightbox", { role: "dialog", "aria-modal": "true", "aria-label": "Просмотр фото", onclick: (e) => { if (e.target === box) close(); } },
    img, count, alt, dots,
    h("button.lb-btn.lb-close", { "aria-label": "Закрыть", onclick: close }, icon("x")),
    multi ? h("button.lb-btn.lb-prev", { "aria-label": "Предыдущее", onclick: () => go(-1) }, icon("back")) : null,
    multi ? h("button.lb-btn.lb-next", { "aria-label": "Следующее", onclick: () => go(1) }, icon("chevronRight")) : null);
  // жесты: влево-вправо — листать, вниз — закрыть
  let sx = null, sy = null;
  box.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  box.addEventListener("touchmove", (e) => {
    if (sy == null) return;
    const dy = e.touches[0].clientY - sy, dx = e.touches[0].clientX - sx;
    if (dy > 0 && Math.abs(dy) > Math.abs(dx)) { img.style.transform = `translateY(${dy}px) scale(${1 - Math.min(dy, 300) / 1500})`; box.style.setProperty("--lb-dim", String(Math.max(.3, 1 - dy / 400))); }
  }, { passive: true });
  box.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    img.style.transform = ""; box.style.removeProperty("--lb-dim");
    if (dy > 110 && Math.abs(dy) > Math.abs(dx)) close();
    else if (multi && Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    sx = sy = null;
  });
  const paintDots = () => dots && [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
  const show0 = show;
  show = () => { show0(); paintDots(); };
  show();
  document.body.append(box);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  done = trackOverlay(close);
  box.querySelector(".lb-close").focus();
}

// ---------------------------------------------------------------- Бесконечный список
/**
 * load(cursor) -> {items, next_cursor}; render(item) -> Node
 * Возвращает {el, reload, prepend}.
 */
/** Скелетон вместо спиннера: форма повторяет настоящие элементы, поэтому страница не «прыгает» при загрузке */
export function skeleton(kind = "post", n = 3) {
  const bar = (w, hgt = 12) => h("i.sk", { style: { width: w, height: `${hgt}px` } });
  if (kind === "grid") return h("div.sk-grid", { "aria-hidden": "true" }, Array.from({ length: 6 }, () => h("i.sk.sk-tile")));
  if (kind === "row") return h("div.sk-list", { "aria-hidden": "true" }, Array.from({ length: n + 2 }, (_, i) =>
    h("div.sk-row", h("i.sk.sk-av"), h("div.sk-lines", bar(`${70 - (i % 3) * 12}%`), bar(`${40 + (i % 2) * 15}%`, 10)))));
  return h("div.sk-list", { "aria-hidden": "true" }, Array.from({ length: n }, (_, i) =>
    h("div.sk-post", h("div.sk-row", h("i.sk.sk-av"), h("div.sk-lines", bar("38%"), bar("22%", 10))),
      bar("92%"), bar(`${78 - i * 9}%`), i === 0 ? h("i.sk.sk-media") : null)));
}

export function infiniteList({ load, render, empty, container, onLoaded, skeleton: skKind }) {
  const list = container || h("div");
  const sentinel = h("div.sentinel");
  const status = h("div");
  const wrap = h("div", list, status, sentinel);
  let cursor = null, done = false, loading = false, count = 0, gen = 0, errored = false;

  async function more() {
    if (loading || done || errored) return;
    loading = true;
    const my = gen;
    const kind = skKind || (container?.classList.contains("photo-grid") || container?.classList.contains("reel-grid") ? "grid" : "post");
    status.replaceChildren(count === 0
      ? h("div", { role: "status", "aria-label": "Загрузка" }, skeleton(kind))
      : h("div.spinner", { role: "status", "aria-label": "Загрузка" }));
    try {
      const data = await load(cursor);
      if (my !== gen) return;
      for (const item of data.items) {
        const node = render(item);
        if (node) { list.append(node); count++; }
      }
      cursor = data.next_cursor;
      done = !cursor;
      onLoaded?.(data);
      status.replaceChildren();
      if (done) status.replaceChildren(count === 0 ? (typeof empty === "function" ? empty() : empty || "") : (count > 5 ? h("div.end-of-feed", "Больше записей нет") : ""));
    } catch (e) {
      if (my !== gen) return;
      // ошибка: не повторяем сами в цикле — ждём нажатия «Повторить» или возвращения интернета
      errored = true;
      const retry = () => { errored = false; removeEventListener("online", retry); more(); };
      addEventListener("online", retry, { once: true });
      status.replaceChildren(h("div.empty.list-error", icon("x"), h("p", e.status === 0 ? "Нет соединения с интернетом" : e.message),
        h("button.btn.soft.sm", { type: "button", onclick: retry }, "Повторить")));
    } finally {
      if (my === gen) loading = false;
    }
    if (!done && !errored && my === gen) requestAnimationFrame(check);
  }
  function check() {
    if (!wrap.isConnected || done || loading) return;
    const r = sentinel.getBoundingClientRect();
    if (r.top < window.innerHeight + 800) more();
  }
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: "800px 0px" });
  io.observe(sentinel);
  function reload() {
    gen++; cursor = null; done = false; loading = false; count = 0; errored = false;
    clear(list); status.replaceChildren();
    more();
  }
  function prepend(node) {
    if (count === 0) status.replaceChildren();
    list.prepend(node);
    count++;
  }
  more();
  return { el: wrap, reload, prepend, list };
}

/** Кнопка в состоянии загрузки на время выполнения промиса */
export async function busy(btn, fn) {
  if (btn.disabled) return;
  const prev = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h("span.spinner.sm"), ...prev.filter((n) => n.nodeType === 3 || n.tagName !== "svg"));
  try { return await fn(); } finally { btn.disabled = false; btn.replaceChildren(...prev); }
}

// ---------------------------------------------------------------- Тема
export function applyTheme(theme) {
  try { localStorage.setItem("krug-theme", theme); } catch { /* приватный режим */ }
  let dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (theme === "system") { try { const tg = sessionStorage.getItem("krug:tgDark"); if (tg) dark = tg === "1"; } catch { /* нет */ } }
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  updateThemeColor();
}
// тема «как в системе» переключается вместе с телефоном/компьютером
try {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (currentTheme() === "system") applyTheme("system"); });
} catch { /* старые браузеры */ }

export function currentTheme() {
  try { return localStorage.getItem("krug-theme") || "dark"; } catch { return "dark"; }
}

let titled = false;
export function setTitle(t) {
  document.title = t ? `${t} — Yarko` : "Yarko — социальная сеть нового поколения";
  // переход между страницами без перезагрузки: программа экранного доступа сообщает, какая страница открылась (WCAG 4.1.3)
  if (!titled) { titled = true; return; }
  let live = document.getElementById("route-announcer");
  if (!live) {
    live = document.createElement("div");
    live.id = "route-announcer"; live.className = "sr-only";
    live.setAttribute("aria-live", "polite"); live.setAttribute("aria-atomic", "true");
    document.body.append(live);
  }
  live.textContent = "";
  setTimeout(() => { live.textContent = t || "Главная"; }, 60);
}
