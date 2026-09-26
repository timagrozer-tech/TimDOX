// Форма создания записи: текст, до 10 фото с описаниями, видимость, цитата.
import { api, state, emit } from "../api.js";
import { h, icon, avatar, autosize } from "../dom.js";
import { toast, toastError, busy, modal, promptDialog, showMenu } from "../ui.js";

const MAX_LEN = 5000;
const MAX_PHOTOS = 10;
export const VISIBILITY = {
  public: { label: "Все", icon: "globe", hint: "Запись видят все" },
  friends: { label: "Друзья", icon: "users", hint: "Только ваши друзья" },
  only_me: { label: "Только я", icon: "lock", hint: "Черновик для себя" },
};

export function visibilitySelect(value) {
  return audienceSelect(value, { withCircles: false });
}

let circlesCache = null;
export async function loadCircles(force = false) {
  if (!circlesCache || force) {
    try { circlesCache = (await api.get("/api/circles")).items; } catch { circlesCache = []; }
  }
  return circlesCache;
}

/** Выбор аудитории: красивая кнопка-«пилюля» с меню. value: "public" | "friends" | "only_me" | "circle:ID" */
export function audienceSelect(value, { withCircles = true } = {}) {
  let current = value;
  let circles = [];
  const btn = h("button.audience-btn", { type: "button", "aria-haspopup": "menu", "aria-label": "Кто видит запись" });
  const labelOf = (v) => {
    if (v.startsWith("circle:")) {
      const c = circles.find((x) => `circle:${x.id}` === v);
      return { label: c ? c.name : "Круг", icon: "target" };
    }
    return VISIBILITY[v] || VISIBILITY.public;
  };
  const paint = () => {
    const v = labelOf(current);
    btn.replaceChildren(icon(v.icon === "target" ? "users" : v.icon, "sm"), h("span", v.label), h("span.chev", "▾"));
    btn.dataset.value = current;
  };
  btn.addEventListener("click", () => {
    const pick = (v) => { current = v; paint(); };
    showMenu(btn, [
      ...Object.entries(VISIBILITY).map(([k, v]) => ({ label: v.label, hint: v.hint, icon: v.icon, checked: current === k, onClick: () => pick(k) })),
      ...(circles.length ? ["-", ...circles.map((c) => ({ label: `Круг «${c.name}»`, hint: `${c.members?.length || 0} чел.`, icon: "users", checked: current === `circle:${c.id}`, onClick: () => pick(`circle:${c.id}`) }))] : []),
    ]);
  });
  Object.defineProperty(btn, "value", { get: () => current, set: (v) => { current = v; paint(); } });
  if (withCircles) loadCircles().then((c) => { circles = c; paint(); });
  paint();
  return btn;
}

export function composer({ placeholder = "Что у вас нового?", quote = null, compact = false, onPosted, community = null } = {}) {
  const photos = []; // {file, url, alt}
  const ta = h("textarea", { placeholder, maxlength: MAX_LEN + 100, rows: 2, "aria-label": "Текст записи" });
  const fit = autosize(ta);
  const counter = h("span.counter");
  const previews = h("div.previews");
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: true, hidden: true });
  const vis = community ? null : audienceSelect(state.me?.default_visibility || "public");
  const canAsCommunity = community && ["admin", "moderator"].includes(community.role);
  const asCommunity = canAsCommunity ? h("input", { type: "checkbox", checked: true }) : null;
  const submit = h("button.btn.primary", { type: "submit" }, "Опубликовать");

  function refresh() {
    const len = ta.value.length;
    counter.textContent = len > MAX_LEN - 300 ? `${len} / ${MAX_LEN}` : "";
    counter.classList.toggle("over", len > MAX_LEN);
    submit.disabled = (!ta.value.trim() && !photos.length && !quote) || len > MAX_LEN;
    previews.replaceChildren(...photos.map((p, i) => h("div.preview",
      h("img", { src: p.url, alt: p.alt || `Фото ${i + 1}` }),
      h("button.remove", { type: "button", "aria-label": "Убрать фото", onclick: () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); refresh(); } }, icon("x", "sm")),
      h(`button.alt-btn${p.alt ? ".has-alt" : ""}`, {
        type: "button", title: "Описание для незрячих пользователей",
        onclick: async () => {
          const alt = await promptDialog({ title: "Описание фото", label: "Коротко опишите, что на фото — это поможет незрячим пользователям", confirm: "Сохранить" });
          if (alt != null) { p.alt = alt.slice(0, 300); refresh(); }
        },
      }, p.alt ? "ALT ✓" : "ALT"))));
  }

  fileInput.addEventListener("change", () => {
    for (const f of fileInput.files) {
      if (photos.length >= MAX_PHOTOS) { toast(`Можно прикрепить не больше ${MAX_PHOTOS} фото`, { error: true }); break; }
      if (f.size > 10 * 1024 * 1024) { toast(`«${f.name}» больше 10 МБ`, { error: true }); continue; }
      photos.push({ file: f, url: URL.createObjectURL(f), alt: "" });
    }
    fileInput.value = "";
    refresh();
  });
  ta.addEventListener("input", refresh);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });

  // вставка картинок из буфера обмена
  ta.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files.slice(0, MAX_PHOTOS - photos.length)) photos.push({ file: f, url: URL.createObjectURL(f), alt: "" });
      refresh();
    }
  });

  const form = h(`form.composer${compact ? ".compact" : ""}`, {
    onsubmit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const fd = new FormData();
      fd.append("text", ta.value);
      if (community) {
        fd.append("community_id", community.id);
        fd.append("as_community", asCommunity?.checked ? "1" : "0");
      } else if (vis.value.startsWith("circle:")) {
        fd.append("visibility", "friends");
        fd.append("circle_id", vis.value.slice(7));
      } else fd.append("visibility", vis.value);
      if (quote) fd.append("quote_of", quote.id);
      for (const p of photos) { fd.append("photos", p.file); fd.append("alts", p.alt || ""); }
      await busy(submit, async () => {
        try {
          const post = await api.form("/api/posts", fd);
          photos.forEach((p) => URL.revokeObjectURL(p.url));
          photos.length = 0;
          ta.value = "";
          fit();
          refresh();
          toast(quote ? "Цитата опубликована" : "Запись опубликована", { icon: "check" });
          emit("post-created", post);
          onPosted?.(post);
        } catch (err) { toastError(err); }
      });
    },
  },
  community && canAsCommunity ? h("span.avatar.comm-avatar", community.avatar ? h("img", { src: community.avatar, alt: "" }) : community.name[0]) : avatar(state.me, "", { presence: false }),
  h("div.body",
    ta,
    previews,
    quote ? quote.node : null,
    h("div.tools",
      h("button.btn.ghost.icon-only", { type: "button", title: "Добавить фото", "aria-label": "Добавить фото", onclick: () => fileInput.click() }, icon("image")),
      vis,
      canAsCommunity ? h("label.check", { style: { fontSize: "13px" } }, asCommunity, `От имени сообщества`) : null,
      h("div.spacer"),
      counter,
      submit),
    fileInput));
  refresh();
  form.focusInput = () => ta.focus();
  return form;
}

export function openComposerModal(opts = {}) {
  let m;
  const c = composer({ ...opts, onPosted: (p) => { m.close(); opts.onPosted?.(p); } });
  m = modal({ title: opts.quote ? "Цитировать запись" : "Новая запись", body: c });
  setTimeout(() => c.focusInput(), 50);
}
