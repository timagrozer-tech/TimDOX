// Вход, регистрация, восстановление пароля, подтверждение почты.
import { api, state } from "../api.js";
import { h, icon, logo, avatar, vmark } from "../dom.js";
import { busy, setTitle, toast } from "../ui.js";
import { navigate } from "../router.js";
import { afterLogin } from "../app-actions.js";

function orbitScene() {
  const planet = (pos, emoji, color) => h(`div.planet.${pos}`, { style: { "--pc": color } }, h("div.face", h("span", emoji)));
  const core = h("div.orbit-core", h("div.sun-glow"), h("div.sun"), h("div.sun-ring"), h("div.sun-logo", logo(false).firstChild));
  return h("div.orbit-scene",
    h("div.orbit-system",
      h("div.orbit.o1", planet("p-top", "💬", "color-mix(in srgb, var(--c3) 70%, transparent)"), planet("p-bottom", "❤️", "color-mix(in srgb, var(--c2) 70%, transparent)")),
      h("div.orbit.o2", planet("p-right", "📷", "color-mix(in srgb, var(--c4) 70%, transparent)"), planet("p-left", "🎉", "color-mix(in srgb, var(--c1) 70%, transparent)"), planet("p-tr", "🎵", "color-mix(in srgb, var(--c3) 70%, transparent)")),
      h("div.orbit.o3", planet("p-top", "🌍", "color-mix(in srgb, var(--c3) 70%, transparent)"), planet("p-bl", "✨", "color-mix(in srgb, var(--c2) 70%, transparent)"), planet("p-right", "🏔", "color-mix(in srgb, var(--c1) 70%, transparent)"))),
    core,
    h("div.floaters",
      h("div.floater.f1", "💬 ", h("b", "Борис:"), " уже выезжаю!"),
      h("div.floater.f2", "❤️ 128 реакций на фото"),
      h("div.floater.f3", "🎉 Встреча выпускников · 24 идут")));
}

function brand() {
  const item = (ic, text) => h("li", h("span.dot", icon(ic, "sm")), h("span", text));
  return h("section.auth-brand", { "aria-hidden": "true" },
    logo(),
    h("h2", "Живи ", h("span.grad-text", "ярко"), " — вместе со своими людьми"),
    h("p", "Друзья и семья, истории и фото, сообщества, встречи и мессенджер. Вы сами решаете, чем для вас будет Yarko."),
    orbitScene(),
    h("ul",
      item("lock", "Для каждой записи: все, друзья, круг или только вы"),
      item("compass", "Лента по времени — без скрытых алгоритмов")));
}

const $ = (form, name) => form.querySelector(`[name="${name}"]`);

function authLayout(...content) {
  return h("div.auth", brand(), h("div.auth-form-wrap", h("div.auth-mobile-hero", { "aria-hidden": "true" }, orbitScene()), h("div.card.auth-card", ...content)));
}

function field({ label, name, type = "text", autocomplete, placeholder, prefix, hint, required = true, maxlength }) {
  const id = `f-${name}`;
  const input = h("input.input", { id, name, type, autocomplete, placeholder, required, maxlength, "aria-describedby": `${id}-err` });
  let control = input;
  if (prefix) control = h("div.input-prefix", h("span", prefix), input);
  if (type === "password") {
    const toggle = h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Показать пароль" }, icon("eye", "sm"));
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
      toggle.replaceChildren(icon(show ? "eyeOff" : "eye", "sm"));
    });
    control = h("div.input-suffix", input, toggle);
  }
  return h("div.field", { dataset: { field: name } },
    h("label", { for: id }, label), control,
    hint ? h("div.field-hint", hint) : null,
    h("div.field-error", { id: `${id}-err`, role: "alert" }));
}

