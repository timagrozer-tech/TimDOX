// Онбординг 2.0: стиль на выбор (Modern / Fun / Future) → фото → люди → первая запись.
// Каждый шаг даёт пользу сразу: интерфейс перекрашивается на глазах, подписки наполняют ленту.
import { api, state } from "../api.js";
import { h, icon, avatar, vmark } from "../dom.js";
import { setTitle, toastError, applyTheme } from "../ui.js";
import { navigate } from "../router.js";
import { applyLook, PRESETS } from "../look.js";
import { uploadProfileImage } from "./settings.js";
import { blip, setTourProfile } from "../tour.js";
import { burst } from "../fx.js";

const STYLES = {
  modern: { name: "Modern", tagline: "Спокойно и чисто", text: "Светлое стекло, мягкие движения, ничего лишнего.", preset: "dawn", emoji: "🌤" },
  fun: { name: "Fun", tagline: "Ярко и весело", text: "Сочные цвета, упругие анимации и конфетти на достижениях.", preset: "sakura", emoji: "🎉" },
  future: { name: "Future", tagline: "Неон и космос", text: "Тёмная тема, светящиеся края, синтетические звуки.", preset: "neon", emoji: "🛸" },
};

function lookOf(key) {
  const p = PRESETS[STYLES[key].preset];
  return { look: { preset: STYLES[key].preset, palette: p.palette, bg: p.bg, font: p.font, shape: p.shape, dim: 35, blur: 0 }, mode: p.mode };
}

