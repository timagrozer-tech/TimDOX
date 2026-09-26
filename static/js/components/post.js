// Карточка записи: текст, фото, цитата, реакции, комментарии, репост, закладки.
import { api, state } from "../api.js";
import { h, icon, avatar, richText, timeAgo, fullDate, pl, autosize } from "../dom.js";
import { toast, toastError, showMenu, modal, confirmDialog, promptDialog, lightbox } from "../ui.js";
import { navigate } from "../router.js";
import { VISIBILITY, visibilitySelect, openComposerModal } from "./composer.js";
import { burst } from "../fx.js";

export const REACTIONS = [
  { type: "like", emoji: "👍", label: "Нравится" },
  { type: "love", emoji: "❤️", label: "Супер" },
  { type: "haha", emoji: "😂", label: "Смешно" },
  { type: "wow", emoji: "😮", label: "Ух ты" },
  { type: "sad", emoji: "😢", label: "Грустно" },
  { type: "angry", emoji: "😡", label: "Возмутительно" },
];
export const REACTION = Object.fromEntries(REACTIONS.map((r) => [r.type, r]));

// ---------------------------------------------------------------- Фото
export function gallery(media, { compact = false } = {}) {
  if (!media?.length) return null;
  const n = media.length;
  const shown = media.slice(0, 4);
  const cls = `gallery n${Math.min(n, 4)}`;
  const el = h("div", { class: cls });
  shown.forEach((m, i) => {
    const single = n === 1 && !compact;
    const img = h("img", { src: single ? m.url : m.thumb, alt: m.alt || "Фото", loading: "lazy" });
    if (single && m.width && m.height) img.style.aspectRatio = `${m.width} / ${m.height}`;
    el.append(h("button", { type: "button", "aria-label": `Открыть фото ${i + 1} из ${n}`, onclick: () => lightbox(media, i) },
      img, i === 3 && n > 4 ? h("span.more-overlay", `+${n - 4}`) : null));
  });
  return el;
}

// ---------------------------------------------------------------- Шапка
export function communityAvatar(c, size = "") {
  return h(`span.avatar.comm-avatar${size ? "." + size : ""}`, c.avatar ? h("img", { src: c.avatar.replace(/\.webp$/, "_t.webp"), alt: "" }) : c.name[0]);
}

function head(post, menuBtn) {
  const v = VISIBILITY[post.visibility];
  const c = post.community;
  const asComm = c && post.as_community;
  return h("div.post-head",
    asComm ? h("a", { href: `/c/${c.slug}`, "aria-label": c.name }, communityAvatar(c))
      : h("a", { href: `/u/${post.author.username}`, "aria-label": post.author.name }, avatar(post.author)),
    h("div.who",
      asComm ? h("a.name", { href: `/c/${c.slug}` }, c.name)
        : h("div", h("a.name", { href: `/u/${post.author.username}` }, post.author.name),
          c ? h("span.muted", { style: { fontSize: "14px" } }, " в ", h("a", { href: `/c/${c.slug}` }, c.name)) : null),
      h("div.meta",
        h("a", { href: `/post/${post.id}`, title: fullDate(post.created_at) }, h("time", { datetime: post.created_at }, timeAgo(post.created_at))),
        post.circle ? h("span", { title: `Видит круг «${post.circle}»`, class: "row", style: { gap: "4px" } }, "·", icon("users", "sm"), post.circle)
          : v && post.visibility !== "public" && !c ? h("span", { title: v.hint, class: "row", style: { gap: "4px" } }, "·", icon(v.icon, "sm")) : null,
        post.edited_at ? h("span.post-edited", "· изменено") : null)),
    menuBtn);
}

function body(post, { clamp = true } = {}) {
  const parts = [];
  if (post.text) {
    const t = richText(post.text, "post-text");
    if (clamp && (post.text.length > 700 || post.text.split("\n").length > 10)) {
      t.classList.add("clamped");
      const more = h("button.more-link", { type: "button", onclick: () => { t.classList.remove("clamped"); more.remove(); } }, "Показать полностью");
      parts.push(t, more);
    } else parts.push(t);
  }
  const g = gallery(post.media);
  if (g) parts.push(g);
  return parts;
}