function showErrors(form, err) {
  form.querySelectorAll(".field-error").forEach((e) => { e.textContent = ""; });
  form.querySelectorAll(".invalid").forEach((e) => e.classList.remove("invalid"));
  const general = form.querySelector(".form-error");
  general.classList.add("hidden");
  const fields = err?.fields || {};
  let focused = false;
  for (const [name, msg] of Object.entries(fields)) {
    const f = form.querySelector(`[data-field="${name}"]`);
    if (!f) continue;
    f.querySelector(".field-error").textContent = msg;
    const input = f.querySelector("input");
    input?.classList.add("invalid");
    if (!focused) { input?.focus(); focused = true; }
  }
  if (err && !Object.keys(fields).length) {
    general.textContent = err.message;
    general.classList.remove("hidden");
  }
}

export async function loginPage({ query }) {
  const adding = !!query.add && !!state.me;
  setTitle(adding ? "Добавить аккаунт" : "Вход");
  const submit = h("button.btn.primary.lg.block", { type: "submit" }, "Войти");
  const form = h("form.auth-form", { novalidate: true },
    logo(),
    h("h1", adding ? "Ещё один аккаунт" : "С возвращением!"),
    h("p.sub", adding ? `Вы останетесь в @${state.me.username} — переключаться можно в один тап.` : "Войдите, чтобы увидеть новости друзей."),
    h("div.form-error.hidden", { role: "alert" }),
    field({ label: "E-mail или логин", name: "email", autocomplete: "username", placeholder: "you@example.com" }),
    field({ label: "Пароль", name: "password", type: "password", autocomplete: "current-password" }),
    h("div.row", h("div.spacer"), h("a", { href: "/forgot", style: { fontSize: "14px" } }, "Забыли пароль?")),
    submit,
    adding ? h("p.auth-switch", h("a", { href: "/" }, "Отмена — вернуться в Yarko"))
      : h("p.auth-switch", "Ещё нет аккаунта? ", h("a", { href: `/register${query.next ? "?next=" + encodeURIComponent(query.next) : ""}` }, "Зарегистрироваться")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      try {
        const r = await api.post("/api/auth/login", { email: $(form, "email").value, password: $(form, "password").value, add: adding || undefined });
        if (r?.mfa_required) { form.replaceWith(codeStep(r.ticket, query.next, adding)); return; }
        if (adding) { location.assign("/"); return; }
        await afterLogin(query.next);
      } catch (err) { showErrors(form, err); }
    });
  });
  setTimeout(() => $(form, "email").focus(), 50);
  return authLayout(form);
}

/** Второй шаг входа: код из приложения-аутентификатора или резервный код */
function codeStep(ticket, next, adding = false) {
  const submit = h("button.btn.primary.lg.block", { type: "submit" }, "Подтвердить");
  let backup = false;
  const input = () => $(form, "code");
  const switcher = h("button.btn.ghost.sm", { type: "button" }, "Нет доступа к приложению? Ввести резервный код");
  const form = h("form.auth-form", { novalidate: true },
    logo(),
    h("div.tfa-shield", { "aria-hidden": "true" }, icon("shield")),
    h("h1", "Код подтверждения"),
    h("p.sub.tfa-sub", "Откройте приложение-аутентификатор и введите 6 цифр для Yarko."),
    h("div.form-error.hidden", { role: "alert" }),
    h("div.field", { dataset: { field: "code" } },
      h("input.input.tfa-code", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "000000",
        "aria-label": "Код подтверждения", pattern: "[0-9]*" }),
      h("div.field-error", { role: "alert" })),
    submit, switcher,
    h("p.auth-switch", h("a", { href: "/login" }, "Войти в другой аккаунт")));
  switcher.addEventListener("click", () => {
    backup = !backup;
    const inp = input();
    inp.value = "";
    inp.maxLength = backup ? 9 : 6;
    inp.inputMode = backup ? "text" : "numeric";
    inp.placeholder = backup ? "XXXX-XXXX" : "000000";
    form.querySelector(".tfa-sub").textContent = backup ? "Введите один из резервных кодов, которые вы сохранили при включении защиты. Каждый код работает один раз." : "Откройте приложение-аутентификатор и введите 6 цифр для Yarko.";
    switcher.textContent = backup ? "Ввести код из приложения" : "Нет доступа к приложению? Ввести резервный код";
    inp.focus();
  });
  const go = () => busy(submit, async () => {
    try {
      await api.post("/api/auth/2fa", { ticket, code: input().value, add: adding || undefined });
      if (adding) { location.assign("/"); return; }
      await afterLogin(next);
    } catch (err) {
      if (err.code === "mfa_expired") { toast(err.message, { icon: "alert" }); navigate("/login", { replace: true }); return; }
      showErrors(form, err);
      input().select();
    }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); go(); });
  // шесть цифр введены — отправляем сразу, без нажатия кнопки
  form.addEventListener("input", () => { if (!backup && /^\d{6}$/.test(input().value)) go(); });
  setTimeout(() => input().focus(), 50);
  return form;
}

