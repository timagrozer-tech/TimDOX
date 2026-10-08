// Личные сообщения в реальном времени: список диалогов и окно переписки.
import { chatAI } from "../components/chatai.js";
import { applyChatTheme, openThemeEditor, capsuleNode, openCapsuleDialog, wheelNode, openWheelDialog, nudgeNode, playNudge, nudgeMenu } from "../components/chatplus.js";
import { startCall } from "../call/call.js";
import { api, state, on, setCounters } from "../api.js";
import { h, icon, avatar, vmark, shortTime, hm, dayLabel, richText, autosize, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, showMenu, modal, promptDialog, confirmDialog, lightbox } from "../ui.js";
import { openPanel, loadCollection, stickerActions } from "../components/stickerpanel.js";
import { stickerEl } from "../components/stickerview.js";
import { report } from "../components/post.js";
import { attachMentions } from "../components/mentions.js";
import { audioPlayer, videoPlayer, voicePlayer, videoMeta, audioMeta, audioWaveform, parseTrackName, downsampleLevels, fmtDur } from "../components/mediakit.js";
import { showPackPreview } from "./stickers.js";
import { setCleanup, navigate } from "../router.js";
import { pickFriends } from "../components/people.js";
import { fileCard, fileIcon, locationCard, contactCard } from "../components/attachments.js";

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

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "🙏"];

/** Всплывающее меню сообщения: реакции + действия. items: [{label, icon, onClick, danger}] */
function messageMenu(anchor, { onReact, current, items, stickers = [], onMore = null }) {
  document.querySelector(".msg-menu")?.remove();
  const menu = h("div.msg-menu", { role: "menu" },
    onReact ? h("div.mm-reacts", QUICK_REACTIONS.map((e) => h(`button${e === current ? ".on" : ""}`, { type: "button", "aria-label": `Реакция ${e}`, onclick: () => { close(); onReact(e); } }, e)),
      // свои реакции-стикеры и «ещё» — любой стикер из коллекции
      stickers.slice(0, 6).map((s) => h(`button.mm-st${`st:${s.id}` === current ? ".on" : ""}`, { type: "button", "aria-label": `Реакция-стикер ${s.emoji}`, onclick: () => { close(); onReact(`st:${s.id}`); } }, stickerEl(s, { size: 30 }))),
      onMore ? h("button.mm-more", { type: "button", "aria-label": "Другие реакции", title: "Любой эмодзи или стикер", onclick: () => { close(); onMore(); } }, icon("plus", "sm")) : null) : null,
    h("div.mm-items", items.filter(Boolean).map((it) => h(`button${it.danger ? ".danger" : ""}`, { type: "button", role: "menuitem", onclick: () => { close(); it.onClick(); } }, icon(it.icon), it.label))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - mw / 2), innerWidth - mw - 8);
  let top = r.top - mh - 8;
  if (top < 8) top = Math.min(r.bottom + 8, innerHeight - mh - 8);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  anchor.classList.add("menu-open");
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    menu.remove(); anchor.classList.remove("menu-open");
    document.removeEventListener("pointerdown", onDoc, true); document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", close, true);
  }
  setTimeout(() => {
    document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
  });
}