function quoteCard(q) {
  if (!q) return null;
  if (q.unavailable) return h("div.quote-card.unavailable", icon("lock", "sm"), " Запись недоступна или удалена");
  if (q.nested) return h("a.quote-card.unavailable", { href: `/post/${q.id}` }, "Цитата другой записи →");
  return h("a.quote-card", { href: `/post/${q.id}` },
    q.community && q.as_community
      ? h("div.row", communityAvatar(q.community, "xs"), h("b", q.community.name), h("span.muted", `· ${timeAgo(q.created_at)}`))
      : h("div.row", avatar(q.author, "xs", { presence: false }), h("b", q.author.name), h("span.muted", `· ${timeAgo(q.created_at)}`)),
    q.text ? richText(q.text.length > 400 ? q.text.slice(0, 400) + "…" : q.text, "post-text") : null,
    gallery(q.media, { compact: true }));
}

// ---------------------------------------------------------------- Карточка
export function postCard(input, opts = {}) {
  const wrapper = h("article.post", { "aria-label": `Запись ${input.author?.name || ""}` });
  let commentsBox = null;
  let current = input;
  // Для простого репоста показываем оригинал с подписью «поделился»
  const target = () => (current.is_repost && current.quote && !current.quote.unavailable ? current.quote : current);

  function render() {
    const p = target();
    const nodes = [];
    if (current.is_repost) {
      nodes.push(h("div.post-repost-label", icon("repeat", "sm"),
        h("a", { href: `/u/${current.author.username}` }, current.author.id === state.me?.id ? "Вы поделились" : `${current.author.name} поделился(-ась)`)));
      if (p === current) {
        nodes.push(h("div.quote-card.unavailable", "Оригинальная запись удалена или скрыта"));
        wrapper.replaceChildren(...nodes.filter(Boolean));
        return;
      }
    }
    const menuBtn = h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Действия с записью", "aria-haspopup": "menu" }, icon("more"));
    menuBtn.addEventListener("click", () => openPostMenu(menuBtn, p));
    nodes.push(head(p, menuBtn), ...body(p, opts), quoteCard(p.quote), actions(p));
    wrapper.replaceChildren(...nodes.filter(Boolean));
    if (commentsBox) wrapper.append(commentsBox);
  }

  function update(p) {
    if (current.is_repost && current.quote && current.quote.id === p.id) current = { ...current, quote: { ...p, quote: current.quote.quote } };
    else current = { ...current, ...p };
    render();
  }

  // ---- кнопки действий
  function actions(p) {
    const mine = p.reactions.mine;
    const r = mine ? REACTION[mine] : null;
    const reactBtn = h(`button.action${mine ? ".on." + mine : ""}`, {
      type: "button", "aria-pressed": String(!!mine), "aria-haspopup": "true",
      title: "Нажмите — «Нравится». Удерживайте или наведите — другие реакции",
      "aria-label": `${r ? r.label : "Нравится"}${p.reactions.total ? ` · ${p.reactions.total}` : ""}`,
    }, r ? h("span.emoji", r.emoji) : icon("thumb"), p.reactions.total ? h("span.count", String(p.reactions.total)) : null);
    const wrap = h("div.react-wrap", reactBtn);
    let picker = null, hoverTimer = null, pressTimer = null, suppressClick = false;

    const closePicker = () => { picker?.remove(); picker = null; };
    const openPicker = () => {
      if (picker) return;
      picker = h("div.reaction-picker", { role: "menu", "aria-label": "Выберите реакцию" },
        REACTIONS.map((x) => h("button", {
          type: "button", title: x.label, "aria-label": x.label, "aria-pressed": String(mine === x.type), role: "menuitem",
          onclick: (e) => { e.stopPropagation(); closePicker(); setReaction(p, x.type, reactBtn); },
        }, x.emoji)));
      wrap.append(picker);
      picker.addEventListener("mouseleave", () => { hoverTimer = setTimeout(closePicker, 300); });
      picker.addEventListener("mouseenter", () => clearTimeout(hoverTimer));
      picker.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePicker(); reactBtn.focus(); } });
      setTimeout(() => document.addEventListener("pointerdown", function onDoc(ev) {
        if (!wrap.contains(ev.target)) { closePicker(); document.removeEventListener("pointerdown", onDoc); }
      }));
    };
    reactBtn.addEventListener("mouseenter", () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(openPicker, 450); });
    reactBtn.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(closePicker, 400); });
    reactBtn.addEventListener("touchstart", () => { suppressClick = false; pressTimer = setTimeout(() => { suppressClick = true; openPicker(); }, 420); }, { passive: true });
    reactBtn.addEventListener("touchend", () => clearTimeout(pressTimer));
    reactBtn.addEventListener("contextmenu", (e) => { if (picker || suppressClick) e.preventDefault(); });
    reactBtn.addEventListener("keydown", (e) => { if (e.key === "ArrowUp") { e.preventDefault(); openPicker(); picker.querySelector("button").focus(); } });
    reactBtn.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      clearTimeout(hoverTimer); closePicker();
      setReaction(p, mine ? null : "like", reactBtn);
    });

    const commentBtn = h("button.action", { type: "button", onclick: () => toggleComments(p), title: "Комментарии", "aria-label": `Комментарии${p.comments_count ? ` · ${p.comments_count}` : ""}` },
      icon("comment"), p.comments_count ? h("span.count", String(p.comments_count)) : null);
    const repostBtn = h(`button.action${p.reposted ? ".reposted" : ""}`, { type: "button", "aria-haspopup": "menu", title: "Поделиться", "aria-label": `Поделиться${p.reposts_count ? ` · ${p.reposts_count}` : ""}` },
      icon("repeat"), p.reposts_count ? h("span.count", String(p.reposts_count)) : null);
    const types = Object.entries(p.reactions.counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const whoBtn = p.reactions.total ? h("button.reactors", { type: "button", onclick: () => showReactors(p), title: "Кто отреагировал", "aria-label": "Кто отреагировал" },
      h("span.emoji-stack", types.map(([t]) => h("span", REACTION[t]?.emoji)))) : null;
    repostBtn.addEventListener("click", () => {
      if (p.visibility !== "public" || p.community?.is_private) return toast("Поделиться можно только публичной записью");
      showMenu(repostBtn, [
        p.author.id === state.me.id ? null : p.reposted
          ? { label: "Отменить репост", icon: "x", onClick: () => doRepost(p, false) }
          : { label: "Сделать репост", icon: "repeat", onClick: () => doRepost(p, true) },
        { label: "Цитировать", icon: "quote", onClick: () => openComposerModal({ quote: { id: p.id, node: quoteCard(p) } }) },
        { label: "Скопировать ссылку", icon: "link", onClick: () => copyLink(p) },
      ]);
    });
    const bmBtn = h(`button.action${p.bookmarked ? ".bookmarked" : ""}`, {
      type: "button", "aria-pressed": String(p.bookmarked), "aria-label": p.bookmarked ? "Убрать из закладок" : "В закладки",
      title: p.bookmarked ? "Убрать из закладок" : "Сохранить в закладки",
      onclick: async () => {
        try {
          await (p.bookmarked ? api.del(`/api/posts/${p.id}/bookmark`) : api.post(`/api/posts/${p.id}/bookmark`));
          update({ ...p, bookmarked: !p.bookmarked });
          toast(p.bookmarked ? "Убрано из закладок" : "Сохранено в закладки", { icon: "bookmark" });
          if (p.bookmarked) opts.onUnbookmark?.(wrapper);
        } catch (e) { toastError(e); }
      },
    }, icon("bookmark"));
    return h("div.post-actions", wrap, commentBtn, repostBtn, whoBtn, h("div.spacer"), bmBtn);
  }

  async function setReaction(p, type, anchor) {
    if (type && anchor) burst(anchor, REACTION[type].emoji);
    try {
      const reactions = type ? await api.post(`/api/posts/${p.id}/react`, { type }) : await api.del(`/api/posts/${p.id}/react`);
      update({ ...p, reactions });
    } catch (e) { toastError(e); }
  }

  async function doRepost(p, on) {
    try {
      const fresh = on ? await api.post(`/api/posts/${p.id}/repost`) : await api.del(`/api/posts/${p.id}/repost`);
      update(fresh);
      toast(on ? "Вы поделились записью" : "Репост отменён", { icon: "repeat" });
    } catch (e) { toastError(e); }
  }

  function toggleComments(p) {
    if (commentsBox) { commentsBox.remove(); commentsBox = null; return; }
    commentsBox = commentsSection(p, (count) => update({ ...target(), comments_count: count }));
    wrapper.append(commentsBox);
  }

  async function openPostMenu(btn, p) {
    const mine = p.author.id === state.me.id;
    const mod = p.can_moderate;
    showMenu(btn, [
      mod ? { label: "Закрепить в сообществе", icon: "pin", onClick: async () => {
        try { await api.patch(`/api/communities/${p.community.slug}`, { pinned_post_id: p.id }); toast("Запись закреплена", { icon: "pin" }); opts.onPin?.(p); } catch (e) { toastError(e); }
      } } : null,
      { label: "Открыть запись", icon: "chevronRight", onClick: () => navigate(`/post/${p.id}`) },
      { label: "Скопировать ссылку", icon: "link", onClick: () => copyLink(p) },
      mine ? "-" : null,
      mine ? { label: "Редактировать", icon: "edit", onClick: () => editPost(p) } : null,
      mine ? { label: "Удалить", icon: "trash", danger: true, onClick: () => deletePost(p) } : null,
      !mine && mod ? { label: "Удалить (модерация)", icon: "trash", danger: true, onClick: () => deletePost(p) } : null,
      !mine ? { label: "Пожаловаться", icon: "flag", danger: true, onClick: () => report("post", p.id) } : null,
    ]);
  }

  function editPost(p) {
    const ta = h("textarea.textarea", { rows: 6, maxlength: 5100, value: p.text });
    const vis = visibilitySelect(p.visibility);
    const save = h("button.btn.primary", { type: "button" }, "Сохранить");
    const m = modal({
      title: "Редактирование записи", body: h("div.stack", ta, h("div.row", h("span.muted", "Кто видит:"), vis)),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
    });
    autosize(ta);
    save.addEventListener("click", async () => {
      try {
        const fresh = await api.patch(`/api/posts/${p.id}`, { text: ta.value, visibility: vis.value });
        update(fresh);
        m.close();
        toast("Изменения сохранены", { icon: "check" });
      } catch (e) { toastError(e); }
    });
  }

  async function deletePost(p) {
    if (!await confirmDialog({ title: "Удалить запись?", text: "Запись, фото и комментарии будут удалены без возможности восстановления.", confirm: "Удалить", danger: true })) return;
    try {
      await api.del(`/api/posts/${p.id}`);
      wrapper.style.transition = "opacity .2s"; wrapper.style.opacity = "0";
      setTimeout(() => wrapper.remove(), 200);
      toast("Запись удалена");
      opts.onDelete?.(p);
    } catch (e) { toastError(e); }
  }

  render();
  if (opts.openComments) toggleComments(target());
  return wrapper;
}