export async function registerPage({ query }) {
  setTitle("Регистрация");
  const submit = h("button.btn.accent.lg.block", { type: "submit" }, "Создать аккаунт");
  // два отдельных согласия: Соглашение и обработка персональных данных (согласие на ПДн — отдельный документ)
  const consent = h("div.stack.consents-reg",
    h("div.field", { dataset: { field: "terms" } },
      h("label.check", h("input", { type: "checkbox", name: "terms" }),
        h("span", "Принимаю ", h("a", { href: "/terms", target: "_blank" }, "Пользовательское соглашение"), " и ознакомлен(а) с ",
          h("a", { href: "/privacy", target: "_blank" }, "Политикой конфиденциальности"))),
      h("div.field-error", { role: "alert" })),
    h("div.field", { dataset: { field: "consent" } },
      h("label.check", h("input", { type: "checkbox", name: "consent" }),
        h("span", "Даю ", h("a", { href: "/consent", target: "_blank" }, "согласие на обработку персональных данных"))),
      h("div.field-error", { role: "alert" })));
  const form = h("form.auth-form", { novalidate: true },
    logo(),
    h("h1", "Регистрация"),
    h("p.sub", "Это бесплатно и займёт меньше минуты."),
    h("div.form-error.hidden", { role: "alert" }),
    field({ label: "Имя и фамилия", name: "name", autocomplete: "name", placeholder: "Анна Смирнова", maxlength: 60 }),
    field({ label: "Логин", name: "username", autocomplete: "username", placeholder: "anna_smirnova", prefix: "@", hint: "Латиница, цифры и _, от 3 до 30 символов", maxlength: 30 }),
    field({ label: "E-mail", name: "email", type: "email", autocomplete: "email", placeholder: "you@example.com" }),
    field({ label: "Пароль", name: "password", type: "password", autocomplete: "new-password", hint: "Не короче 8 символов, буквы и цифры" }),
    consent,
    // ловушка для ботов: поле невидимо для людей и скринридеров, его заполняют только скрипты
    h("div.hp-field", { "aria-hidden": "true" }, h("input", { name: "website", tabindex: -1, autocomplete: "off" })),
    submit,
    h("p.auth-switch", "Уже есть аккаунт? ", h("a", { href: "/login" }, "Войти")));
  const shownAt = performance.now();
  // пришли по приглашению: показываем, кто зовёт — так регистрация ощущается личной
  const ref = (query.ref || "").slice(0, 16);
  if (ref) {
    api.get(`/api/invites/code/${encodeURIComponent(ref)}`).then((d) => {
      form.querySelector("h1").after(h("div.iv-invited",
        avatar(d.inviter, "md"),
        h("div", h("b", d.inviter.name, vmark(d.inviter)), h("small", "приглашает вас в Yarko — после регистрации вы сразу будете на связи"))));
    }).catch(() => {});
  }

  // подсказка логина из имени
  const translit = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  let touched = false;
  $(form, "username").addEventListener("input", () => { touched = true; });
  $(form, "name").addEventListener("input", () => {
    if (touched) return;
    $(form, "username").value = $(form, "name").value.toLowerCase().split("").map((c) => translit[c] ?? c).join("")
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 30);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      try {
        await api.post("/api/auth/register", {
          name: $(form, "name").value, username: $(form, "username").value, email: $(form, "email").value,
          password: $(form, "password").value, consent: $(form, "consent").checked, terms: $(form, "terms").checked,
          website: $(form, "website").value, t: Math.round(performance.now() - shownAt), ref: ref || undefined,
        });
        toast("Аккаунт создан! Мы отправили письмо для подтверждения e-mail.", { icon: "mail", duration: 6000 });
        await afterLogin(query.next || "/welcome");
      } catch (err) { showErrors(form, err); }
    });
  });
  setTimeout(() => $(form, "name").focus(), 50);
  return authLayout(form);
}

