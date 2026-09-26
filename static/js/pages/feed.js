// Лента: записи друзей, подписок и свои. Вкладка «Обзор» — все публичные записи.
import { api, state, on } from "../api.js";
import { h, icon } from "../dom.js";
import { infiniteList, setTitle, toast, toastError } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { composer } from "../components/composer.js";
import { postCard } from "../components/post.js";

export function verifyBanner() {
  if (!state.me || state.me.email_verified) return null;
  const resend = h("button.btn.sm.accent", { type: "button" }, "Отправить ещё раз");
  resend.addEventListener("click", async () => {
    try { await api.post("/api/auth/resend"); toast("Письмо отправлено", { icon: "mail" }); resend.disabled = true; } catch (e) { toastError(e); }
  });
  return h("div.banner", { role: "note" }, icon("mail"),
    h("div.grow", h("b", "Подтвердите e-mail. "), `Мы отправили письмо на ${state.me.email}.`,
      state.requireEmailConfirm ? " Без подтверждения нельзя публиковать записи и писать сообщения." : ""),
    resend);
}

export async function feedPage({ path, query }) {
  const explore = path === "/explore";
  setTitle(explore ? "Обзор" : "Лента");

  const tabs = h("div.card", h("div.tabs", { role: "tablist" },
    h("a", { href: "/", role: "tab", "aria-selected": String(!explore) }, icon("home", "sm"), "Друзья и подписки"),
    h("a", { href: "/explore", role: "tab", "aria-selected": String(explore) }, icon("compass", "sm"), "Обзор")),
  composer({ placeholder: `Что у вас нового, ${state.me.name.split(" ")[0]}?` }));

  const feedCard = h("div.card.feed");
  let emptyShown = false;
  const empty = () => {
    emptyShown = true;
    return h("div.card.empty", icon(explore ? "compass" : "users"),
      h("h3", explore ? "Здесь пока пусто" : "В вашей ленте пока пусто"),
      h("p", explore ? "Станьте первым, кто что-нибудь опубликует!" : "Добавьте друзей или подпишитесь на интересных людей — их записи появятся здесь."),
      explore ? null : h("div.row", { style: { flexWrap: "wrap", justifyContent: "center" } },
        h("a.btn.primary", { href: "/friends?tab=suggestions" }, icon("userPlus", "sm"), "Найти друзей"),
        h("a.btn.soft", { href: "/explore" }, icon("compass", "sm"), "Смотреть обзор")));
  };
  const list = infiniteList({
    load: (cursor) => api.get(explore ? "/api/explore" : "/api/feed", { cursor }),
    render: (p) => postCard(p),
    empty,
    container: feedCard,
  });

  setCleanup(on("post-created", (p) => {
    if (emptyShown) { emptyShown = false; list.reload(); return; }
    list.prepend(postCard(p));
  }));

  const welcome = query.welcome ? h("div.card.card-pad",
    h("h2", { style: { fontSize: "20px", marginBottom: "6px" } }, `Добро пожаловать в Круг, ${state.me.name.split(" ")[0]}! 👋`),
    h("p.text-2", "Заполните профиль, найдите друзей и опубликуйте первую запись."),
    h("div.row", { style: { marginTop: "12px", flexWrap: "wrap" } },
      h("a.btn.primary", { href: "/settings" }, icon("user", "sm"), "Заполнить профиль"),
      h("a.btn.soft", { href: "/friends?tab=suggestions" }, icon("userPlus", "sm"), "Найти друзей"),
      h("button.btn.ghost", { type: "button", onclick: (e) => { e.target.closest(".card").remove(); history.replaceState({}, "", "/"); } }, "Позже"))) : null;

  return h("div.stack", verifyBanner(), welcome, tabs, list.el);
}

export { navigate };
