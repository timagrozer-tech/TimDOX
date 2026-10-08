// Подсказки при наборе: «@» — люди, «#» — хэштеги. Работает в редакторе записи, комментариях и чате.
import { api } from "../api.js";
import { h, avatar, vmark, pl } from "../dom.js";

const TOKEN = /(^|[\s(«"])([@#])([\p{L}\p{N}_]{1,30})$/u;

export function attachMentions(ta) {
  const pop = h("div.mention-pop", { role: "listbox", hidden: true });
  let items = [], active = 0, token = null, timer = null, gen = 0;

  // окошко подсказок есть в документе только пока показано
  const hide = () => { pop.hidden = true; pop.remove(); items = []; token = null; };
  const place = () => {
    const r = ta.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240 || r.top < 240;
    Object.assign(pop.style, { left: `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`, width: `${Math.min(320, window.innerWidth - 16)}px`,
      top: below ? `${r.bottom + 6}px` : "", bottom: below ? "" : `${window.innerHeight - r.top + 6}px` });
  };
  const paint = () => {
    pop.replaceChildren(...items.map((it, i) => h(`button.mention-item${i === active ? ".on" : ""}`, {
      type: "button", role: "option", "aria-selected": String(i === active),
      onmousedown: (e) => { e.preventDefault(); choose(i); },
    }, ...(it.kind === "@" ? [avatar(it, "sm", { presence: false }), h("span.mi-who", h("b", it.name, vmark(it)), h("small", `@${it.username}`))]
      : [h("span.mi-hash", "#"), h("span.mi-who", h("b", it.tag), h("small", pl(it.n, ["запись", "записи", "записей"])))]))));
    pop.hidden = !items.length;
    if (items.length && ta.isConnected) { if (!pop.isConnected) document.body.append(pop); place(); } else pop.remove();
  };
  function choose(i) {
    const it = items[i];
    if (!it || !token) return;
    const insert = it.kind === "@" ? `@${it.username} ` : `#${it.tag} `;
    const pos = ta.selectionStart;
    ta.value = ta.value.slice(0, token.start) + insert + ta.value.slice(pos);
    const caret = token.start + insert.length;
    ta.setSelectionRange(caret, caret);
    hide();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }
  async function lookup() {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(TOKEN);
    if (!m) return hide();
    token = { kind: m[2], word: m[3], start: pos - m[3].length - 1 };
    const my = ++gen;
    try {
      const res = await api.get("/api/search", { q: m[3], type: m[2] === "@" ? "people" : "tags" });
      if (my !== gen) return;
      items = m[2] === "@" ? (res.people || []).filter((p) => !p.is_me).slice(0, 6).map((p) => ({ ...p, kind: "@" }))
        : (res.tags || []).slice(0, 6).map((t) => ({ ...t, kind: "#" }));
      active = 0;
      paint();
    } catch { hide(); }
  }
  ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(lookup, 150); });
  ta.addEventListener("keydown", (e) => {
    if (pop.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault(); e.stopImmediatePropagation();
      choose(active);
    } else if (e.key === "Escape") { e.stopPropagation(); hide(); }
  }, true);
  ta.addEventListener("blur", () => setTimeout(hide, 120));
  return ta;
}
