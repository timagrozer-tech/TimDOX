// Форма создания записи: текст, до 10 фото с описаниями, видимость, цитата.
import { api, state, emit } from "../api.js";
import { h, icon, avatar, autosize } from "../dom.js";
import { toast, toastError, busy, modal, promptDialog } from "../ui.js";

const MAX_LEN = 5000;
const MAX_PHOTOS = 10;
export const VISIBILITY = {
  public: { label: "Все", icon: "globe", hint: "Видно всем" },
  friends: { label: "Друзья", icon: "users", hint: "Только друзьям" },
  only_me: { label: "Только я", icon: "lock", hint: "Только вам" },
};

export function visibilitySelect(value) {
  return h("select.vis-select", { "aria-label": "Кто видит запись" },
    Object.entries(VISIBILITY).map(([k, v]) => h("option", { value: k, selected: k === value }, `${v.label}`)));
}

export function composer({ placeholder = "Что у вас нового?", quote = null, compact = false, onPosted } = {}) {
  const photos = []; // {file, url, alt}
  const ta = h("textarea", { placeholder, maxlength: MAX_LEN + 100, rows: 2, "aria-label": "Текст записи" });
  const fit = autosize(ta);
  const counter = h("span.counter");
  const previews = h("div.previews");
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: true, hidden: true });
  const vis = visibilitySelect(state.me?.default_visibility || "public");
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
      fd.append("visibility", vis.value);
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
  avatar(state.me, "", { presence: false }),
  h("div.body",
    ta,
    previews,
    quote ? quote.node : null,
    h("div.tools",
      h("button.btn.ghost.icon-only", { type: "button", title: "Добавить фото", "aria-label": "Добавить фото", onclick: () => fileInput.click() }, icon("image")),
      vis,
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