export async function welcomePage() {
  setTitle("Добро пожаловать");
  const ob = await api.get("/api/onboarding").catch(() => ({}));
  let style = ob.style || "modern";
  let step = 0;
  const root = h("div.ob");
  const stepsTotal = 4;

  const progress = () => h("div.ob-progress", { role: "progressbar", "aria-valuemin": 1, "aria-valuemax": stepsTotal, "aria-valuenow": step + 1 },
    Array.from({ length: stepsTotal }, (_, i) => h(`i${i <= step ? ".on" : ""}`)));
  const go = (n) => { step = n; blip("step"); paint(); };
  const nav = (primary, { skip = true, disabled = false } = {}) => h("div.ob-actions",
    skip ? h("button.btn.ghost", { type: "button", onclick: () => go(step + 1) }, "Пропустить") : h("span"),
    h("button.btn.primary.lg", { type: "button", disabled, onclick: () => go(step + 1) }, primary, icon("arrowRight", "sm")));

  const applyStyle = (key) => {
    style = key;
    document.documentElement.dataset.uiStyle = key;
    const { look, mode } = lookOf(key);
    applyLook(look);
    applyTheme(mode);
    state.me.appearance = look;
    state.me.theme = mode;
    api.patch("/api/me/settings", { appearance: look, theme: mode }).catch(() => {});
    api.post("/api/onboarding", { style: key }).catch(() => {});
  };

  function stepStyle() {
    const cards = Object.entries(STYLES).map(([key, s]) => {
      const card = h(`button.ob-style.s-${key}${style === key ? ".on" : ""}`, { type: "button", "aria-pressed": String(style === key) },
        h("span.ob-style-art", { "aria-hidden": "true" }, h("span.ob-orb"), h("span.ob-orb.b"), h("span.ob-emoji", s.emoji)),
        h("b", s.name), h("span.ob-tag", s.tagline), h("small", s.text));
      card.addEventListener("click", () => {
        applyStyle(key);
        root.querySelectorAll(".ob-style").forEach((c) => { c.classList.toggle("on", c === card); c.setAttribute("aria-pressed", String(c === card)); });
        blip("start");
        if (key === "fun") burst(card, ["🎉", "✨", "💜"], 12);
      });
      return card;
    });
    return [
      h("h1", `Привет, ${state.me.name.split(" ")[0]}! Каким будет ваш Круг?`),
      h("p.ob-sub", "Выберите характер интерфейса — он сразу изменится. Поменять можно в любой момент в настройках."),
      h("div.ob-styles", cards),
      nav("Дальше", { skip: false }),
    ];
  }

  function stepPhoto() {
    const av = h("div.ob-avatar", avatar(state.me, "xl", { presence: false }));
    const pick = h("button.btn.soft.lg", { type: "button" }, icon("camera", "sm"), state.me.avatar ? "Сменить фото" : "Загрузить фото");
    pick.addEventListener("click", () => uploadProfileImage("avatar", (url) => {
      state.me.avatar = url;
      av.replaceChildren(avatar(state.me, "xl", { presence: false }));
      av.classList.add("pop");
      blip("done");
      pick.replaceChildren(icon("check", "sm"), "Отлично!");
    }));
    return [
      h("h1", "Покажитесь друзьям"),
      h("p.ob-sub", "С фото вас проще узнать — и друзья охотнее добавляют в ответ."),
      av, h("div.ob-center", pick),
      nav("Дальше"),
    ];
  }

  function stepPeople() {
    const list = h("div.ob-people", h("div.spinner"));
    let followed = 0;
    const counter = h("span.ob-counter", "Подпишитесь хотя бы на троих — лента сразу оживёт");
    api.get("/api/friends/suggestions").then(({ items, featured }) => {
      const people = [...(featured || []), ...(items || [])].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i).slice(0, 12);
      if (!people.length) { list.replaceChildren(h("p.muted", "Пока некого предложить — пригласите друзей по ссылке после регистрации.")); return; }
      list.replaceChildren(...people.map((p) => {
        const b = h("button.btn.soft.sm", { type: "button", "aria-label": `Подписаться на ${p.name}` }, icon("plus", "sm"), h("span.ob-follow-label", "Подписаться"));
        b.addEventListener("click", async () => {
          try {
            await api.post(`/api/people/${p.id}/follow`);
            b.replaceWith(h("span.ob-done", icon("check", "sm"), "Вы подписаны"));
            followed++;
            blip("step");
            counter.textContent = followed >= 3 ? "Отлично! Лента уже наполняется 🎉" : `Ещё ${3 - followed} — и лента оживёт`;
          } catch (e) { toastError(e); }
        });
        return h("div.ob-person", avatar(p, "sm"), h("div", h("b", p.name, vmark(p)), h("small", p.mutual ? `общих друзей: ${p.mutual}` : p.city || `@${p.username}`)), b);
      }));
    }).catch(() => list.replaceChildren());
    return [h("h1", "Люди, которых вы можете знать"), h("p.ob-sub", counter), list, nav("Дальше")];
  }

  function stepPost() {
    const ideas = ["Привет, Круг! 👋", "Я здесь новенький(ая) — давайте знакомиться!", "Сегодня отличный день, чтобы начать 🌱"];
    const text = h("textarea.textarea.ob-text", { rows: 3, maxlength: 500, placeholder: "Расскажите о себе в паре слов" });
    const chips = h("div.ob-chips", ideas.map((t) => h("button.chip", { type: "button", onclick: () => { text.value = t; text.focus(); } }, t)));
    const publish = h("button.btn.primary.lg", { type: "button" }, icon("send", "sm"), "Опубликовать и начать");
    publish.addEventListener("click", async () => {
      const t = text.value.trim();
      publish.disabled = true;
      try {
        if (t) {
          const fd = new FormData();
          fd.append("text", t);
          fd.append("visibility", "public");
          await api.form("/api/posts", fd);
        }
        await finish();
      } catch (e) { publish.disabled = false; toastError(e); }
    });
    return [
      h("h1", "Первая запись"),
      h("p.ob-sub", "Короткое «привет» — и друзья увидят, что вы уже здесь."),
      chips, text,
      h("div.ob-actions", h("button.btn.ghost", { type: "button", onclick: () => finish() }, "Позже"), publish),
    ];
  }

  async function finish() {
    const p = await api.post("/api/onboarding", { done: true, style }).catch(() => null);
    if (p) setTourProfile(p);
    blip("done");
    burst(root.querySelector("h1") || root, ["🎉", "✨", "💜", "⭐"], 18);
    setTimeout(() => navigate("/", { replace: true }), 500);
  }

  function paint() {
    const content = [stepStyle, stepPhoto, stepPeople, stepPost][step]();
    root.replaceChildren(h("div.ob-card.card", progress(), h("div.ob-body", ...content)));
    root.querySelector(".ob-body").animate?.([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.9,.3,1.1)" });
  }
  document.documentElement.dataset.uiStyle = style;
  paint();
  return root;
}
