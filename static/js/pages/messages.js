// Личные сообщения в реальном времени: список диалогов и окно переписки.
import { api, state, on, setCounters } from "../api.js";
import { h, icon, avatar, shortTime, hm, dayLabel, richText, autosize } from "../dom.js";
import { setTitle, toast, toastError, showMenu, modal, promptDialog, confirmDialog, lightbox } from "../ui.js";
import { openPanel } from "../components/stickerpanel.js";
import { audioPlayer, videoPlayer, videoMeta, audioMeta, parseTrackName } from "../components/mediakit.js";
import { showPackPreview } from "./stickers.js";
import { setCleanup, navigate } from "../router.js";
import { pickFriends } from "../components/people.js";

function convAvatar(c, size = "") {
  if (!c.is_group) return avatar(c.user, size);
  return h(`span.avatar.group-avatar${size ? "." + size : ""}`, icon("users"));
}

async function createGroup() {
  const ids = await pickFriends({ title: "Новая беседа", confirm: "Далее", min: 2 });
  if (!ids) return;
  const title = await promptDialog({ title: "Название беседы", label: "Можно оставить пустым — придумаем сами", confirm: "Создать беседу" });
  if (title === null) return;
  try {
    const conv = await api.post("/api/conversations/group", { title, user_ids: ids });
    navigate(`/messages/${conv.id}`);
  } catch (e) { toastError(e); }
}

