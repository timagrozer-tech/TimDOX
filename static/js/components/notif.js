// Текст и значок уведомления.
import { h, icon } from "../dom.js";
import { REACTION } from "./post.js";

export function notifText(n) {
  const r = n.extra?.reaction ? REACTION[n.extra.reaction] : null;
  switch (n.type) {
    case "reaction": return `отреагировал(а) ${r ? r.emoji : ""} на вашу запись`;
    case "comment": return "прокомментировал(а) вашу запись";
    case "reply": return "ответил(а) на ваш комментарий";
    case "mention": return n.comment_id ? "упомянул(а) вас в комментарии" : "упомянул(а) вас в записи";
    case "friend_request": return "хочет добавить вас в друзья";
    case "friend_accept": return "принял(а) вашу заявку в друзья";
    case "follow": return "подписался(-ась) на ваши обновления";
    case "repost": return "поделился(-ась) вашей записью";
    case "quote": return "процитировал(а) вашу запись";
    default: return "новое событие";
  }
}

export function notifLink(n) {
  if (n.post_id) return `/post/${n.post_id}${n.comment_id ? "?comments=1" : ""}`;
  if (n.type === "friend_request") return "/friends?tab=requests";
  return `/u/${n.actor.username}`;
}

export function notifBadge(n) {
  const r = n.extra?.reaction ? REACTION[n.extra.reaction] : null;
  if (n.type === "reaction" && r) return h("span.n-type.plain", r.emoji);
  const map = {
    comment: ["comment", ""], reply: ["comment", ""], mention: ["at", ""],
    friend_request: ["userPlus", "orange"], friend_accept: ["userCheck", "green"],
    follow: ["user", ""], repost: ["repeat", "green"], quote: ["quote", ""],
  };
  const [ic, color] = map[n.type] || ["bell", ""];
  return h(`span.n-type${color ? "." + color : ""}`, icon(ic));
}
