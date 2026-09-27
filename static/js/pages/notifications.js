// Уведомления с обновлением в реальном времени.
import { api, on, setCounters } from "../api.js";
import { h, icon, avatar, timeAgo, plural } from "../dom.js";
import { infiniteList, setTitle } from "../ui.js";
import { setCleanup } from "../router.js";
import { notifText, notifLink, notifBadge } from "../components/notif.js";
import { friendButton } from "../components/people.js";

function row(n) {
  const pending = n.type === "friend_request" && (n.pending ?? !n.read);
  const others = n.others || [];
  const acts = pending ? h("div.n-acts", friendButton(n.actor, { status: "request_received" }, (rel) => {
    acts.replaceChildren(h("span.muted", { style: { fontSize: "13px" } }, rel.status === "friends" ? "Теперь вы друзья" : "Заявка отклонена"));
  }, { small: true })) : null;
  const el = h(`a.notif${n.read ? "" : ".unread"}`, { href: notifLink(n) },
    h(`span.n-icon${others.length ? ".stacked" : ""}`, n.type === "item" ? h(`span.avatar.item-notif.${n.extra?.rarity || "rare"}`, "🎁") : avatar(n.actor),
      others.length ? avatar(others[0], "sm", { presence: false }) : null, notifBadge(n)),
    h("div.grow",
      h("div.n-text", n.type === "item" ? null : h("b", n.actor.name),
        others.length ? h("span", others.length === 1 ? " и " : " и ещё ", others.length === 1 ? h("b", others[0].name) : `${others.length} ${plural(others.length, ["человек", "человека", "человек"])}`) : null,
        n.type === "item" ? null : " ", notifText(n, others.length > 0)),
      n.snippet ? h("div.n-snippet", `«${n.snippet}»`) : null,
      h("div.n-time", timeAgo(n.created_at)),
      acts));
  acts?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  return el;
}

export async function notificationsPage() {
  setTitle("Уведомления");
  const card = h("div.card", { style: { overflow: "hidden" } });
  const list = infiniteList({
    load: (cursor) => api.get("/api/notifications", { cursor }),
    render: row,
    empty: h("div.card.empty", icon("bell"), h("h3", "Уведомлений пока нет"), h("p", "Здесь появятся реакции, комментарии, упоминания и заявки в друзья.")),
    container: card,
    onLoaded: () => api.post("/api/notifications/read").then(() => setCounters({ notifications: 0 })).catch(() => {}),
  });
  setCleanup(on("notification", (n) => {
    list.prepend(row(n));
    api.post("/api/notifications/read").catch(() => {});
  }));
  return h("div.stack", h("div.page-head", h("h1", "Уведомления")), list.el);
}
