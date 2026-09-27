// Истории на 24 часа: лента кружков, просмотр на весь экран, создание.
import { api, state } from "../api.js";
import { h, icon, avatar, timeAgo, pl } from "../dom.js";
import { modal, toast, toastError, busy, confirmDialog } from "../ui.js";
import { navigate } from "../router.js";

export const BACKGROUNDS = {
  blue: "linear-gradient(135deg, #1f3fae, #4f7bff)",
  orange: "linear-gradient(135deg, #f5761a, #ffb347)",
  green: "linear-gradient(135deg, #0f7a4a, #3ddc84)",
  purple: "linear-gradient(135deg, #5b21b6, #c084fc)",
  pink: "linear-gradient(135deg, #be185d, #fb7185)",
  dark: "linear-gradient(135deg, #0b101b, #2a3550)",
};
const DURATION = 5000;

/** Полоса историй над лентой */
export function storiesBar() {
  const strip = h("div.stories-strip", { role: "list", "aria-label": "Истории" });
  const card = h("section.card.stories-card", strip);
  card._reload = () => load();
  let groups = [];

  async function load() {
    try {
      groups = (await api.get("/api/stories")).groups;
    } catch { groups = []; }
    draw();
  }
  function draw() {
    const mine = groups.find((g) => g.is_me);
    const items = [h("div.story-item", { role: "listitem" },
      h("button.story-ring.add", { type: "button", "aria-label": "Добавить историю", onclick: () => createStory(load) },
        avatar(state.me, "lg", { presence: false }), h("span.story-plus", icon("plus", "sm"))),
      h("span.story-name", "Добавить"))];
    if (mine) {
      items[0] = h("div.story-item", { role: "listitem" },
        h("button.story-ring.seen", { type: "button", "aria-label": "Мои истории", onclick: () => openViewer(groups, groups.indexOf(mine), load) },
          avatar(state.me, "lg", { presence: false })),
        h("span.story-name", "Вы"),
        h("button.story-add-mini", { type: "button", "aria-label": "Добавить ещё историю", onclick: () => createStory(load) }, icon("plus", "sm")));
    }
    groups.filter((g) => !g.is_me).forEach((g) => {
      items.push(h("div.story-item", { role: "listitem" },
        h(`button.story-ring${g.has_unseen ? "" : ".seen"}`, { type: "button", "aria-label": `Истории: ${g.user.name}`, onclick: () => openViewer(groups, groups.indexOf(g), load) },
          avatar(g.user, "lg", { presence: false })),
        h("span.story-name", g.user.name.split(" ")[0])));
    });
    strip.replaceChildren(...items);
  }
  load();
  return card;
}

