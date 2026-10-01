// Текст и значок уведомления.
import { h, icon } from "../dom.js";
import { REACTION } from "./post.js";

export function notifText(n, many = false) {
  const r = n.extra?.reaction ? REACTION[n.extra.reaction] : null;
  if (many) {
    switch (n.type) {
      case "reaction": return "отреагировали на вашу запись";
      case "reel_like": return "оценили ваш клип ❤️";
      case "follow": return "подписались на ваши обновления";
      case "event_going": return `пойдут на ваше мероприятие «${n.extra?.title || ""}»`;
      default: break;
    }
  }
  if (n.type === "item" && n.count > 1) return `Новые предметы в коллекции: «${n.extra?.name || ""}» и ещё ${n.count - 1} ✨`;
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
    case "community_request": return `хочет вступить в сообщество «${n.extra?.name || ""}»`;
    case "community_approved": return `одобрил(а) вашу заявку в сообщество «${n.extra?.name || ""}»`;
    case "event_invite": return `приглашает вас на мероприятие «${n.extra?.title || ""}»`;
    case "event_going": return `пойдёт на ваше мероприятие «${n.extra?.title || ""}»`;
    case "reel_like": return "оценил(а) ваш клип ❤️";
    case "reel_comment": return `прокомментировал(а) ваш клип: «${n.extra?.text || ""}»`;
    case "item": return `Новый предмет в коллекции: «${n.extra?.name || ""}» ✨`;
    case "invite_joined": return "присоединился(-ась) к Кругу по вашему приглашению 🎉";
    case "invite_qualified": return `стал(а) активным участником — приглашение засчитано (всего: ${n.extra?.count || 1})`;
    case "invite_tier": return `— благодаря этому приглашению у вас ${n.extra?.name || "новая галочка"}! 🏆`;
    default: return "новое событие";
  }
}

export function notifLink(n) {
  if (n.type.startsWith("reel_")) return `/reels/${n.extra?.reel_id}`;
  if (n.type === "item") return `/collection?slot=${n.extra?.slot || "frame"}`;
  if (n.type === "community_request") return `/c/${n.extra?.slug}?tab=members`;
  if (n.type === "community_approved") return `/c/${n.extra?.slug}`;
  if (n.type.startsWith("event_")) return `/events/${n.extra?.event_id}`;
  if (n.post_id) return `/post/${n.post_id}${n.comment_id ? "?comments=1" : ""}`;
  if (n.type === "friend_request") return "/friends?tab=requests";
  if (n.type === "invite_tier" || n.type === "invite_qualified") return "/invite";
  return `/u/${n.actor.username}`;
}

export function notifBadge(n) {
  const r = n.extra?.reaction ? REACTION[n.extra.reaction] : null;
  if (n.type === "reaction" && r) return h("span.n-type.plain", r.emoji);
  const map = {
    comment: ["comment", ""], reply: ["comment", ""], mention: ["at", ""],
    friend_request: ["userPlus", "orange"], friend_accept: ["userCheck", "green"],
    follow: ["user", ""], repost: ["repeat", "green"], quote: ["quote", ""],
    community_request: ["users", "orange"], community_approved: ["users", "green"],
    event_invite: ["calendar", "orange"], event_going: ["calendar", "green"], item: ["gift", "gold"], reel_like: ["heart", ""], reel_comment: ["comment", ""],
    invite_joined: ["userAdd", "green"], invite_qualified: ["check", "green"], invite_tier: ["trophy", "gold"],
  };
  const [ic, color] = map[n.type] || ["bell", ""];
  return h(`span.n-type${color ? "." + color : ""}`, icon(ic));
}
