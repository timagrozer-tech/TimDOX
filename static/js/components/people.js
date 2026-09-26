// Кнопки дружбы/подписки и строки со списками людей.
import { api, state } from "../api.js";
import { h, icon, avatar, pl } from "../dom.js";
import { toastError, toast, showMenu, confirmDialog } from "../ui.js";
import { navigate } from "../router.js";

export async function openChat(userId) {
  try {
    const conv = await api.post("/api/conversations", { user_id: userId });
    navigate(`/messages/${conv.id}`);
  } catch (e) { toastError(e); }
}

/** Кнопка статуса дружбы. relation.status: none | request_sent | request_received | friends */
export function friendButton(user, relation, onChange, { small = false } = {}) {
  const sz = small ? ".sm" : "";
  const act = async (fn, msg) => {
    try {
      const res = await fn();
      if (msg) toast(msg, { icon: "check" });
      onChange?.(res.relation);
    } catch (e) { toastError(e); }
  };
  const id = user.id;
  switch (relation.status) {
    case "friends": {
      const b = h(`button.btn.outline${sz}`, { type: "button", "aria-haspopup": "menu" }, icon("userCheck", "sm"), "У вас в друзьях");
      b.addEventListener("click", () => showMenu(b, [
        { label: "Удалить из друзей", icon: "userX", danger: true, onClick: async () => {
          if (await confirmDialog({ title: "Удалить из друзей?", text: `${user.name} больше не будет видеть записи «только для друзей».`, confirm: "Удалить", danger: true })) {
            act(() => api.del(`/api/people/${id}/friend`), "Удалён из друзей");
          }
        } },
      ]));
      return b;
    }
    case "request_sent":
      return h(`button.btn.outline${sz}`, { type: "button", onclick: () => act(() => api.del(`/api/people/${id}/friend`), "Заявка отменена") }, icon("x", "sm"), "Отменить заявку");
    case "request_received":
      return h("div.row", { style: { gap: "6px" } },
        h(`button.btn.primary${sz}`, { type: "button", onclick: () => act(() => api.post(`/api/people/${id}/friend/accept`), "Теперь вы друзья!") }, icon("userCheck", "sm"), "Принять"),
        h(`button.btn.outline${sz}`, { type: "button", onclick: () => act(() => api.del(`/api/people/${id}/friend`)) }, "Отклонить"));
    default:
      return h(`button.btn.primary${sz}`, { type: "button", onclick: () => act(() => api.post(`/api/people/${id}/friend`), "Заявка отправлена") }, icon("userPlus", "sm"), "Добавить в друзья");
  }
}

/** Строка человека в списке. actions(person, row) -> Node | null */
export function personRow(p, actions) {
  const sub = [p.city, p.mutual ? pl(p.mutual, ["общий друг", "общих друга", "общих друзей"]) : null].filter(Boolean).join(" · ") || `@${p.username}`;
  const row = h("div.person",
    h("a", { href: `/u/${p.username}`, "aria-label": p.name }, avatar(p, "lg")),
    h("div.who", h("a.name", { href: `/u/${p.username}` }, p.name), h("div.sub", sub)),
    h("div.acts"));
  const fill = () => row.querySelector(".acts").replaceChildren(...[actions ? actions(p, row, fill) : null].flat().filter(Boolean));
  fill();
  return row;
}

/** Действия по умолчанию: написать + добавить в друзья */
export function defaultPersonActions(p, row, refill) {
  if (p.is_me) return h("span.muted", "Это вы");
  const msg = h("button.btn.ghost.icon-only.sm", { type: "button", title: "Написать сообщение", "aria-label": `Написать ${p.name}`, onclick: () => openChat(p.id) }, icon("message", "sm"));
  if (p.is_friend) return msg;
  if (p._relation) return [msg, friendButton(p, p._relation, (rel) => { p._relation = rel; p.is_friend = rel.status === "friends"; refill(); }, { small: true })];
  return [msg, h("button.btn.soft.sm", {
    type: "button", onclick: async () => {
      try {
        const res = await api.post(`/api/people/${p.id}/friend`);
        p._relation = res.relation; p.is_friend = res.relation.status === "friends";
        toast(p.is_friend ? "Теперь вы друзья!" : "Заявка отправлена", { icon: "check" });
        refill();
      } catch (e) { toastError(e); }
    },
  }, icon("userPlus", "sm"), "Добавить")];
}

export function isMe(u) { return u && state.me && u.id === state.me.id; }