// ---------------------------------------------------------------- Комментарии
function commentsSection(post, onCount) {
  const list = h("div.stack", { style: { gap: "12px" } }, h("div.spinner.sm", { style: { margin: "8px auto" } }));
  let replyTo = null;
  let total = 0;
  const ta = h("textarea", { rows: 1, placeholder: "Написать комментарий…", maxlength: 2000, "aria-label": "Текст комментария" });
  autosize(ta);
  const replyLabel = h("div.reply-to.hidden");
  const send = h("button.btn.primary.icon-only.sm", { type: "submit", "aria-label": "Отправить комментарий" }, icon("send", "sm"));
  const form = h("form.comment-form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        const c = await api.post(`/api/posts/${post.id}/comments`, { text, parent_id: replyTo?.id || null });
        ta.value = ""; ta.dispatchEvent(new Event("input"));
        if (c.parent_id) {
          const parentEl = list.querySelector(`[data-comment-id="${c.parent_id}"] .replies`);
          parentEl?.append(comment(c, true));
        } else {
          list.querySelector(".empty-comments")?.remove();
          list.append(comment(c, false));
        }
        total++; onCount?.(total);
        setReply(null);
      } catch (err) { toastError(err); }
      send.disabled = false;
    },
  }, avatar(state.me, "sm", { presence: false }), h("div.input-wrap", ta, send));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  function setReply(c) {
    replyTo = c;
    if (!c) { replyLabel.classList.add("hidden"); return; }
    replyLabel.replaceChildren(`Ответ ${c.author.name}`, h("button", { type: "button", onclick: () => setReply(null) }, "Отмена"));
    replyLabel.classList.remove("hidden");
    if (!ta.value.startsWith(`@${c.author.username}`)) ta.value = `@${c.author.username}, ` + ta.value;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function comment(c, isReply) {
    const el = h("div.comment", { dataset: { commentId: c.id } },
      h("a", { href: `/u/${c.author.username}`, "aria-label": c.author.name }, avatar(c.author, isReply ? "xs" : "sm")),
      h("div.grow",
        h("div.bubble", h("a.name", { href: `/u/${c.author.username}` }, c.author.name), richText(c.text)),
        h("div.c-meta",
          h("span", { title: fullDate(c.created_at) }, timeAgo(c.created_at)),
          h("button", { type: "button", onclick: () => setReply(isReply ? { ...c, id: c.parent_id } : c) }, "Ответить"),
          c.can_delete ? h("button", {
            type: "button", onclick: async () => {
              if (!await confirmDialog({ title: "Удалить комментарий?", text: "Ответы на него тоже будут удалены.", confirm: "Удалить", danger: true })) return;
              try {
                await api.del(`/api/comments/${c.id}`);
                const removed = 1 + (c.replies?.length || 0);
                el.remove(); total -= removed; onCount?.(total);
              } catch (e) { toastError(e); }
            },
          }, "Удалить") : h("button", { type: "button", onclick: () => report("comment", c.id) }, "Пожаловаться")),
        isReply ? null : h("div.replies", (c.replies || []).map((r) => comment(r, true)))));
    return el;
  }

  api.get(`/api/posts/${post.id}/comments`).then((data) => {
    total = data.total;
    list.replaceChildren(...data.items.map((c) => comment(c, false)));
    if (!data.items.length) list.append(h("p.muted.empty-comments", { style: { fontSize: "14px" } }, "Комментариев пока нет — будьте первым."));
    onCount?.(total);
  }).catch((e) => list.replaceChildren(h("p.muted", e.message)));

  const box = h("div.comments", list, replyLabel, form);
  setTimeout(() => ta.focus(), 50);
  return box;
}

