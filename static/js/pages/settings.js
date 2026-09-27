// Настройки: профиль, приватность, оформление, безопасность, данные.
import { api, state } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { setTitle, toast, toastError, busy, confirmDialog, modal, promptDialog, showMenu } from "../ui.js";
import { pickFriends } from "../components/people.js";
import { loadCircles } from "../components/composer.js";
import { appearanceSection } from "../components/appearance.js";
import { codeForm, verifyFlow } from "./feed.js";
import { installButton } from "../pwa.js";
import { refreshSidebarUser } from "../components/layout.js";
import { logout } from "../app-actions.js";

/** Выбор и загрузка аватара или обложки */
export function uploadProfileImage(kind, onDone) {
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
  document.body.append(input);
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast("Файл больше 10 МБ", { error: true });
    const fd = new FormData();
    fd.append("file", file);
    const t = toast("Загружаем…", { duration: 20000 });
    try {
      const res = await api.form(`/api/me/${kind}`, fd);
      t.remove();
      toast(kind === "avatar" ? "Фото профиля обновлено" : "Обложка обновлена", { icon: "check" });
      if (kind === "avatar") { state.me.avatar = res.avatar; refreshSidebarUser(); }
      onDone?.(res[kind]);
    } catch (e) { t.remove(); toastError(e); }
  });
  input.click();
}

function section(title, desc, ...content) {
  return h("section.card.settings-section", h("h2", title), desc ? h("p.desc", desc) : null, ...content);
}

function input(label, name, value, opts = {}) {
  const id = `s-${name}`;
  const el = opts.textarea
    ? h("textarea.textarea", { id, name, rows: 3, maxlength: opts.maxlength, value: value || "" })
    : h("input.input", { id, name, type: opts.type || "text", value: value || "", maxlength: opts.maxlength, placeholder: opts.placeholder || "" });
  const control = opts.prefix ? h("div.input-prefix", h("span", opts.prefix), el) : el;
  return h("div.field", { dataset: { field: name } }, h("label", { for: id }, label), control, h("div.field-error"));
}

