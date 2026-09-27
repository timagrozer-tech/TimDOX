// Общие элементы интерфейса: всплывающие сообщения, модальные окна, меню, просмотр фото, бесконечные списки.
import { updateThemeColor } from "./look.js";
import { h, icon, clear } from "./dom.js";
import { navigate } from "./router.js";

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

export function modal({ title, body, footer, narrow = false, sheet = true, onClose }) {
  const prevFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    openModals = openModals.filter((m) => m !== close);
    document.removeEventListener("keydown", onKey);
    if (!openModals.length) document.body.style.overflow = "";
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape" && openModals.at(-1) === close) close(); };
  const dialog = h(`div.modal${narrow ? ".narrow" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": title || "Окно" },
    title ? h("div.modal-head", h("h2", title),
      h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Закрыть", onclick: close }, icon("x"))) : null,
    h("div.modal-body", body),
    footer ? h("div.modal-foot", footer) : null);
  const backdrop = h(`div.modal-backdrop${sheet ? ".sheet" : ""}`, { onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  openModals.push(close);
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
export function showMenu(anchor, items) {
  closeMenu();
  const menu = h("div.menu", { role: "menu" },
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
  menu.querySelector("button")?.focus();
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(); };
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
  const onScroll = () => { if (Math.abs(window.scrollY - y0) > 40) closeMenu(); };
  window.addEventListener("scroll", onScroll, { passive: true });
  openMenu = () => {
    menu.remove();
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
  const show = () => {
    img.src = items[i].url;
    img.alt = items[i].alt || "Фото";
    count.textContent = items.length > 1 ? `${i + 1} из ${items.length}` : "";
    alt.textContent = items[i].alt || "";
  };
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  const go = (d) => { i = (i + d + items.length) % items.length; show(); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
  };
  const multi = items.length > 1;
  const box = h("div.lightbox", { role: "dialog", "aria-label": "Просмотр фото", onclick: (e) => { if (e.target === box) close(); } },
    img, count, alt,
    h("button.lb-btn.lb-close", { "aria-label": "Закрыть", onclick: close }, icon("x")),
    multi ? h("button.lb-btn.lb-prev", { "aria-label": "Предыдущее", onclick: () => go(-1) }, icon("back")) : null,
    multi ? h("button.lb-btn.lb-next", { "aria-label": "Следующее", onclick: () => go(1) }, icon("chevronRight")) : null);
  let sx = null;
  box.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", (e) => {
    if (sx == null || !multi) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    sx = null;
  });
  show();
  document.body.append(box);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  box.querySelector(".lb-close").focus();
}

// ---------------------------------------------------------------- Бесконечный список
/**
 * load(cursor) -> {items, next_cursor}; render(item) -> Node
 * Возвращает {el, reload, prepend}.
 */
export function infiniteList({ load, render, empty, container, onLoaded }) {
  const list = container || h("div");
  const sentinel = h("div.sentinel");
  const status = h("div");
  const wrap = h("div", list, status, sentinel);
  let cursor = null, done = false, loading = false, count = 0, gen = 0;

  async function more() {
    if (loading || done) return;
    loading = true;
    const my = gen;
    status.replaceChildren(h("div.spinner", { role: "status", "aria-label": "Загрузка" }));
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
      status.replaceChildren(h("div.empty", h("p", e.message), h("button.btn.soft.sm", { onclick: () => { loading = false; more(); } }, "Повторить")));
      done = false;
    } finally {
      if (my === gen) loading = false;
    }
    if (!done && my === gen) requestAnimationFrame(check);
  }
  function check() {
    if (!wrap.isConnected || done || loading) return;
    const r = sentinel.getBoundingClientRect();
    if (r.top < window.innerHeight + 800) more();
  }
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: "800px 0px" });
  io.observe(sentinel);
  function reload() {
    gen++; cursor = null; done = false; loading = false; count = 0;
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
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  updateThemeColor();
}
export function currentTheme() {
  try { return localStorage.getItem("krug-theme") || "system"; } catch { return "system"; }
}

export function setTitle(t) { document.title = t ? `${t} — Круг` : "Круг — социальная сеть"; }