// ---------------------------------------------------------------- Вспомогательное
async function showReactors(p) {
  const body = h("div.people", h("div.spinner"));
  const tabs = h("div.segmented", { style: { marginBottom: "12px" } });
  modal({ title: "Реакции", body: h("div", tabs, body), narrow: true });
  try {
    const { items } = await api.get(`/api/posts/${p.id}/reactions`);
    const draw = (filter) => {
      tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === filter)));
      body.replaceChildren(...items.filter((i) => filter === "all" || i.type === filter).map((i) =>
        h("a.mini-person", { href: `/u/${i.user.username}`, style: { padding: "6px 0" } },
          avatar(i.user, "sm"), h("div.who", h("span.name", i.user.name), h("span.sub", `@${i.user.username}`)),
          h("span", { style: { fontSize: "20px" } }, REACTION[i.type].emoji))));
    };
    const counts = {};
    items.forEach((i) => { counts[i.type] = (counts[i.type] || 0) + 1; });
    tabs.append(h("button", { type: "button", dataset: { f: "all" }, onclick: () => draw("all") }, `Все ${items.length}`),
      ...Object.entries(counts).map(([t, n]) => h("button", { type: "button", dataset: { f: t }, onclick: () => draw(t) }, `${REACTION[t].emoji} ${n}`)));
    body.classList.add("mini-people");
    draw("all");
  } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
}

function copyLink(p) {
  const url = `${location.origin}/post/${p.id}`;
  navigator.clipboard?.writeText(url).then(() => toast("Ссылка скопирована", { icon: "link" }), () => toast(url));
}

export async function report(type, id) {
  const reason = await promptDialog({
    title: "Пожаловаться", label: "Комментарий (необязательно)", confirm: "Отправить жалобу",
    options: ["Спам", "Оскорбления", "Недостоверная информация", "Насилие или опасные действия", "Другое"],
  });
  if (reason == null) return;
  try {
    await api.post("/api/reports", { target_type: type, target_id: id, reason });
    toast("Жалоба отправлена модераторам. Спасибо!", { icon: "flag" });
  } catch (e) { toastError(e); }
}
