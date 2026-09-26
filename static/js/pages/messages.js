// Личные сообщения в реальном времени: список диалогов и окно переписки.
import { api, state, on, setCounters } from "../api.js";
import { h, icon, avatar, shortTime, hm, dayLabel, richText, autosize } from "../dom.js";
import { setTitle, toastError } from "../ui.js";
import { setCleanup, navigate } from "../router.js";

export async function messagesPage({ params }) {
  setTitle("Сообщения");
  const activeId = params.id ? Number(params.id) : null;
  const layout = h(`div.card.chat-layout${activeId ? ".has-chat" : ""}`);
  const listEl = h("div", { role: "list" });
  const listPane = h("div.chat-list", h("div.chat-list-head", h("h1", { style: { fontSize: "20px" } }, "Сообщения")), listEl);
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
      avatar(c.user),
      h("div.who",
        h("div.top", h("span.name", c.user.name), last ? h("span.time", shortTime(last.created_at)) : null),
        h("div.preview-text",
          mine ? icon(last.id <= c.other_last_read_id ? "checks" : "check", "sm") : null,
          h("span.grow", last ? `${mine ? "Вы: " : ""}${last.text}` : "Нет сообщений"),
          c.unread ? h("span.badge", String(c.unread)) : null)));
  }
  function drawList() {
    if (!convs.length) {
      listEl.replaceChildren(h("div.empty", icon("message"), h("h3", "Диалогов пока нет"),
        h("p", "Откройте профиль друга и нажмите «Написать»."), h("a.btn.soft.sm", { href: "/friends" }, "К списку друзей")));
      return;
    }
    listEl.replaceChildren(...convs.map(convItem));
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
    setTitle(conv.user.name);
    const body = h("div.chat-body", { role: "log", "aria-live": "polite", "aria-label": `Переписка с ${conv.user.name}` });
    const sub = h("div.sub", conv.user.online ? "в сети" : "не в сети");
    const ta = h("textarea", { rows: 1, placeholder: conv.can_write ? "Напишите сообщение…" : "Вы не можете написать этому пользователю", maxlength: 4000, disabled: !conv.can_write, "aria-label": "Текст сообщения" });
    const fit = autosize(ta);
    const send = h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить", disabled: !conv.can_write }, icon("send"));
    const form = h("form.chat-form", ta, send);
    chatPane.replaceChildren(
      h("header.chat-head",
        h("a.btn.ghost.icon-only.back", { href: "/messages", "aria-label": "К списку диалогов" }, icon("back")),
        conv.user.username ? h("a", { href: `/u/${conv.user.username}`, "aria-label": conv.user.name }, avatar(conv.user)) : avatar(conv.user),
        h("div.who", conv.user.username ? h("a.name", { href: `/u/${conv.user.username}` }, conv.user.name) : h("span.name", conv.user.name), sub)),
      body, form);

    chat = { id, conv, body, sub, messages: [], hasMore: false, loadingOlder: false, otherRead: conv.other_last_read_id, typingTimer: null };

    function msgNode(m, prev) {
      const mine = m.sender_id === state.me.id;
      const nodes = [];
      if (!prev || dayLabel(prev.created_at) !== dayLabel(m.created_at)) nodes.push(h("div.day-sep", dayLabel(m.created_at)));
      const first = !prev || prev.sender_id !== m.sender_id || nodes.length;
      const meta = h("span.m-meta", hm(new Date(m.created_at)), mine ? icon(m.pending ? "check" : (m.id <= chat.otherRead ? "checks" : "check")) : null);
      const bubble = h(`div.msg${mine ? ".mine" : ""}${first ? ".first" : ""}${m.pending ? ".pending" : ""}`, { dataset: { id: m.id } });
      bubble.append(...richText(m.text).childNodes, meta);
      if (mine) bubble.title = m.pending ? "Отправляется…" : (m.id <= chat.otherRead ? "Прочитано" : "Доставлено");
      nodes.push(bubble);
      return nodes;
    }
    function drawAll(keepBottomOffset = null) {
      const nodes = [];
      if (chat.hasMore) nodes.push(h("button.btn.ghost.sm", { type: "button", style: { alignSelf: "center" }, onclick: loadOlder }, "Показать ранние сообщения"));
      if (!chat.messages.length) nodes.push(h("div.chat-empty", h("div.empty", avatar(conv.user, "lg"), h("h3", conv.user.name), h("p", "Напишите первое сообщение 👋"))));
      chat.messages.forEach((m, i) => nodes.push(...msgNode(m, chat.messages[i - 1])));
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
      body.append(...msgNode(m, prev));
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
    chat.showTyping = () => {
      sub.textContent = "печатает…";
      sub.classList.add("typing");
      clearTimeout(chat.typingTimer);
      chat.typingTimer = setTimeout(() => { sub.textContent = conv.user.online ? "в сети" : "не в сети"; sub.classList.remove("typing"); }, 3500);
    };
    chat.setOnline = (online) => { conv.user.online = online; if (!sub.classList.contains("typing")) sub.textContent = online ? "в сети" : "не в сети"; };

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
      drawAll();
      chat.markRead();
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
    if (matchMedia("(min-width: 900px)").matches) ta.focus();
  }

  function upsertConv(id, m) {
    let c = convs.find((x) => x.id === id);
    if (!c) { loadList(); return; }
    c.last_message = m;
    if (m.sender_id !== state.me.id && id !== chat?.id) c.unread = (c.unread || 0) + 1;
    convs = [c, ...convs.filter((x) => x !== c)];
    drawList();
  }

  // ---------------------------------------------------------------- События
  cleanups.push(on("message", ({ message }) => {
    const id = message.conversation_id;
    if (chat && chat.id === id) {
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
  cleanups.push(on("typing", ({ conversation_id }) => { if (chat && chat.id === conversation_id) chat.showTyping(); }));
  cleanups.push(on("read", ({ conversation_id, last_read_id }) => {
    const c = convs.find((x) => x.id === conversation_id);
    if (c) { c.other_last_read_id = last_read_id; drawList(); }
    if (chat && chat.id === conversation_id) { chat.otherRead = last_read_id; chat.refreshTicks(); }
  }));
  cleanups.push(on("presence", ({ user_id, online }) => {
    convs.forEach((c) => { if (c.user.id === user_id) c.user.online = online; });
    if (chat && chat.conv.user.id === user_id) chat.setOnline(online);
  }));
  const onVisible = () => { if (document.visibilityState === "visible" && chat) chat.markRead(); };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

  await loadList();
  if (activeId) openChat(activeId);
  else chatPane.replaceChildren(h("div.chat-empty", h("div.empty", icon("message"), h("h3", "Выберите диалог"), h("p", "Или начните новый со страницы друга."))));
  api.get("/api/counters").then(setCounters).catch(() => {});
  return layout;
}

export { navigate };