/** Просмотр историй: прогресс-бары, автоматическое листание, ответ в личку */
export function openViewer(groups, gi, onChange) {
  let g = gi, s = 0, timer = null, started = 0, elapsed = 0, paused = false;
  const first = groups[g].stories.findIndex((x) => !x.seen);
  if (first > 0 && !groups[g].is_me) s = first;

  const bars = h("div.sv-bars");
  const head = h("div.sv-head");
  const stage = h("div.sv-stage");
  const foot = h("div.sv-foot");
  const box = h("div.story-viewer", { role: "dialog", "aria-label": "Просмотр историй" },
    h("div.sv-frame", bars, head, stage, foot,
      h("button.sv-nav.prev", { type: "button", "aria-label": "Предыдущая", onclick: () => go(-1) }),
      h("button.sv-nav.next", { type: "button", "aria-label": "Следующая", onclick: () => go(1) })),
    h("button.lb-btn.lb-close", { type: "button", "aria-label": "Закрыть", onclick: close }, icon("x")));

  function current() { return groups[g].stories[s]; }
  function render() {
    const grp = groups[g], st = current();
    bars.replaceChildren(...grp.stories.map((_, i) => h("span.sv-bar", h("i", { style: { width: i < s ? "100%" : "0%" } }))));
    head.replaceChildren(
      h("a", { href: grp.is_me ? `/u/${state.me.username}` : `/u/${grp.user.username}`, onclick: close }, avatar(grp.user, "sm", { presence: false })),
      h("div.grow", h("b", grp.is_me ? "Вы" : grp.user.name), h("small", timeAgo(st.created_at))),
      grp.is_me ? h("button.btn.ghost.icon-only.sm.sv-light", { type: "button", "aria-label": "Удалить историю", onclick: remove }, icon("trash", "sm")) : null);
    const bg = BACKGROUNDS[st.background] || BACKGROUNDS.blue;
    stage.style.background = st.media ? "#000" : bg;
    stage.replaceChildren(
      st.media ? h("img", { src: st.media, alt: st.text || "История" }) : null,
      st.text ? h(`div.sv-text${st.media ? ".caption" : ""}`, st.text) : null);
    if (grp.is_me) {
      const btn = h("button.btn.sm.sv-viewers", { type: "button" }, icon("eye", "sm"), "Просмотры");
      btn.addEventListener("click", () => showViewers(st));
      foot.replaceChildren(btn);
    } else {
      const input = h("input.input", { placeholder: `Ответить ${grp.user.name.split(" ")[0]}…`, maxlength: 1000, "aria-label": "Ответ на историю" });
      input.addEventListener("focus", pause);
      input.addEventListener("blur", resume);
      const form = h("form.sv-reply", {
        onsubmit: async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          try {
            await api.post(`/api/stories/${st.id}/reply`, { text });
            input.value = "";
            toast("Ответ отправлен в личные сообщения", { icon: "send" });
            input.blur();
          } catch (err) { toastError(err); }
        },
      }, input, h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить" }, icon("send", "sm")));
      foot.replaceChildren(form);
      if (!st.seen) {
        st.seen = true;
        api.post(`/api/stories/${st.id}/view`).catch(() => {});
      }
    }
    start();
  }
  function start() {
    clearTimeout(timer);
    elapsed = 0; started = Date.now(); paused = false;
    animate();
    timer = setTimeout(() => go(1), DURATION);
  }
  function animate() {
    const bar = bars.children[s]?.firstChild;
    if (!bar) return;
    bar.style.transition = "none";
    bar.style.width = `${(elapsed / DURATION) * 100}%`;
    requestAnimationFrame(() => {
      bar.style.transition = `width ${DURATION - elapsed}ms linear`;
      bar.style.width = "100%";
    });
  }
  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    elapsed += Date.now() - started;
    const bar = bars.children[s]?.firstChild;
    if (bar) { bar.style.transition = "none"; bar.style.width = `${(elapsed / DURATION) * 100}%`; }
  }
  function resume() {
    if (!paused) return;
    paused = false;
    started = Date.now();
    animate();
    timer = setTimeout(() => go(1), DURATION - elapsed);
  }
  function go(d) {
    s += d;
    if (s >= groups[g].stories.length) { groups[g].has_unseen = false; g++; s = 0; }
    else if (s < 0) { g--; s = g >= 0 ? groups[g].stories.length - 1 : 0; }
    if (g < 0 || g >= groups.length) return close();
    render();
  }
  async function remove() {
    pause();
    if (!await confirmDialog({ title: "Удалить историю?", text: "Её больше никто не увидит.", confirm: "Удалить", danger: true })) return resume();
    try {
      await api.del(`/api/stories/${current().id}`);
      groups[g].stories.splice(s, 1);
      if (!groups[g].stories.length) { groups.splice(g, 1); return close(); }
      s = Math.min(s, groups[g].stories.length - 1);
      render();
    } catch (e) { toastError(e); resume(); }
  }
  async function showViewers(st) {
    pause();
    const body = h("div.mini-people", h("div.spinner"));
    modal({ title: "Просмотры", body, narrow: true, onClose: resume });
    try {
      const { items, total } = await api.get(`/api/stories/${st.id}/viewers`);
      body.replaceChildren(...(items.length ? [h("p.muted", pl(total, ["просмотр", "просмотра", "просмотров"])),
        ...items.map((u) => h("a.mini-person", { href: `/u/${u.username}`, onclick: close }, avatar(u, "sm"),
          h("div.who", h("span.name", u.name), h("span.sub", timeAgo(u.viewed_at)))))] : [h("p.muted", "Пока никто не посмотрел")]));
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
  }
  const onKey = (e) => {
    if (document.activeElement?.tagName === "INPUT") return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === " ") { e.preventDefault(); paused ? resume() : pause(); }
  };
  function close() {
    clearTimeout(timer);
    box.remove();
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    onChange?.();
  }
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  document.body.style.overflow = "hidden";
  render();
}

/** Создание истории: фото или текст на цветном фоне */
export function createStory(onDone) {
  let file = null, bg = "blue", url = null;
  const preview = h("div.story-preview");
  const ta = h("textarea.story-text-input", { placeholder: "Напишите что-нибудь…", maxlength: 300, rows: 3, "aria-label": "Текст истории" });
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
  const swatches = h("div.swatches", { role: "radiogroup", "aria-label": "Фон" });
  const vis = h("select.select", { "aria-label": "Кто видит историю" },
    h("option", { value: "friends" }, "Друзья"), h("option", { value: "public" }, "Все"));
  const paint = () => {
    preview.style.background = file ? "#000" : BACKGROUNDS[bg];
    preview.replaceChildren(file ? h("img", { src: url, alt: "" }) : null, ta);
    ta.classList.toggle("caption", !!file);
    swatches.replaceChildren(...Object.entries(BACKGROUNDS).map(([k, v]) => h("button.swatch", {
      type: "button", role: "radio", "aria-checked": String(k === bg && !file), "aria-label": `Фон ${k}`,
      style: { background: v }, onclick: () => { bg = k; if (file) { URL.revokeObjectURL(url); file = null; } paint(); },
    })));
  };
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast("Файл больше 10 МБ", { error: true });
    if (url) URL.revokeObjectURL(url);
    file = f; url = URL.createObjectURL(f);
    paint();
  });
  const publish = h("button.btn.accent", { type: "button" }, "Опубликовать историю");
  const m = modal({
    title: "Новая история",
    body: h("div.stack", preview,
      h("div.row", { style: { flexWrap: "wrap" } },
        h("button.btn.soft.sm", { type: "button", onclick: () => fileInput.click() }, icon("image", "sm"), "Фото"),
        swatches, h("div.spacer"), vis),
      h("p.muted", { style: { fontSize: "13px" } }, "История исчезнет через 24 часа."), fileInput),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), publish],
    onClose: () => { if (url) URL.revokeObjectURL(url); },
  });
  publish.addEventListener("click", () => busy(publish, async () => {
    if (!file && !ta.value.trim()) return toast("Добавьте фото или текст", { error: true });
    const fd = new FormData();
    if (file) fd.append("photo", file);
    fd.append("text", ta.value);
    fd.append("background", bg);
    fd.append("visibility", vis.value);
    try {
      await api.form("/api/stories", fd);
      m.close();
      toast("История опубликована на 24 часа", { icon: "check" });
      onDone?.();
    } catch (e) { toastError(e); }
  }));
  paint();
}

export { navigate };