function select(name, value, options, label) {
  return h("select.select", { name, "aria-label": label }, options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
}

/** Активные сеансы: где выполнен вход, завершить чужие */
function sessionsBox() {
  const box = h("div.stack.sessions", h("div.spinner"));
  const load = async () => {
    try {
      const { items } = await api.get("/api/me/sessions");
      const others = items.filter((s) => !s.current);
      box.replaceChildren(
        ...items.map((s) => h("div.setting-row.session-row",
          h("span.session-ic", icon(/iPhone|Android|iPad/.test(s.device) ? "smartphone" : "monitor")),
          h("div.label-block", h("b", s.device), h("small", s.current ? "Это устройство" : `Вход ${new Date(s.created_at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`)),
          s.current ? h("span.status-pill.online", "сейчас") : h("button.btn.ghost.sm", { type: "button", onclick: async () => {
            try { await api.del(`/api/me/sessions/${s.id}`); toast("Сеанс завершён", { icon: "check" }); load(); } catch (e) { toastError(e); }
          } }, "Завершить"))),
        others.length > 1 ? h("button.btn.outline", { type: "button", onclick: async () => {
          if (!await confirmDialog({ title: "Выйти на всех других устройствах?", text: "Останется только этот вход.", confirm: "Выйти везде" })) return;
          try { await api.del("/api/me/sessions"); toast("Готово — вход остался только здесь", { icon: "check" }); load(); } catch (e) { toastError(e); }
        } }, icon("logout", "sm"), "Выйти на всех других устройствах") : null);
    } catch (e) { box.replaceChildren(h("p.muted", e.message)); }
  };
  load();
  return box;
}

function settingRow(title, hint, control) {
  return h("div.setting-row", h("div.label-block", h("b", title), hint ? h("small", hint) : null), control);
}

export async function settingsPage({ query = {} } = {}) {
  setTitle("Настройки");
  const s = await api.get("/api/me/settings");

  // ---------------------------------------------------------------- Профиль
  // обложка и фото — одной компактной «шапкой», как на странице профиля
  const avatarBox = h("div.set-avatar");
  const coverBox = h("div.set-cover");
  const paintImages = () => {
    avatarBox.replaceChildren(avatar({ ...state.me, avatar: s.avatar }, "xl", { presence: false, frame: false }));
    coverBox.replaceChildren(s.cover ? h("img", { src: s.cover, alt: "" }) : "");
  };
  paintImages();
  const imageMenu = (kind) => (e) => {
    const upload = () => uploadProfileImage(kind, (url) => { s[kind] = url; paintImages(); });
    if (!s[kind]) return upload();
    showMenu(e.currentTarget, [
      { label: kind === "avatar" ? "Загрузить новое фото" : "Загрузить новую обложку", icon: "camera", onClick: upload },
      { label: "Удалить", icon: "trash", danger: true, onClick: async () => {
        try { await api.del(`/api/me/${kind}`); s[kind] = null; if (kind === "avatar") { state.me.avatar = null; refreshSidebarUser(); } paintImages(); } catch (err) { toastError(err); }
      } },
    ]);
  };
  const mediaHead = h("div.set-media",
    coverBox,
    h("button.set-cover-btn", { type: "button", onclick: imageMenu("cover") }, icon("camera", "sm"), "Обложка"),
    h("div.set-av-wrap", avatarBox,
      h("button.set-av-btn", { type: "button", "aria-label": "Изменить фото профиля", title: "Изменить фото профиля", onclick: imageMenu("avatar") }, icon("camera", "sm"))));

  const relOptions = ["", "Не женат / не замужем", "Встречаюсь", "Помолвлен(а)", "Женат / замужем", "В гражданском браке", "Всё сложно", "В активном поиске"];
  const profileForm = h("form.stack",
    mediaHead,
    h("div.grid-2",
      input("Имя и фамилия", "name", s.name, { maxlength: 60 }),
      input("Логин", "username", s.username, { maxlength: 30, prefix: "@" })),
    input("О себе", "bio", s.bio, { textarea: true, maxlength: 500 }),
    h("div.grid-2",
      input("Город", "city", s.city, { maxlength: 80, placeholder: "Например, Казань" }),
      h("div.field", h("label", { for: "s-birth" }, "Дата рождения"), h("input.input", { id: "s-birth", name: "birth_date", type: "date", value: s.birth_date || "", max: new Date().toISOString().slice(0, 10) }),
        h("label.check", h("input", { type: "checkbox", name: "show_birth_date", checked: s.show_birth_date }), "Показывать в профиле"))),
    h("details.set-more", (s.school || s.university || s.work || s.relationship) ? { open: true } : {},
      h("summary", icon("book", "sm"), "Учёба, работа, семейное положение", icon("down", "sm")),
      h("div.stack",
    h("div.grid-2",
      input("Школа", "school", s.school, { maxlength: 120, placeholder: "Например, «Лицей № 2»" }),
      input("Год окончания школы", "school_year", s.school_year ?? "", { type: "number", placeholder: "2012" })),
    h("div.grid-2",
      input("Вуз или колледж", "university", s.university, { maxlength: 120, placeholder: "Например, «КФУ»" }),
      input("Год окончания вуза", "university_year", s.university_year ?? "", { type: "number", placeholder: "2017" })),
    h("p.field-hint", { style: { marginTop: "-6px" } }, "По школе и году выпуска вас смогут найти одноклассники."),
    input("Работа", "work", s.work, { maxlength: 200, placeholder: "Компания и должность" }),
    h("div.field", h("label", { for: "s-rel" }, "Семейное положение"),
      h("select.select", { id: "s-rel", name: "relationship" }, relOptions.map((o) => h("option", { value: o, selected: o === s.relationship }, o || "Не указано")))))),
    h("div.set-save", h("button.btn.primary", { type: "submit" }, icon("check", "sm"), "Сохранить")));
  profileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = (n) => profileForm.querySelector(`[name="${n}"]`);
    const data = {};
    for (const n of ["name", "username", "bio", "city", "birth_date", "school", "school_year", "university", "university_year", "work", "relationship"]) data[n] = f(n).value;
    data.show_birth_date = f("show_birth_date").checked;
    busy(profileForm.querySelector("[type=submit]"), async () => {
      profileForm.querySelectorAll(".field-error").forEach((x) => { x.textContent = ""; });
      try {
        const res = await api.patch("/api/me/settings", data);
        Object.assign(s, res);
        state.me.name = res.name; state.me.username = res.username;
        refreshSidebarUser();
        toast("Профиль сохранён", { icon: "check" });
      } catch (err) {
        for (const [k, v] of Object.entries(err.fields || {})) {
          const fe = profileForm.querySelector(`[data-field="${k}"] .field-error`);
          if (fe) fe.textContent = v;
        }
        toastError(err);
      }
    });
  });

  // ---------------------------------------------------------------- Приватность
  const privacy = {
    profile_visibility: select("profile_visibility", s.profile_visibility, [["public", "Все"], ["friends", "Только друзья"]], "Кто видит профиль"),
    message_privacy: select("message_privacy", s.message_privacy, [["all", "Все"], ["friends", "Только друзья"]], "Кто может писать"),
    friends_visibility: select("friends_visibility", s.friends_visibility, [["public", "Все"], ["friends", "Только друзья"], ["only_me", "Только я"]], "Кто видит друзей"),
    default_visibility: select("default_visibility", s.default_visibility, [["public", "Все"], ["friends", "Друзья"], ["only_me", "Только я"]], "Видимость новых записей"),
  };
  for (const [k, el] of Object.entries(privacy)) {
    el.addEventListener("change", async () => {
      try {
        await api.patch("/api/me/settings", { [k]: el.value });
        if (k === "default_visibility") state.me.default_visibility = el.value;
        toast("Сохранено", { icon: "check", duration: 1800 });
      } catch (e) { toastError(e); }
    });
  }

  const invisible = h("input", { type: "checkbox", checked: s.invisible, "aria-label": "Режим невидимки" });
  invisible.addEventListener("change", async () => {
    try { await api.patch("/api/me/settings", { invisible: invisible.checked }); toast("Сохранено", { icon: "check", duration: 1800 }); } catch (e) { toastError(e); }
  });

  // ---------------------------------------------------------------- Круги
  const circlesBox = h("div.stack", h("div.spinner"));
  async function drawCircles(items) {
    if (!items) items = (await api.get("/api/circles")).items;
    loadCircles(true);
    circlesBox.replaceChildren(...items.map((c) => h("div.circle-row",
      h("div.grow", h("b", c.name), h("div.muted", { style: { fontSize: "13px" } }, c.members.length ? c.members.map((m) => m.name.split(" ")[0]).join(", ") : "Пока никого")),
      h("button.btn.soft.sm", { type: "button", onclick: async () => {
        const ids = await pickFriends({ title: `Круг «${c.name}»`, confirm: "Сохранить", selected: c.members.map((m) => m.id), min: 0 });
        if (ids) try { drawCircles((await api.patch(`/api/circles/${c.id}`, { user_ids: ids })).items); } catch (e) { toastError(e); }
      } }, "Состав"),
      h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Удалить круг ${c.name}`, onclick: async () => {
        if (!await confirmDialog({ title: `Удалить круг «${c.name}»?`, text: "Записи для этого круга станут видны только вам.", confirm: "Удалить", danger: true })) return;
        try { drawCircles((await api.del(`/api/circles/${c.id}`)).items); } catch (e) { toastError(e); }
      } }, icon("trash", "sm")))),
    h("button.btn.outline.sm", { type: "button", style: { alignSelf: "flex-start" }, onclick: async () => {
      const name = await promptDialog({ title: "Новый круг", label: "Например, «Семья» или «Коллеги»", confirm: "Создать" });
      if (name) try { drawCircles((await api.post("/api/circles", { name })).items); } catch (e) { toastError(e); }
    } }, icon("plus", "sm"), "Новый круг"));
  }
  drawCircles().catch((e) => circlesBox.replaceChildren(h("p.muted", e.message)));

  // ---------------------------------------------------------------- Безопасность
  const pwForm = h("form.stack",
    h("div.grid-2",
      h("div.field", h("label", { for: "pw-old" }, "Текущий пароль"), h("input.input", { id: "pw-old", type: "password", autocomplete: "current-password", required: true })),
      h("div.field", h("label", { for: "pw-new" }, "Новый пароль"), h("input.input", { id: "pw-new", type: "password", autocomplete: "new-password", required: true }))),
    h("div.row", h("button.btn.ghost.sm", {
      type: "button", onclick: async () => {
        try { await api.post("/api/auth/logout-all"); toast("Вы вышли на всех других устройствах", { icon: "check" }); } catch (e) { toastError(e); }
      },
    }, icon("logout", "sm"), "Выйти на других устройствах"), h("div.spacer"), h("button.btn.orange", { type: "submit" }, icon("lock", "sm"), "Сменить пароль")));
  pwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(pwForm.querySelector("[type=submit]"), async () => {
      try {
        await api.post("/api/auth/change-password", { old_password: pwForm.querySelector("#pw-old").value, new_password: pwForm.querySelector("#pw-new").value });
        pwForm.reset();
        toast("Пароль изменён. Другие сеансы завершены.", { icon: "check" });
      } catch (err) { toastError(err); }
    });
  });

  // ---------------------------------------------------------------- Почта
  const emailBox = h("div.email-box");
  function paintEmail() {
    const rows = [
      h("div.setting-row.email-row",
        h("div.label-block", h("b.email-addr", s.email),
          h(`small.email-state${s.email_verified ? ".ok" : ".warn"}`, s.email_verified ? "✓ Подтверждена" : "Не подтверждена")),
        h("button.btn.soft.sm", { type: "button", onclick: changeEmail }, icon("edit", "sm"), "Изменить")),
    ];
    if (!s.email_verified) {
      rows.push(h("div.code-block", s.mail_enabled
        ? verifyFlow({ onDone: () => { s.email_verified = true; paintEmail(); } })
        : h("small.muted", "Отправка писем пока не настроена на сервере — подтвердить почту можно будет позже.")));
    }
    if (s.pending_email) {
      rows.push(h("div.code-block",
        h("small.muted", `Код отправлен на ${s.pending_email}. Введите его, чтобы сменить адрес:`),
        codeForm({
          submit: (code) => api.post("/api/me/email/confirm", { code }),
          resend: null,
          onDone: async () => {
            const fresh = await api.get("/api/me/settings");
            Object.assign(s, fresh);
            state.me.email = s.email; state.me.email_verified = s.email_verified;
            toast("Адрес почты изменён", { icon: "check" });
            paintEmail();
          },
        }),
        h("button.btn.ghost.sm", { type: "button", onclick: async () => {
          await api.post("/api/me/email/confirm", { cancel: true }).catch(() => {});
          s.pending_email = null; paintEmail();
        } }, "Отменить смену")));
    }
    emailBox.replaceChildren(...rows);
  }
  function changeEmail() {
    const email = h("input.input", { type: "email", autocomplete: "email", placeholder: "new@mail.ru", required: true });
    const pw = h("input.input", { type: "password", autocomplete: "current-password", required: true });
    const errE = h("div.field-error"), errP = h("div.field-error");
    const go = h("button.btn.primary", { type: "button" }, s.mail_enabled ? "Получить код" : "Сменить почту");
    const m = modal({
      title: "Новая почта", narrow: true, sheet: false,
      body: h("div.stack",
        h("p.muted", { style: { margin: 0 } }, s.mail_enabled ? "Мы отправим код на новый адрес — так мы убедимся, что он ваш." : "Адрес сменится сразу."),
        h("div.field", h("label", "Новый адрес"), email, errE),
        h("div.field", h("label", "Текущий пароль"), pw, errP)),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), go],
    });
    setTimeout(() => email.focus(), 60);
    go.addEventListener("click", () => busy(go, async () => {
      errE.textContent = ""; errP.textContent = "";
      try {
        const res = await api.post("/api/me/email", { email: email.value, password: pw.value });
        m.close();
        if (res.changed) {
          s.email = res.email; s.email_verified = false; state.me.email = res.email; state.me.email_verified = false;
          toast("Адрес почты изменён", { icon: "check" });
        } else {
          s.pending_email = res.pending;
          toast(`Код отправлен на ${res.pending}`, { icon: "mail" });
        }
        paintEmail();
      } catch (err) {
        errE.textContent = err.fields?.email || ""; errP.textContent = err.fields?.password || "";
        if (!Object.keys(err.fields || {}).length) toastError(err);
      }
    }));
  }
  paintEmail();

  // ---------------------------------------------------------------- Данные
  const deleteBtn = h("button.btn.orange", { type: "button" }, icon("trash", "sm"), "Удалить аккаунт");
  deleteBtn.addEventListener("click", async () => {
    if (!await confirmDialog({ title: "Удалить аккаунт навсегда?", text: "Будут удалены профиль, записи, фото, комментарии, сообщения и друзья. Восстановить их будет невозможно.", confirm: "Продолжить", danger: true })) return;
    const pw = h("input.input", { type: "password", autocomplete: "current-password", placeholder: "Пароль" });
    const go = h("button.btn.danger", { type: "button" }, "Удалить навсегда");
    const m = modal({ title: "Подтвердите паролем", narrow: true, sheet: false, body: h("div.field", h("label", "Введите пароль"), pw), footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), go] });
    go.addEventListener("click", () => busy(go, async () => {
      try {
        await api.del("/api/me", { password: pw.value });
        m.close();
        toast("Аккаунт удалён. Нам будет вас не хватать!");
        state.me = null;
        logout();
      } catch (err) { toastError(err); }
    }));
  });

  // ---------------------------------------------------------------- Разделы вкладками — без длинной прокрутки
  const TABS = [
    ["profile", "Профиль", "user", () => [section("Профиль", null, profileForm)]],
    ["look", "Вид", "sun", () => [appearanceSection(s)]],
    ["privacy", "Доступ", "lock", () => [
      section("Приватность", null,
        settingRow("Кто видит профиль и записи", "Закрытый профиль видят только друзья", privacy.profile_visibility),
        settingRow("Кто может писать", null, privacy.message_privacy),
        settingRow("Кто видит друзей", null, privacy.friends_visibility),
        settingRow("Новые записи по умолчанию", "Можно изменить при публикации", privacy.default_visibility),
        settingRow("Режим невидимки", "Не показываться в «Гостях»", invisible)),
      section("Круги", "Списки друзей, для которых можно публиковать отдельно — например, только для близких.", circlesBox)]],
    ["security", "Защита", "shield", () => [
      section("Почта для входа", null, emailBox),
      section("Пароль", null, h("details.set-more", h("summary", icon("lock", "sm"), "Сменить пароль", icon("down", "sm")), pwForm)),
      section("Где выполнен вход", "Если видите незнакомое устройство — завершите сеанс и смените пароль.", sessionsBox())]],
    ["more", "Ещё", "more", () => [
      section("Мои данные", "Копия всех ваших данных или полное удаление аккаунта.",
        h("div.row", { style: { flexWrap: "wrap" } },
          h("a.btn.outline", { href: "/api/me/export", download: "krug-export.json" }, icon("download", "sm"), "Скачать мои данные"),
          h("div.spacer"), deleteBtn)),
      h("div.row", { style: { justifyContent: "center", paddingTop: "4px" } }, installButton("btn.soft")),
      h("div.row", { style: { justifyContent: "center", padding: "4px 0 12px" } },
        h("button.btn.ghost", { type: "button", onclick: logout }, icon("logout", "sm"), "Выйти из аккаунта"))]],
  ];
  let current = TABS.some(([id]) => id === query.tab) ? query.tab : "profile";
  const pane = h("div.stack.set-pane");
  const built = {};
  const tabBar = h("div.set-tabs", { role: "tablist", "aria-label": "Разделы настроек" });
  const draw = () => {
    const t = TABS.find(([id]) => id === current);
    built[current] ||= t[3]();
    pane.replaceChildren(...built[current]);
    tabBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === current)));
    history.replaceState(history.state, "", current === "profile" ? "/settings" : `/settings?tab=${current}`);
  };
  tabBar.append(...TABS.map(([id, label, ic]) => h("button", { type: "button", role: "tab", dataset: { tab: id },
    onclick: (e) => { current = id; draw(); e.currentTarget.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); } },
    icon(ic, "sm"), label)));
  draw();

  return h("div.stack.settings-page",
    h("div.page-head", h("h1", "Настройки")),
    tabBar,
    pane);
}
