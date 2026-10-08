// Лента: записи друзей, подписок и свои. Вкладка «Обзор» — все публичные записи.
import { pushInvite } from "../push.js";
import { api, state, on } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { infiniteList, setTitle, toast, toastError } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { composer, openComposerModal } from "../components/composer.js";
import { postCard } from "../components/post.js";
import { storiesBar } from "../components/stories.js";
import { featuredStrip } from "../components/people.js";

export function verifyBanner() {
  if (!state.me || state.me.email_verified || !state.mailEnabled) return null;
  return h("div.banner.verify-banner", { role: "note" }, icon("mail"),
    h("div.grow", h("b", "Подтвердите почту. "),
      state.requireEmailConfirm ? "Без подтверждения нельзя публиковать записи и писать сообщения." : "Так вы сможете восстановить пароль, если забудете его."),
    verifyFlow({ onDone: (el) => el.closest(".banner")?.remove() }));
}

/** Подтверждение почты в два шага: кнопка «Подтвердить почту» → письмо с кодом → поле для кода */
export function verifyFlow({ onDone } = {}) {
  const box = h("div.verify-flow");
  const start = h("button.btn.primary.sm", { type: "button" }, icon("mail", "sm"), "Подтвердить почту");
  start.addEventListener("click", async () => {
    start.disabled = true;
    try {
      await api.post("/api/auth/resend");
      toast(`Код отправлен на ${state.me.email}`, { icon: "mail" });
      box.replaceChildren(
        h("small.verify-hint", `Код из письма на ${state.me.email}:`),
        codeForm({
          submit: (code) => api.post("/api/auth/verify-code", { code }),
          resend: () => api.post("/api/auth/resend"),
          onDone: () => { state.me.email_verified = true; toast("Почта подтверждена 🎉", { icon: "check" }); onDone?.(box); },
        }));
      box.querySelector("input")?.focus();
    } catch (e) { start.disabled = false; toastError(e); }
  });
  box.append(start);
  return box;
}

/** Поле для шестизначного кода из письма + «Отправить ещё раз» */
export function codeForm({ submit, resend, onDone }) {
  const input = h("input.code-input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, placeholder: "000000", "aria-label": "Код из письма" });
  const ok = h("button.btn.sm.primary", { type: "submit" }, "Подтвердить");
  const again = h("button.btn.sm.ghost", { type: "button" }, "Отправить ещё раз");
  const form = h("form.code-form", input, ok, resend ? again : null);
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value.length === 6) form.requestSubmit();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (input.value.length !== 6) { input.focus(); return; }
    ok.disabled = true;
    try { await submit(input.value); onDone(form); } catch (err) { toastError(err); input.select(); } finally { ok.disabled = false; }
  });
  again.addEventListener("click", async () => {
    again.disabled = true;
    try { await resend(); toast("Новый код отправлен", { icon: "mail" }); } catch (err) { toastError(err); }
    setTimeout(() => { again.disabled = false; }, 30000);
  });
  return form;
}

export async function feedPage({ path, query }) {
  const explore = path === "/explore";
  setTitle(explore ? "Обзор" : "Лента");

  const tabs = h("div.card", h("div.tabs", { role: "tablist" },
    h("a", { href: "/explore", role: "tab", "aria-selected": String(explore) }, icon("compass", "sm"), "Обзор"),
    h("a", { href: "/", role: "tab", "aria-selected": String(!explore) }, icon("home", "sm"), "Друзья и подписки")),
  matchMedia("(max-width: 719px)").matches
    ? h("button.quick-compose", { type: "button", onclick: () => openComposerModal() },
      avatar(state.me, "", { presence: false }), h("span.grow", `Что у вас нового, ${state.me.name.split(" ")[0]}?`), h("span.qc-icon", icon("image")))
    : composer({ placeholder: `Что у вас нового, ${state.me.name.split(" ")[0]}?` }));

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
    h("h2", { style: { fontSize: "20px", marginBottom: "6px" } }, `Добро пожаловать в QEVI, ${state.me.name.split(" ")[0]}! 👋`),
    h("p.text-2", "Заполните профиль, найдите друзей и опубликуйте первую запись."),
    h("div.row", { style: { marginTop: "12px", flexWrap: "wrap" } },
      h("a.btn.primary", { href: "/settings" }, icon("user", "sm"), "Заполнить профиль"),
      h("a.btn.soft", { href: "/friends?tab=suggestions" }, icon("userPlus", "sm"), "Найти друзей"),
      h("button.btn.ghost", { type: "button", onclick: (e) => { e.target.closest(".card").remove(); history.replaceState({}, "", "/"); } }, "Позже"))) : null;

  return h("div.stack", verifyBanner(), welcome, welcome ? null : pushInvite(), storiesBar(), featuredStrip({ closable: true }), tabs, list.el);
}

export { navigate };
