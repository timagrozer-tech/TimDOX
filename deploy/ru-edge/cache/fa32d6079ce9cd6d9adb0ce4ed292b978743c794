// Переключатель аккаунтов: до 5 аккаунтов на устройстве, переход в один тап, у каждого свои уведомления.
import { api, state } from "../api.js";
import { h, icon, avatar, vmark } from "../dom.js";
import { modal, toastError, confirmDialog, toast } from "../ui.js";
import { switchAccount, logout } from "../app-actions.js";
import { navigate } from "../router.js";

export async function openAccounts() {
  const list = h("div.acc-list", h("div.spinner"));
  const m = modal({ title: "Аккаунты", narrow: true, body: list });
  try {
    const { items, max } = await api.get("/api/accounts");
    const rows = items.map((it) => {
      const row = h(`div.acc-row${it.active ? ".active" : ""}`,
        h("button.acc-main", { type: "button", disabled: it.active, onclick: async () => {
          row.classList.add("busy");
          try { await switchAccount(it.slot); } catch (e) { row.classList.remove("busy"); toastError(e); }
        } },
        avatar(it.user, "sm", { presence: false }),
        h("span.acc-name", h("b", it.user.name, vmark(it.user)), h("small", `@${it.user.username}`)),
        it.active ? h("span.acc-check", icon("check", "sm")) : it.unread ? h("span.badge.acc-unread", { dataset: { count: String(it.unread) } }, it.unread > 99 ? "99+" : String(it.unread)) : null),
        it.active ? null : h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Выйти из @${it.user.username}`, title: "Выйти из этого аккаунта", onclick: async () => {
          if (!await confirmDialog({ title: `Выйти из @${it.user.username}?`, text: "Аккаунт исчезнет из списка на этом устройстве.", confirm: "Выйти" })) return;
          try { await api.del(`/api/accounts/${it.slot}`); m.close(); toast("Готово", { icon: "check" }); openAccounts(); } catch (e) { toastError(e); }
        } }, icon("logout", "sm")));
      return row;
    });
    list.replaceChildren(...rows,
      items.length < max ? h("button.acc-add", { type: "button", onclick: () => { m.close(); navigate("/login?add=1"); } },
        h("span.acc-plus", icon("plus", "sm")), h("span", h("b", "Добавить аккаунт"), h("small", "Войти в ещё один, не выходя из этого"))) : h("p.muted", `Максимум ${max} аккаунтов на устройстве`),
      h("button.btn.ghost.block", { type: "button", onclick: () => { m.close(); logout(); } }, icon("logout", "sm"), `Выйти из @${state.me.username}`));
  } catch (e) { list.replaceChildren(h("p.muted", e.message)); }
}

/** Долгое нажатие (или правый клик) — открыть переключатель */
export function longPress(el, fn, ms = 450) {
  let t = 0, fired = false;
  el.addEventListener("pointerdown", () => { fired = false; t = setTimeout(() => { fired = true; try { navigator.vibrate?.(12); } catch { /* нет */ } fn(); }, ms); });
  ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((ev) => el.addEventListener(ev, (e) => { if (ev !== "pointermove" || Math.abs(e.movementY) > 6) clearTimeout(t); }));
  el.addEventListener("click", (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); } }, true);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); clearTimeout(t); fn(); });
}