/** Короткое описание сообщения для списка диалогов */
export function previewOf(m) {
  if (!m) return "";
  const cap = m.text ? ` ${m.text}` : "";
  switch (m.kind) {
    case "gif": return "GIF";
    case "photo": return `📷 Фото${cap}`;
    case "video": return `🎬 Видео${cap}`;
    case "audio": return `🎵 ${m.media?.title || "Аудио"}${cap}`;
    case "voice": return m.media?.transcript ? `🎤 ${m.media.transcript.length > 70 ? `${m.media.transcript.slice(0, 68).trimEnd()}…` : m.media.transcript}`
      : `🎤 Голосовое${m.media?.duration ? ` ${fmtDur(m.media.duration)}` : ""}`;
    case "file": return `📎 ${m.media?.name || "Файл"}${cap}`;
    case "location": return "📍 Местоположение";
    case "contact": return `👤 ${m.media?.name || "Контакт"}`;
    case "deleted": return "🚫 Сообщение удалено";
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
    h("button.btn.soft.sm.icon-only", { type: "button", onclick: createGroup, title: "Создать беседу", "aria-label": "Создать беседу" }, icon("edit", "sm"))),
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
    const statusText = () => (isGroup ? `${conv.members.length} участников` : conv.user.online ? "в сети"
      : conv.user.last_seen_at ? `был(а) ${timeAgo(conv.user.last_seen_at)}` : "не в сети");
    const body = h("div.chat-body", { role: "log", "aria-live": "polite", "aria-label": `Переписка: ${conv.title}` });
    let myTypingAt = 0;
    const sub = h("div.sub", statusText());
    const ta = attachMentions(h("textarea", { rows: 1, placeholder: conv.can_write ? "Напишите сообщение…" : "Вы не можете написать этому пользователю", maxlength: 4000, disabled: !conv.can_write, "aria-label": "Текст сообщения" }));
    const fit = autosize(ta);
    const send = h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить", disabled: !conv.can_write }, icon("send"));
    const emojiBtn = h("button.btn.ghost.icon-only.emoji-btn.sp-toggle", { type: "button", "aria-label": "Смайлики и стикеры", title: "Смайлики и стикеры", disabled: !conv.can_write }, icon("smile"));
    const attachBtn = h("button.btn.ghost.icon-only.attach-btn", { type: "button", "aria-label": "Прикрепить", title: "Прикрепить: фото, файл, музыку, место или контакт", disabled: !conv.can_write, "aria-haspopup": "menu" }, icon("clip"));
    const pickMedia = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime", multiple: true, hidden: true });
    const pickAudio = h("input", { type: "file", accept: "audio/*,.mp3,.m4a,.ogg,.wav,.flac", multiple: true, hidden: true });
    const pickAny = h("input", { type: "file", multiple: true, hidden: true });
    const micBtn = h("button.btn.primary.icon-only.mic-btn", { type: "button", "aria-label": "Записать голосовое сообщение", title: "Голосовое сообщение", disabled: !conv.can_write }, icon("mic"));
    const ctxBar = h("div.ctx-bar", { hidden: true });
    const form = h("form.chat-form", ctxBar, h("div.chat-input", attachBtn, ta, emojiBtn, send, micBtn), pickMedia, pickAudio, pickAny);
    emojiBtn.before(chatAI({ id, conv, form, ta, fit, body }));
    // реакции-стикеры для меню сообщения (из кэша коллекции — без лишних запросов)
    let reactionStickers = [];
    loadCollection().then((d) => { reactionStickers = d.reactions || []; }).catch(() => {});
    let replyTo = null, editing = null;
    const syncButtons = () => form.classList.toggle("has-text", !!ta.value.trim() || !!editing);
    ta.addEventListener("input", syncButtons);
    function paintCtx() {
      const target = editing || replyTo;
      ctxBar.hidden = !target;
      if (!target) { syncButtons(); return; }
      const who = editing ? "Редактирование" : (target.sender_id === state.me.id ? "Вы" : (chat.senders[target.sender_id]?.name || conv.user?.name || "Собеседник"));
      ctxBar.replaceChildren(icon(editing ? "edit" : "reply"),
        h("button.ctx-body", { type: "button", onclick: () => jumpTo(target.id) }, h("b", who), h("span", previewOf(target))),
        h("button.ctx-close", { type: "button", "aria-label": "Отменить", onclick: () => { if (editing) { ta.value = ""; fit(); } replyTo = null; editing = null; paintCtx(); } }, icon("x", "sm")));
      syncButtons();
    }
    function startReply(m) { editing = null; replyTo = m; paintCtx(); ta.focus(); }
    function startEdit(m) { replyTo = null; editing = m; ta.value = m.text; fit(); paintCtx(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape" && (editing || replyTo)) { e.stopPropagation(); if (editing) { ta.value = ""; fit(); } replyTo = null; editing = null; paintCtx(); } });
    micBtn.addEventListener("click", () => startRecording());
    syncButtons();
    emojiBtn.addEventListener("click", () => openPanel(form, {
      onEmoji: (em) => {
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, pos) + em + ta.value.slice(ta.selectionEnd ?? pos);
        ta.selectionStart = ta.selectionEnd = pos + em.length;
        fit();
        if (!matchMedia("(pointer: coarse)").matches) ta.focus();
      },
      onSticker: (st) => sendSticker(st),
      onGif: (g) => sendGif(g),
    }));
    attachBtn.addEventListener("click", () => showMenu(attachBtn, [
      { label: "Фото или видео", icon: "image", onClick: () => pickMedia.click() },
      { label: "Файл", icon: "clip", onClick: () => pickAny.click() },
      { label: "Музыка", icon: "music", onClick: () => pickAudio.click() },
      { label: "Местоположение", icon: "pin", onClick: () => shareLocation() },
      { label: "Контакт", icon: "user", onClick: () => shareContact() },
      "-",
      { label: "Капсула времени", hint: "Откроется в назначенный момент", icon: "clock", onClick: () => openCapsuleDialog(id).then(addMine) },
      { label: "Колесо решений", hint: "Пусть решит случай", icon: "refresh", onClick: () => openWheelDialog(id).then(addMine) },
    ]));
    pickAny.addEventListener("change", () => { sendFiles([...pickAny.files], "file"); pickAny.value = ""; });
    pickMedia.addEventListener("change", () => { sendFiles([...pickMedia.files]); pickMedia.value = ""; });
    pickAudio.addEventListener("change", () => { sendFiles([...pickAudio.files], "audio"); pickAudio.value = ""; });
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); sendFiles(files); }
    });
    // перетаскивание файлов в окно переписки
    body.addEventListener("dragover", (e) => { if (conv.can_write && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); body.classList.add("drop"); } });
    body.addEventListener("dragleave", () => body.classList.remove("drop"));
    body.addEventListener("drop", (e) => { e.preventDefault(); body.classList.remove("drop"); if (conv.can_write) sendFiles([...e.dataTransfer.files]); });
    // звонки: один на один и в беседах до 4 человек
    const callButtons = () => {
      const n = isGroup ? (conv.members || []).length : 2;
      if (!conv.can_write || n > 4 || (!isGroup && !conv.user?.username)) return null;
      return h("div.chat-calls",
        h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Позвонить", title: "Аудиозвонок", onclick: () => startCall(id, false) }, icon("phone")),
        h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Видеозвонок", title: "Видеозвонок", onclick: () => startCall(id, true) }, icon("video")));
    };
    const groupMenu = isGroup ? h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Настройки беседы", "aria-haspopup": "menu" }, icon("more")) : null;
    // «Чат 2.0»: оформление и касания — в одном меню, чтобы шапка не теснила имя
    const chatExtras = () => [
      { label: "Оформление чата", hint: "Обои, цвет, пузыри, размер текста", icon: "palette", onClick: () => openThemeEditor({ id, conv, pane: chatPane, isGroup }) },
      conv.can_write ? { label: "Касание", hint: "Тук-тук, сердцебиение, обнять", icon: "heart", onClick: () => nudgeMenu(chatMore || groupMenu, id, addMine) } : null,
    ];
    const chatMore = isGroup ? null : h("button.btn.ghost.icon-only.chat-more", { type: "button", "aria-label": "Ещё", "aria-haspopup": "menu" }, icon("more"));
    chatMore?.addEventListener("click", () => showMenu(chatMore, chatExtras()));
    groupMenu?.addEventListener("click", () => showMenu(groupMenu, [
      ...chatExtras(),
      "-",
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
          : conv.user.username ? h("a.name", { href: `/u/${conv.user.username}` }, conv.user.name, vmark(conv.user)) : h("span.name", conv.user.name), sub),
        callButtons(),
        isGroup ? null : chatMore,
        groupMenu),
      body, form);

    chat = { id, conv, body, sub, messages: [], hasMore: false, loadingOlder: false, otherRead: conv.other_last_read_id, typingTimer: null, senders: {} };
    applyChatTheme(chatPane, conv.theme);
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

    const sameGroup = (a, b) => a && b && a.sender_id === b.sender_id && !["system", "nudge"].includes(a.kind) && !["system", "nudge"].includes(b.kind)
      && dayLabel(a.created_at) === dayLabel(b.created_at);
    function msgNode(m, prev, next) {
      const mine = m.sender_id === state.me.id;
      const nodes = [];
      if (!prev || dayLabel(prev.created_at) !== dayLabel(m.created_at)) nodes.push(h("div.day-sep", dayLabel(m.created_at)));
      if (m.kind === "system") { nodes.push(h("div.msg-system", { dataset: { id: m.id } }, m.text)); return nodes; }
      if (m.kind === "nudge") {
        const who = m.sender_id === state.me.id ? "Вы" : (chat.senders[m.sender_id]?.name || conv.user?.name || "Собеседник").split(" ")[0];
        nodes.push(h("div.msg-system.nudge-sys", { dataset: { id: m.id } }, nudgeNode(m, who)));
        return nodes;
      }
      const first = !prev || prev.sender_id !== m.sender_id || ["system", "nudge"].includes(prev.kind) || nodes.length;
      if (isGroup && !mine && first) {
        const snd = chat.senders[m.sender_id];
        nodes.push(h("div.msg-sender", snd ? avatar(snd, "xs", { presence: false }) : null, snd ? snd.name : "Участник"));
      }
      const meta = h("span.m-meta", m.edited_at && m.kind !== "deleted" ? h("i.edited", "изм.") : null, hm(new Date(m.created_at)),
        mine ? icon(m.pending ? "check" : (m.id <= chat.otherRead ? "checks" : "check")) : null);
      const last = !sameGroup(m, next);
      const big = m.kind === "text" ? isBigEmoji(m.text) : 0;
      const cls = `${mine ? ".mine" : ""}${first ? ".first" : ""}${last ? ".last" : ""}${m.pending ? ".pending" : ""}`;
      let bubble;
      const quote = m.reply ? h("button.msg-quote", { type: "button", onclick: (e) => { e.stopPropagation(); jumpTo(m.reply.id); } },
        h("b", m.reply.sender_id === state.me.id ? "Вы" : (chat.senders[m.reply.sender_id]?.name || conv.user?.name || "Сообщение")),
        h("span", m.reply.text)) : null;
      const reacts = m.reactions?.length ? h("div.msg-reacts", m.reactions.map((r) => h(`button${r.users.includes(state.me.id) ? ".mine" : ""}${r.sticker ? ".st" : ""}`, {
        type: "button", title: r.users.map((u) => (u === state.me.id ? "Вы" : chat.senders[u]?.name || conv.user?.name || "")).join(", "),
        onclick: (e) => { e.stopPropagation(); react(m, r.emoji); },
      }, r.sticker ? stickerEl(r.sticker, { size: 24 }) : r.emoji, r.users.length > 1 ? h("span", String(r.users.length)) : null))) : null;
      if (m.kind === "deleted") {
        bubble = h(`div.msg.deleted${cls}`, { dataset: { id: m.id, sender: m.sender_id } }, h("span.del-text", "🚫 Сообщение удалено"), meta);
      } else if (m.kind === "sticker" && m.media) {
        bubble = h(`div.msg-sticker${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          h("button.sticker-img", { type: "button", title: `Набор «${m.media.pack?.title || ""}»`, onclick: () => showPackPreview(m.media.pack?.slug) },
            stickerEl({ url: m.media.url, format: m.media.format, thumb: m.media.thumb, emoji: m.media.emoji })), meta);
        if (quote) bubble.prepend(quote);
        if (reacts) bubble.append(reacts);
      } else if (m.kind === "gif" && m.media) {
        bubble = h(`div.msg-sticker.msg-gif${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          h("div.gif-img", stickerEl({ url: m.media.url, format: m.media.format === "webm" ? "webm" : "webp" })), h("span.gif-badge", "GIF"), meta);
        if (quote) bubble.prepend(quote);
        if (reacts) bubble.append(reacts);
      } else if (m.kind === "capsule") {
        bubble = h(`div.msg.special-msg.k-capsule${cls}`, { dataset: { id: m.id, sender: m.sender_id } }, quote, capsuleNode(m, { onOpen: () => reveal(m.id) }), reacts, meta);
      } else if (m.kind === "wheel" && m.media) {
        bubble = h(`div.msg.special-msg.k-wheel${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          wheelNode(m, { spin: !!m._live, onRepeat: conv.can_write ? (md) => openWheelDialog(id, md).then(addMine) : null }), reacts, meta);
        m._live = false;
      } else if (big) {
        bubble = h(`div.msg-bigemoji.e${big}${cls}`, { dataset: { id: m.id, sender: m.sender_id } }, h("span", m.text), quote, reacts, meta);
        if (quote) bubble.prepend(quote);
      } else if (m.media && ["file", "location", "contact"].includes(m.kind)) {
        const md = m.media;
        const content = m.kind === "file" ? fileCard(md) : m.kind === "location" ? locationCard(md)
          : contactCard(md, { onMessage: md.user_id === state.me.id ? null : async (u) => {
            try { const c = await api.post("/api/conversations", { user_id: u.id }); navigate(`/messages/${c.id}`); } catch (e) { toastError(e); }
          } });
        bubble = h(`div.msg.media-msg.k-${m.kind}${m.text ? ".with-caption" : ""}${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          quote, content, m.text ? h("div.caption", ...richText(m.text).childNodes) : null, reacts, meta);
      } else if (m.media && ["photo", "video", "audio", "voice"].includes(m.kind)) {
        const md = m.media;
        const content = md.type === "photo"
          ? h("button.chat-photo", { type: "button", "aria-label": "Открыть фото", onclick: () => lightbox([{ url: md.url, alt: m.text || "Фото" }]) },
            h("img", { src: md.thumb || md.url, alt: m.text || "Фото", loading: "lazy", style: md.w && md.h ? { aspectRatio: `${md.w} / ${md.h}` } : {} }))
          : md.type === "video" ? videoPlayer(md) : md.type === "voice" ? voicePlayer(md, m.pending ? null : m.id) : audioPlayer(md, m.pending ? null : m.id);
        bubble = h(`div.msg.media-msg.k-${md.type}${m.text ? ".with-caption" : ""}${cls}`, { dataset: { id: m.id, sender: m.sender_id } },
          quote, content, m.text ? h("div.caption", ...richText(m.text).childNodes) : null, reacts, meta);
      } else {
        bubble = h(`div.msg${cls}`, { dataset: { id: m.id, sender: m.sender_id } });
        if (quote) bubble.append(quote);
        bubble.append(...richText(m.text).childNodes);
        if (reacts) bubble.append(reacts);
        bubble.append(meta);
      }
      if (!m.pending && m.kind !== "deleted") attachMenu(bubble, m);
      if (mine) bubble.title = m.pending ? "Отправляется…" : (m.id <= chat.otherRead ? "Прочитано" : "Доставлено");
      nodes.push(bubble);
      return nodes;
    }
    const dayFloat = h("div.day-float", { "aria-hidden": "true" }, h("span"));
    let dayTimer = 0;
    function syncDayFloat() {
      const seps = body.querySelectorAll(".day-sep");
      let cur = null;
      for (const sep of seps) { if (sep.offsetTop <= body.scrollTop + 6) cur = sep; else break; }
      // плашка нужна, только когда «родной» разделитель дня уже уехал вверх
      const show = !!cur && cur.offsetTop < body.scrollTop - 8;
      dayFloat.firstChild.textContent = cur?.textContent || "";
      dayFloat.classList.toggle("show", show);
      clearTimeout(dayTimer);
      if (show) dayTimer = setTimeout(() => dayFloat.classList.remove("show"), 1600);
    }
    body.addEventListener("scroll", () => requestAnimationFrame(syncDayFloat), { passive: true });
    function drawAll(keepBottomOffset = null) {
      const nodes = [dayFloat];
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

    function addMine(m) {
      if (!m) return;
      m._live = true;
      chat.append(m);
      upsertConv(id, m);
    }
    async function reveal(mid) {
      try {
        const fresh = await api.get(`/api/messages/${mid}`);
        applyUpdate(fresh);
        body.querySelector(`[data-id="${mid}"]`)?.classList.add("capsule-reveal");
        navigator.vibrate?.([20, 40, 60]);
      } catch { /* откроется при следующем входе */ }
    }
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
      // «резонанс»: вы печатаете одновременно
      const together = Date.now() - myTypingAt < 3000;
      sub.textContent = together ? "⚡ печатаете одновременно" : (isGroup && name ? `${name.split(" ")[0]} печатает…` : "печатает…");
      sub.classList.toggle("resonance", together);
      if (together && !sub.dataset.buzzed) { sub.dataset.buzzed = "1"; navigator.vibrate?.(12); setTimeout(() => { delete sub.dataset.buzzed; }, 8000); }
      sub.classList.add("typing");
      clearTimeout(chat.typingTimer);
      chat.typingTimer = setTimeout(() => { sub.textContent = statusText(); sub.classList.remove("typing", "resonance"); }, 3500);
    };
    chat.setOnline = (online) => { if (isGroup) return; conv.user.online = online; if (!sub.classList.contains("typing")) sub.textContent = statusText(); };

    function attachMenu(bubble, m) {
      const open = () => openMsgMenu(m, bubble);
      bubble.addEventListener("contextmenu", (e) => { if (e.target.closest("a, video, audio")) return; e.preventDefault(); open(); });
      let timer = null, sx = 0, sy = 0, swipe = 0, dragging = false;
      bubble.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch") return;
        sx = e.clientX; sy = e.clientY; swipe = 0; dragging = false;
        timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); open(); }, 430);
      });
      // свайп влево — ответить (как в Telegram)
      bubble.addEventListener("touchmove", (e) => {
        if (!conv.can_write) return;
        const t = e.touches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (!dragging && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx < 0) dragging = true;
        if (!dragging) return;
        swipe = Math.max(-80, Math.min(0, dx));
        bubble.style.transform = `translateX(${swipe}px)`;
        bubble.classList.toggle("swipe-ready", swipe <= -56);
      }, { passive: true });
      bubble.addEventListener("touchend", () => {
        if (!dragging) return;
        if (swipe <= -56) { navigator.vibrate?.(8); startReply(m); }
        bubble.style.transition = "transform .2s ease-out";
        bubble.style.transform = "";
        bubble.classList.remove("swipe-ready");
        setTimeout(() => { bubble.style.transition = ""; }, 220);
        dragging = false;
      });
      const cancel = (e) => { if (timer && (!e || e.type !== "pointermove" || Math.hypot(e.clientX - sx, e.clientY - sy) > 10)) { clearTimeout(timer); timer = null; } };
      bubble.addEventListener("pointerup", cancel); bubble.addEventListener("pointercancel", cancel); bubble.addEventListener("pointermove", cancel);
      if (matchMedia("(hover: hover)").matches && conv.can_write) {
        bubble.append(h("button.msg-more", { type: "button", "aria-label": "Действия с сообщением", onclick: (e) => { e.stopPropagation(); open(); } }, icon("smile", "sm")));
      }
    }
    function openMsgMenu(m, bubble) {
      const mine = m.sender_id === state.me.id;
      const canEdit = mine && ["text", "photo", "video", "audio"].includes(m.kind) && Date.now() - new Date(m.created_at) < 48 * 3600 * 1000;
      const current = m.reactions?.find((r) => r.users.includes(state.me.id))?.emoji;
      messageMenu(bubble, {
        onReact: conv.can_write ? (e) => react(m, e) : null,
        stickers: reactionStickers,
        onMore: conv.can_write ? () => openPanel(form, { mode: "reaction", tab: "stickers", onEmoji: (e) => react(m, e), onSticker: (s) => react(m, `st:${s.id}`) }) : null,
        current,
        items: [
          conv.can_write ? { label: "Ответить", icon: "reply", onClick: () => startReply(m) } : null,
          m.text && m.kind !== "sticker" ? { label: "Копировать текст", icon: "copy", onClick: () => navigator.clipboard?.writeText(m.text).then(() => toast("Скопировано", { icon: "check", duration: 1200 })) } : null,
          m.media?.url && m.kind !== "sticker" ? { label: "Открыть файл", icon: "download", onClick: () => window.open(m.media.url, "_blank", "noopener") } : null,
          canEdit ? { label: "Изменить", icon: "edit", onClick: () => startEdit(m) } : null,
          mine ? { label: "Удалить у всех", icon: "trash", danger: true, onClick: () => removeMsg(m) } : null,
          !mine && m.kind !== "deleted" && m.kind !== "system" ? { label: "Пожаловаться", icon: "flag", danger: true, onClick: () => report("message", m.id) } : null,
        ],
      });
    }
    async function react(m, emoji) {
      try { applyUpdate(await api.post(`/api/messages/${m.id}/react`, { emoji })); } catch (e) { toastError(e); }
    }
    async function removeMsg(m) {
      if (!await confirmDialog({ title: "Удалить сообщение?", text: "Оно исчезнет у всех участников переписки.", confirm: "Удалить", danger: true })) return;
      try { applyUpdate(await api.del(`/api/messages/${m.id}`)); } catch (e) { toastError(e); }
    }
    function applyUpdate(msg) {
      const i = chat.messages.findIndex((x) => x.id === msg.id);
      if (i < 0) return;
      chat.messages[i] = msg;
      // обновляем цитаты в ответах на это сообщение
      chat.messages.forEach((x) => { if (x.reply?.id === msg.id) x.reply = { ...x.reply, kind: msg.kind, text: msg.kind === "deleted" ? "Сообщение удалено" : previewOf(msg) }; });
      drawAll(body.scrollHeight - body.scrollTop);
    }
    chat.applyUpdate = applyUpdate;
    function jumpTo(mid) {
      const el = body.querySelector(`[data-id="${mid}"]`);
      if (!el) { toast("Сообщение выше — прокрутите переписку вверх", { duration: 1800 }); return; }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    }

    // ---- голосовые сообщения
    async function startRecording() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Этот браузер не умеет записывать голос", { error: true }); return; }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch {
        toast("Нет доступа к микрофону — разрешите его в настройках браузера", { error: true }); return;
      }
      const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const an = actx.createAnalyser();
      an.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const levels = [];
      const t0 = Date.now();
      const timer = h("span.rec-time", "0:00");
      const live = h("div.rec-live", Array.from({ length: 32 }, () => h("i")));
      const liveBars = [...live.children];
      const recBar = h("div.rec-bar",
        h("button.btn.ghost.icon-only.rec-cancel", { type: "button", "aria-label": "Отменить запись", onclick: () => finish(false) }, icon("trash")),
        h("span.rec-dot"), timer, live,
        h("button.btn.primary.icon-only.rec-send", { type: "button", "aria-label": "Отправить голосовое", onclick: () => finish(true) }, icon("send")));
      form.classList.add("recording");
      form.append(recBar);
      const tick = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        const lvl = Math.sqrt(sum / buf.length);
        levels.push(lvl);
        liveBars.forEach((b, i) => { const v = levels[levels.length - liveBars.length + i] || 0; b.style.transform = `scaleY(${Math.min(1, .12 + v * 5)})`; });
        const sec = (Date.now() - t0) / 1000;
        timer.textContent = fmtDur(sec);
        if (sec >= 300) finish(true); // не длиннее 5 минут
      }, 100);
      rec.start(250);
      let finished = false;
      cleanups.push(() => finish(false)); // ушли со страницы — запись отменяется, микрофон выключается
      function finish(sendIt) {
        if (finished) return;
        finished = true;
        rec.onstop = () => {
          clearInterval(tick);
          stream.getTracks().forEach((t) => t.stop());
          actx.close().catch(() => {});
          recBar.remove();
          form.classList.remove("recording");
          if (!sendIt) return;
          const dur = (Date.now() - t0) / 1000;
          if (dur < .8) { toast("Слишком короткое сообщение — удерживайте запись дольше"); return; }
          const type = rec.mimeType || mime || "audio/webm";
          const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
          const file = new File([new Blob(chunks, { type })], `voice.${ext}`, { type });
          uploadOne(file, "voice", { duration: dur, waveform: downsampleLevels(levels) });
        };
        rec.stop();
      }
    }

    async function sendGif(g) {
      try {
        const m = await api.post(`/api/conversations/${id}/messages`, { gif_id: g.id, reply_to: replyTo?.id });
        replyTo = null; paintCtx();
        chat.append(m);
        upsertConv(id, m);
      } catch (err) { toastError(err); }
    }

    async function sendSticker(st) {
      try {
        const m = await api.post(`/api/conversations/${id}/messages`, { sticker_id: st.id, reply_to: replyTo?.id });
        replyTo = null; paintCtx();
        chat.append(m);
        upsertConv(id, m);
      } catch (err) { toastError(err); }
    }

    // ---- вложения: фото, видео, музыка — с прогрессом загрузки
    async function postShare(payload) {
      if (replyTo) { payload.reply_to = replyTo.id; replyTo = null; paintCtx(); }
      try {
        const m = await api.post(`/api/conversations/${id}/share`, payload);
        chat.append(m);
        upsertConv(id, m);
      } catch (e) { toastError(e); }
    }
    async function shareLocation() {
      if (!navigator.geolocation) return toast("Браузер не умеет определять местоположение", { error: true });
      const t = toast("Определяю местоположение…", { duration: 2500 });
      navigator.geolocation.getCurrentPosition(async (pos) => {
        t?.remove?.();
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        if (!await confirmDialog({ title: "Отправить ваше местоположение?", text: `Собеседник увидит точку на карте (точность ±${Math.round(accuracy)} м).`, confirm: "Отправить" })) return;
        postShare({ type: "location", lat, lon, acc: Math.round(accuracy) });
      }, (err) => {
        t?.remove?.();
        toast(err.code === 1 ? "Нет доступа к геопозиции — разрешите его в настройках браузера" : "Не удалось определить местоположение", { error: true });
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    }
    async function shareContact() {
      const ids = await pickFriends({ title: "Поделиться контактом", confirm: "Отправить", min: 1 });
      for (const uid of ids || []) await postShare({ type: "contact", user_id: uid });
    }
    async function sendFiles(files, forceType = null) {
      for (const file of files.slice(0, 10)) {
        // фото/видео/музыка — то, что сайт умеет показывать сам; всё остальное уходит обычным файлом
        const t = file.type;
        const type = forceType || (/^image\/(jpeg|png|webp|gif)$/.test(t) ? "photo" : /^video\/(mp4|webm|quicktime)$/.test(t) ? "video"
          : /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|ogg|wav|x-wav|wave|flac|x-flac)$/.test(t) ? "audio" : "file");
        const limitMb = type === "video" ? 30 : type === "audio" ? 15 : type === "file" ? 25 : 10;
        if (file.size > limitMb * 1024 * 1024) { toast(`«${file.name}» больше ${limitMb} МБ`, { error: true }); continue; }
        await uploadOne(file, type);
      }
    }
    async function uploadOne(file, type, extra = {}) {
      const fd = new FormData();
      fd.append("type", type);
      if (replyTo) { fd.append("reply_to", String(replyTo.id)); replyTo = null; paintCtx(); }
      const caption = ta.value.trim();
      if (caption) { fd.append("caption", caption); ta.value = ""; fit(); }
      const localUrl = type === "audio" || type === "voice" || type === "file" ? null : URL.createObjectURL(file);
      const ring = h("span.up-ring", { style: { "--p": "0" } }, h("b", "0%"));
      const cancel = h("button.up-cancel", { type: "button", "aria-label": "Отменить загрузку" }, icon("x", "sm"));
      const card = h("div.msg.mine.media-msg.uploading.first.last",
        type === "photo" ? h("img.up-preview", { src: localUrl, alt: "" })
          : type === "video" ? h("video.up-preview", { src: localUrl, muted: true, playsinline: true })
            : type === "file" ? h("div.up-audio.up-file", fileIcon(file.name.includes(".") ? file.name.split(".").pop() : ""), h("span", file.name))
              : h("div.up-audio", icon(type === "voice" ? "mic" : "music"), h("span", type === "voice" ? `Голосовое · ${fmtDur(extra.duration)}` : file.name)),
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
        } else if (type === "voice") {
          fd.append("duration", String(extra.duration));
          fd.append("waveform", JSON.stringify(extra.waveform || []));
        } else if (type === "audio") {
          const meta = await audioMeta(file);
          if (Number.isFinite(meta.duration)) fd.append("duration", String(meta.duration));
          const t = parseTrackName(file.name);
          fd.append("title", t.title); if (t.artist) fd.append("artist", t.artist);
          const wave = await audioWaveform(file);
          if (wave.length) fd.append("waveform", JSON.stringify(wave));
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
      myTypingAt = Date.now();
      if (Date.now() - lastTyping > 2500 && ta.value.trim()) {
        lastTyping = Date.now();
        api.post(`/api/conversations/${id}/typing`).catch(() => {});
      }
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (editing) {
        const m0 = editing;
        if (!text && m0.kind === "text") return;
        editing = null; ta.value = ""; fit(); paintCtx();
        try { applyUpdate(await api.patch(`/api/messages/${m0.id}`, { text })); } catch (err) { toastError(err); }
        return;
      }
      if (!text) return;
      ta.value = ""; fit();
      const reply = replyTo;
      replyTo = null; paintCtx();
      const temp = { id: Number.MAX_SAFE_INTEGER - Date.now(), sender_id: state.me.id, text, created_at: new Date().toISOString(), pending: true,
        reply: reply ? { id: reply.id, sender_id: reply.sender_id, text: previewOf(reply) } : null };
      chat.append(temp);
      try {
        const m = await api.post(`/api/conversations/${id}/messages`, { text, reply_to: reply?.id });
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
      if (message.sender_id !== state.me.id) {
        message._live = true;
        if (message.kind === "nudge") playNudge(message.media?.type, (sender?.name || "").split(" ")[0]);
      }
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
  cleanups.push(on("message_update", (msg) => {
    if (chat && chat.id === msg.conversation_id) chat.applyUpdate(msg);
    const c = convs.find((x) => x.id === msg.conversation_id);
    if (c?.last_message?.id === msg.id) { c.last_message = msg; drawList(); }
  }));
  cleanups.push(on("conv_theme", (d) => {
    if (!chat || chat.id !== d.conversation_id) return;
    Object.assign(chat.conv, { theme: d.theme, shared: d.shared, own: d.own });
    applyChatTheme(chatPane, d.theme);
    toast(`${d.by} поменял(а) оформление чата 🎨`, { icon: "palette" });
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
  // связь восстановилась — догружаем то, что пришло, пока её не было
  let streamOpens = 0;
  cleanups.push(on("stream-open", async () => {
    if (streamOpens++ === 0) return;
    loadList();
    if (!chat) return;
    try {
      const res = await api.get(`/api/conversations/${chat.id}/messages`);
      const known = new Set(chat.messages.map((x) => x.id));
      Object.assign(chat.senders, res.senders || {});
      res.items.filter((x) => !known.has(x.id)).forEach((x) => chat.append(x));
      chat.markRead();
    } catch { /* попробуем при следующем подключении */ }
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