const BIG_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u;
function isBigEmoji(text) {
  if (!text || text.length > 24 || !BIG_EMOJI.test(text) || /^[\d\s#*]+$/.test(text)) return 0;
  const n = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter().segment(text.replace(/\s/g, ""))].length : 1;
  return n <= 3 ? n : 0;
}

/** Короткое описание сообщения для списка диалогов */
export function previewOf(m) {
  if (!m) return "";
  const cap = m.text ? ` ${m.text}` : "";
  switch (m.kind) {
    case "photo": return `📷 Фото${cap}`;
    case "video": return `🎬 Видео${cap}`;
    case "audio": return `🎵 ${m.media?.title || "Аудио"}${cap}`;
    case "sticker": return `${m.media?.emoji || m.text || ""} Стикер`;
    default: return m.text;
  }
}

export async function messagesPage({ params }) {
  setTitle("Сообщения");
  const activeId = params.id ? Number(params.id) : null;
  const layout = h(`div.card.chat-layout${activeId ? ".has-chat" : ""}`);
  const listEl = h("div", { role: "list" });
  const filterInput = h("input", { type: "search", placeholder: "Найти диалог", "aria-label": "Найти диалог" });
  filterInput.addEventListener("input", () => drawList());
  const listPane = h("div.chat-list", h("div.chat-list-head.row",
    h("h1", { style: { fontSize: "20px" } }, "Сообщения"), h("div.spacer"),
    h("button.btn.soft.sm.icon-only", { type: "button", onclick: createGroup, title: "Создать беседу", "aria-label": "Создать беседу" }, icon("plus", "sm"))),
    h("label.chat-filter", icon("search", "sm"), filterInput), listEl);
  const chatPane = h("section.chat", { "aria-label": "Переписка" });
  layout.append(listPane, chatPane);

  let convs = [];
  const cleanups = [];
  setCleanup(() => cleanups.forEach((f) => f()));

  // ---------------------------------------------------------------- Список диалогов
  function convItem(c) {
    const last = c.last_message;
    const mine = last && last.sender_id === state.me.id;
    return h(`a.conv${c.id === activeId ? ".active" : ""}${c.unread ? ".unread" : ""}`, { href: `/messages/${c.id}`, role: "listitem", dataset: { conv: c.id } },
      convAvatar(c),
      h("div.who",
        h("div.top", h("span.name", c.title), last ? h("span.time", shortTime(last.created_at)) : null),
        h("div.preview-text",
          mine && last.kind !== "system" ? icon(last.id <= c.other_last_read_id ? "checks" : "check", "sm") : null,
          h("span.grow", last ? `${last.kind === "system" ? "" : mine ? "Вы: " : c.is_group && c.last_sender ? c.last_sender.name.split(" ")[0] + ": " : ""}${previewOf(last)}` : "Нет сообщений"),
          c.unread ? h("span.badge", String(c.unread)) : null)));
  }
  function drawList() {
    if (!convs.length) {
      listEl.replaceChildren(h("div.empty", icon("message"), h("h3", "Диалогов пока нет"),
        h("p", "Откройте профиль друга и нажмите «Написать»."), h("a.btn.soft.sm", { href: "/friends" }, "К списку друзей")));
      return;
    }
    const q = filterInput.value.trim().toLowerCase();
    const shown = q ? convs.filter((c) => c.title.toLowerCase().includes(q)) : convs;
    listEl.replaceChildren(...(shown.length ? shown.map(convItem) : [h("p.muted.card-pad", "Ничего не нашлось")]));
  }
  async function loadList() {
    try {
      convs = (await api.get("/api/conversations")).items;
      drawList();
    } catch (e) { listEl.replaceChildren(h("p.muted.card-pad", e.message)); }
  }

  // ---------------------------------------------------------------- Окно переписки
  let chat = null;

  async function openChat(id) {
    let conv;
    try { conv = await api.get(`/api/conversations/${id}`); } catch (e) {
      chatPane.replaceChildren(h("div.chat-empty", h("div.empty", icon("x"), h("h3", "Диалог не найден"), h("p", e.message))));
      return;
    }
    setTitle(conv.title);
    const isGroup = conv.is_group;
    const statusText = () => (isGroup ? `${conv.members.length} участников` : conv.user.online ? "в сети" : "не в сети");
    const body = h("div.chat-body", { role: "log", "aria-live": "polite", "aria-label": `Переписка: ${conv.title}` });
    const sub = h("div.sub", statusText());
    const ta = h("textarea", { rows: 1, placeholder: conv.can_write ? "Напишите сообщение…" : "Вы не можете написать этому пользователю", maxlength: 4000, disabled: !conv.can_write, "aria-label": "Текст сообщения" });
    const fit = autosize(ta);
    const send = h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить", disabled: !conv.can_write }, icon("send"));
    const emojiBtn = h("button.btn.ghost.icon-only.emoji-btn.sp-toggle", { type: "button", "aria-label": "Смайлики и стикеры", title: "Смайлики и стикеры", disabled: !conv.can_write }, icon("smile"));
    const attachBtn = h("button.btn.ghost.icon-only.attach-btn", { type: "button", "aria-label": "Прикрепить", title: "Фото, видео или музыка", disabled: !conv.can_write, "aria-haspopup": "menu" }, icon("clip"));
    const pickMedia = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime", multiple: true, hidden: true });
    const pickAudio = h("input", { type: "file", accept: "audio/*,.mp3,.m4a,.ogg,.wav,.flac", multiple: true, hidden: true });
    const form = h("form.chat-form", h("div.chat-input", attachBtn, ta, emojiBtn, send), pickMedia, pickAudio);
    emojiBtn.addEventListener("click", () => openPanel(form, {
      onEmoji: (em) => {
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, pos) + em + ta.value.slice(ta.selectionEnd ?? pos);
        ta.selectionStart = ta.selectionEnd = pos + em.length;
        fit();
        if (!matchMedia("(pointer: coarse)").matches) ta.focus();
      },
      onSticker: (st) => sendSticker(st),
    }));
    attachBtn.addEventListener("click", () => showMenu(attachBtn, [
      { label: "Фото или видео", icon: "image", onClick: () => pickMedia.click() },
      { label: "Музыка", icon: "music", onClick: () => pickAudio.click() },
    ]));
    pickMedia.addEventListener("change", () => { sendFiles([...pickMedia.files]); pickMedia.value = ""; });
    pickAudio.addEventListener("change", () => { sendFiles([...pickAudio.files], "audio"); pickAudio.value = ""; });
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); sendFiles(files); }
    });
    // перетаскивание файлов в окно переписки
    body.addEventListener("dragover", (e) => { if (conv.can_write && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); body.classList.add("drop"); } });
    body.addEventListener("dragleave", () => body.classList.remove("drop"));
    body.addEventListener("drop", (e) => { e.preventDefault(); body.classList.remove("drop"); if (conv.can_write) sendFiles([...e.dataTransfer.files]); });
    const groupMenu = isGroup ? h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Настройки беседы", "aria-haspopup": "menu" }, icon("more")) : null;
    groupMenu?.addEventListener("click", () => showMenu(groupMenu, [
      { label: "Участники", icon: "users", onClick: showMembers },
      { label: "Добавить друзей", icon: "userPlus", onClick: addMembers },
      { label: "Переименовать", icon: "edit", onClick: rename },
      "-",
      { label: "Покинуть беседу", icon: "logout", danger: true, onClick: leave },
    ]));
    chatPane.replaceChildren(
      h("header.chat-head",
        h("a.btn.ghost.icon-only.back", { href: "/messages", "aria-label": "К списку диалогов" }, icon("back")),
        isGroup ? convAvatar(conv) : conv.user.username ? h("a", { href: `/u/${conv.user.username}`, "aria-label": conv.user.name }, avatar(conv.user)) : avatar(conv.user),
        h("div.who", isGroup ? h("button.name.link-btn", { type: "button", onclick: showMembers }, conv.title)
          : conv.user.username ? h("a.name", { href: `/u/${conv.user.username}` }, conv.user.name) : h("span.name", conv.user.name), sub),
        groupMenu),
      body, form);

    chat = { id, conv, body, sub, messages: [], hasMore: false, loadingOlder: false, otherRead: conv.other_last_read_id, typingTimer: null, senders: {} };
    (conv.members || []).forEach((m) => { chat.senders[m.id] = m; });

    function showMembers() {
      modal({ title: `Участники · ${conv.members.length}`, narrow: true, body: h("div.mini-people", conv.members.map((m) =>
        h("a.mini-person", { href: `/u/${m.username}` }, avatar(m, "sm"), h("div.who", h("span.name", m.name), h("span.sub", m.id === conv.created_by ? "создатель беседы" : `@${m.username}`))))) });
    }
    async function addMembers() {
      const ids = await pickFriends({ title: "Добавить в беседу", confirm: "Добавить", exclude: conv.members.map((m) => m.id) });
      if (!ids?.length) return;
      try { Object.assign(conv, await api.post(`/api/conversations/${id}/members`, { user_ids: ids })); conv.members.forEach((m) => { chat.senders[m.id] = m; }); sub.textContent = statusText(); } catch (e) { toastError(e); }
    }
    async function rename() {
      const t = await promptDialog({ title: "Название беседы", confirm: "Сохранить" });
      if (!t) return;
      try { Object.assign(conv, await api.patch(`/api/conversations/${id}`, { title: t })); chatPane.querySelector(".chat-head .name").textContent = conv.title; setTitle(conv.title); } catch (e) { toastError(e); }
    }
    async function leave() {
      if (!await confirmDialog({ title: "Покинуть беседу?", text: "Вы перестанете получать сообщения из неё.", confirm: "Покинуть", danger: true })) return;
      try { await api.post(`/api/conversations/${id}/leave`); toast("Вы покинули беседу"); convs = convs.filter((c) => c.id !== id); navigate("/messages"); } catch (e) { toastError(e); }
    }

    const sameGroup = (a, b) => a && b && a.sender_id === b.sender_id && a.kind !== "system" && b.kind !== "system"
      && dayLabel(a.created_at) === dayLabel(b.created_at);
    function msgNode(m, prev, next) {
      const mine = m.sender_id === state.me.id;
      const nodes = [];
      if (!prev || dayLabel(prev.created_at) !== dayLabel(m.created_at)) nodes.push(h("div.day-sep", dayLabel(m.created_at)));
      if (m.kind === "system") { nodes.push(h("div.msg-system", { dataset: { id: m.id } }, m.text)); return nodes; }
      const first = !prev || prev.sender_id !== m.sender_id || prev.kind === "system" || nodes.length;
      if (isGroup && !mine && first) {
        const snd = chat.senders[m.sender_id];
        nodes.push(h("div.msg-sender", snd ? avatar(snd, "xs", { presence: false }) : null, snd ? snd.name : "Участник"));
      }
      const meta = h("span.m-meta", hm(new Date(m.created_at)), mine ? icon(m.pending ? "check" : (m.id <= chat.otherRead ? "checks" : "check")) : null);
      const last = !sameGroup(m, next);
      const big = m.kind === "text" ? isBigEmoji(m.text) : 0;
      const cls = `${mine ? ".mine" : ""}${first ? ".first" : ""}${last ? ".last" : ""}${m.pending ? ".pending" : ""}`;
      let bubble;
      if (m.kind === "sticker" && m.media) {
        bubble = h(`div.msg-sticker${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          h("button.sticker-img", { type: "button", title: `Набор «${m.media.pack?.title || ""}»`, onclick: () => showPackPreview(m.media.pack?.slug) },
            h("img", { src: m.media.url, alt: m.media.emoji || "Стикер", loading: "lazy", draggable: false })), meta);
      } else if (big) {
        bubble = h(`div.msg-bigemoji.e${big}${cls}`, { dataset: { id: m.id, sender: m.sender_id } }, h("span", m.text), meta);
      } else if (m.media && ["photo", "video", "audio"].includes(m.kind)) {
        const md = m.media;
        const content = md.type === "photo"
          ? h("button.chat-photo", { type: "button", "aria-label": "Открыть фото", onclick: () => lightbox([{ url: md.url, alt: m.text || "Фото" }]) },
            h("img", { src: md.thumb || md.url, alt: m.text || "Фото", loading: "lazy", style: md.w && md.h ? { aspectRatio: `${md.w} / ${md.h}` } : {} }))
          : md.type === "video" ? videoPlayer(md) : audioPlayer(md);
        bubble = h(`div.msg.media-msg.k-${md.type}${m.text ? ".with-caption" : ""}${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          content, m.text ? h("div.caption", ...richText(m.text).childNodes) : null, meta);
      } else {
        bubble = h(`div.msg${cls}`, { dataset: { id: m.id, sender: m.sender_id } });
        bubble.append(...richText(m.text).childNodes, meta);
      }
      if (mine) bubble.title = m.pending ? "Отправляется…" : (m.id <= chat.otherRead ? "Прочитано" : "Доставлено");
      nodes.push(bubble);
      return nodes;
    }
    function drawAll(keepBottomOffset = null) {
      const nodes = [];
      if (chat.hasMore) nodes.push(h("button.btn.ghost.sm", { type: "button", style: { alignSelf: "center" }, onclick: loadOlder }, "Показать ранние сообщения"));
      if (!chat.messages.length) nodes.push(h("div.chat-empty", h("div.empty", convAvatar(conv, "lg"), h("h3", conv.title), h("p", "Напишите первое сообщение 👋"))));
      chat.messages.forEach((m, i) => nodes.push(...msgNode(m, chat.messages[i - 1], chat.messages[i + 1])));
      body.replaceChildren(...nodes);
      if (keepBottomOffset != null) body.scrollTop = body.scrollHeight - keepBottomOffset;
      else body.scrollTop = body.scrollHeight;
    }
    function nearBottom() { return body.scrollHeight - body.scrollTop - body.clientHeight < 120; }
    async function loadOlder() {
      if (chat.loadingOlder || !chat.hasMore) return;
      chat.loadingOlder = true;
      try {
        const res = await api.get(`/api/conversations/${id}/messages`, { before: chat.messages[0]?.id });
        chat.messages = [...res.items, ...chat.messages];
        chat.hasMore = res.has_more;
        drawAll(body.scrollHeight - body.scrollTop);
      } catch (e) { toastError(e); }
      chat.loadingOlder = false;
    }
    body.addEventListener("scroll", () => { if (body.scrollTop < 60) loadOlder(); });

    chat.append = (m) => {
      if (chat.messages.some((x) => x.id === m.id)) return;
      const stick = nearBottom() || m.sender_id === state.me.id;
      const prev = chat.messages.at(-1);
      chat.messages.push(m);
      body.querySelector(".chat-empty")?.remove();
      if (sameGroup(prev, m)) body.querySelector(`.msg[data-id="${prev.id}"]`)?.classList.remove("last");
      body.append(...msgNode(m, prev, null));
      if (stick) body.scrollTop = body.scrollHeight;
    };
    chat.refreshTicks = () => {
      body.querySelectorAll(".msg.mine").forEach((b) => {
        const mid = Number(b.dataset.id);
        const meta = b.querySelector(".m-meta");
        if (!meta || b.classList.contains("pending")) return;
        const read = mid <= chat.otherRead;
        meta.lastElementChild?.replaceWith(icon(read ? "checks" : "check"));
        b.title = read ? "Прочитано" : "Доставлено";
      });
    };
    chat.markRead = () => {
      if (document.visibilityState !== "visible") return;
      api.post(`/api/conversations/${id}/read`).then(() => {
        const c = convs.find((x) => x.id === id);
        if (c && c.unread) { c.unread = 0; drawList(); }
      }).catch(() => {});
    };
    chat.showTyping = (name) => {
      sub.textContent = isGroup && name ? `${name.split(" ")[0]} печатает…` : "печатает…";
      sub.classList.add("typing");
      clearTimeout(chat.typingTimer);
      chat.typingTimer = setTimeout(() => { sub.textContent = statusText(); sub.classList.remove("typing"); }, 3500);
    };
    chat.setOnline = (online) => { if (isGroup) return; conv.user.online = online; if (!sub.classList.contains("typing")) sub.textContent = statusText(); };

    async function sendSticker(st) {
      try {
        const m = await api.post(`/api/conversations/${id}/messages`, { sticker_id: st.id });
        chat.append(m);
        upsertConv(id, m);
      } catch (err) { toastError(err); }
    }

    // ---- вложения: фото, видео, музыка — с прогрессом загрузки
    async function sendFiles(files, forceType = null) {
      for (const file of files.slice(0, 10)) {
        const type = forceType || (file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "photo" : null);
        if (!type) { toast(`«${file.name}» — неподдерживаемый формат`, { error: true }); continue; }
        const limitMb = type === "video" ? 30 : type === "audio" ? 15 : 10;
        if (file.size > limitMb * 1024 * 1024) { toast(`«${file.name}» больше ${limitMb} МБ`, { error: true }); continue; }
        await uploadOne(file, type);
      }
    }
    async function uploadOne(file, type) {
      const fd = new FormData();
      fd.append("type", type);
      const caption = ta.value.trim();
      if (caption) { fd.append("caption", caption); ta.value = ""; fit(); }
      const localUrl = type === "audio" ? null : URL.createObjectURL(file);
      const ring = h("span.up-ring", { style: { "--p": "0" } }, h("b", "0%"));
      const cancel = h("button.up-cancel", { type: "button", "aria-label": "Отменить загрузку" }, icon("x", "sm"));
      const card = h("div.msg.mine.media-msg.uploading.first.last",
        type === "photo" ? h("img.up-preview", { src: localUrl, alt: "" })
          : type === "video" ? h("video.up-preview", { src: localUrl, muted: true, playsinline: true })
            : h("div.up-audio", icon("music"), h("span", file.name)),
        h("div.up-overlay", ring, cancel));
      body.querySelector(".chat-empty")?.remove();
      body.append(card);
      body.scrollTop = body.scrollHeight;
      try {
        if (type === "video") {
          const meta = await videoMeta(file);
          if (meta.duration) fd.append("duration", String(meta.duration));
          if (meta.width) { fd.append("width", String(meta.width)); fd.append("height", String(meta.height)); }
          if (meta.poster) fd.append("poster", meta.poster, "poster.jpg");
        } else if (type === "audio") {
          const meta = await audioMeta(file);
          if (Number.isFinite(meta.duration)) fd.append("duration", String(meta.duration));
          const t = parseTrackName(file.name);
          fd.append("title", t.title); if (t.artist) fd.append("artist", t.artist);
        }
        fd.append("file", file, file.name);
        const up = api.upload(`/api/conversations/${id}/media`, fd, (p) => {
          const pct = Math.round(p * 100);
          ring.style.setProperty("--p", String(pct));
          ring.firstChild.textContent = `${pct}%`;
        });
        cancel.onclick = () => up.abort();
        const m = await up.promise;
        card.remove();
        chat.append(m);
        upsertConv(id, m);
      } catch (err) {
        card.remove();
        if (err.code !== "aborted") toastError(err);
      } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
      }
    }

    // отправка
    let lastTyping = 0;
    ta.addEventListener("input", () => {
      if (Date.now() - lastTyping > 2500 && ta.value.trim()) {
        lastTyping = Date.now();
        api.post(`/api/conversations/${id}/typing`).catch(() => {});
      }
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      ta.value = ""; fit();
      const temp = { id: Number.MAX_SAFE_INTEGER - Date.now(), sender_id: state.me.id, text, created_at: new Date().toISOString(), pending: true };
      chat.append(temp);
      try {
        const m = await api.post(`/api/conversations/${id}/messages`, { text });
        chat.messages = chat.messages.filter((x) => x !== temp && x.id !== m.id);
        chat.messages.push(m);
        chat.messages.sort((a, b) => a.id - b.id);
        drawAll();
        upsertConv(id, m);
      } catch (err) {
        chat.messages = chat.messages.filter((x) => x !== temp);
        drawAll();
        ta.value = text; fit();
        toastError(err);
      }
      ta.focus();
    });

    try {
      const res = await api.get(`/api/conversations/${id}/messages`);
      chat.messages = res.items;
      chat.hasMore = res.has_more;
      Object.assign(chat.senders, res.senders || {});
      drawAll();
      chat.markRead();
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
    if (matchMedia("(min-width: 900px)").matches) ta.focus();
  }

  function upsertConv(id, m) {
    let c = convs.find((x) => x.id === id);
    if (!c) { loadList(); return; }
    c.last_message = m;
    if (c.is_group) c.last_sender = chat?.senders?.[m.sender_id] || c.last_sender;
    if (m.sender_id !== state.me.id && id !== chat?.id) c.unread = (c.unread || 0) + 1;
    convs = [c, ...convs.filter((x) => x !== c)];
    drawList();
  }

  // ---------------------------------------------------------------- События
  cleanups.push(on("message", ({ message, sender }) => {
    const id = message.conversation_id;
    if (chat && chat.id === id) {
      if (sender) chat.senders[sender.id] = sender;
      chat.append(message);
      if (message.sender_id !== state.me.id) {
        chat.markRead();
        clearTimeout(chat.typingTimer);
        chat.sub.classList.remove("typing");
        chat.setOnline(true);
      }
    }
    upsertConv(id, message);
  }));
  cleanups.push(on("typing", ({ conversation_id, name }) => { if (chat && chat.id === conversation_id) chat.showTyping(name); }));
  cleanups.push(on("read", ({ conversation_id, last_read_id }) => {
    const c = convs.find((x) => x.id === conversation_id);
    if (c) { c.other_last_read_id = Math.max(c.other_last_read_id || 0, last_read_id); drawList(); }
    if (chat && chat.id === conversation_id) { chat.otherRead = Math.max(chat.otherRead, last_read_id); chat.refreshTicks(); }
  }));
  cleanups.push(on("presence", ({ user_id, online }) => {
    convs.forEach((c) => { if (c.user?.id === user_id) c.user.online = online; });
    if (chat && chat.conv.user?.id === user_id) chat.setOnline(online);
  }));
  const onVisible = () => { if (document.visibilityState === "visible" && chat) chat.markRead(); };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

  await loadList();
  if (activeId) openChat(activeId);
  else chatPane.replaceChildren(h("div.chat-empty", h("div.empty", icon("message"), h("h3", "Выберите диалог"),
    h("p", "Или нажмите «+» над списком, чтобы собрать беседу из друзей."))));
  api.get("/api/counters").then(setCounters).catch(() => {});
  return layout;
}

export { navigate };