export async function forgotPage() {
  setTitle("Восстановление пароля");
  const submit = h("button.btn.primary.lg.block", { type: "submit" }, "Отправить ссылку");
  const form = h("form.auth-form", { novalidate: true },
    logo(),
    h("h1", "Забыли пароль?"),
    h("p.sub", "Укажите e-mail — мы пришлём ссылку для сброса пароля."),
    h("div.form-error.hidden", { role: "alert" }),
    field({ label: "E-mail", name: "email", type: "email", autocomplete: "email" }),
    submit,
    h("p.auth-switch", h("a", { href: "/login" }, "Вернуться ко входу")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      try {
        await api.post("/api/auth/forgot", { email: $(form, "email").value });
        form.replaceChildren(logo(), h("h1", "Проверьте почту"),
          h("p.sub", "Если такой адрес зарегистрирован, письмо со ссылкой уже в пути. Ссылка действует 2 часа."),
          h("a.btn.primary.lg.block", { href: "/login" }, "Ко входу"));
      } catch (err) { showErrors(form, err); }
    });
  });
  return authLayout(form);
}

export async function resetPage({ query }) {
  setTitle("Новый пароль");
  const submit = h("button.btn.primary.lg.block", { type: "submit" }, "Сохранить пароль");
  const form = h("form.auth-form", { novalidate: true },
    logo(),
    h("h1", "Новый пароль"),
    h("p.sub", "Придумайте надёжный пароль: не короче 8 символов, буквы и цифры."),
    h("div.form-error.hidden", { role: "alert" }),
    field({ label: "Новый пароль", name: "password", type: "password", autocomplete: "new-password" }),
    submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      try {
        const r = await api.post("/api/auth/reset", { token: query.token || "", password: $(form, "password").value });
        toast("Пароль изменён", { icon: "check" });
        if (r?.need_login) { toast("Включена двухфакторная защита — войдите с новым паролем и кодом", { icon: "shield", duration: 6000 }); navigate("/login", { replace: true }); return; }
        await afterLogin("/");
      } catch (err) { showErrors(form, err); }
    });
  });
  return authLayout(form);
}

export async function verifyPage({ query }) {
  setTitle("Подтверждение e-mail");
  const box = h("div.auth-form", logo(), h("div.spinner"));
  try {
    await api.post("/api/auth/verify", { token: query.token || "" });
    if (state.me) state.me.email_verified = true;
    box.replaceChildren(logo(), h("h1", "E-mail подтверждён ✓"), h("p.sub", "Спасибо! Теперь вам доступны все возможности Yarko."),
      h("a.btn.primary.lg.block", { href: "/" }, "Перейти в ленту"));
  } catch (err) {
    box.replaceChildren(logo(), h("h1", "Ссылка не сработала"), h("p.sub", err.message),
      h("a.btn.primary.lg.block", { href: state.me ? "/settings" : "/login" }, state.me ? "Отправить письмо ещё раз" : "Ко входу"));
  }
  return authLayout(box);
}

export { navigate };
