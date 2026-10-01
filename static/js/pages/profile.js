// Страница пользователя: обложка, аватар, информация, записи, фото, друзья.
import { api, state, on } from "../api.js";
import { h, icon, avatar, vmark, pl, birthDate, joinedDate, timeAgo } from "../dom.js";
import { decorate, pet, mountEffect, itemBadge } from "../components/cosmetics.js";
import { infiniteList, setTitle, toast, toastError, showMenu, confirmDialog, promptDialog, lightbox, modal } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { composer } from "../components/composer.js";
import { postCard, report } from "../components/post.js";
import { friendButton, openChat, personRow, defaultPersonActions } from "../components/people.js";
import { uploadProfileImage } from "./settings.js";
import { constellationSpark, constellationBlock } from "../components/constellation.js";
import { openSpaceEditor, SPACE_MODES } from "../components/space.js";
import { cityView } from "../components/city.js";

export async function profilePage({ params, query }) {
  let offPosted = null;
  const data = await api.get(`/api/users/${encodeURIComponent(params.username)}`);
  const u = data.user;
  const isMe = u.id === state.me.id;
  setTitle(u.name);

  if (data.blocked) {
    return h("div.card.empty", icon("block"), h("h3", u.name), h("p", "Страница недоступна."));
  }

  const root = h("div.stack.profile-space");
  const header = h("section.card.profile-card");
  // пространство профиля: режим и видимые блоки выбирает владелец
  let space = data.space || { mode: "classic", order: [], hidden: [] };
  const shown = (b) => !space.hidden.includes(b);
  const extras = h("div.stack.space-blocks");
  const tabBar = h("div.tabs", { role: "tablist" });
  const content = h("div");
  const tabsCard = h("div.card", tabBar);
  root.append(header, extras, tabsCard, content);
  root.dataset.mode = space.mode;
  document.addEventListener("constellation:changed", (e) => { if (isMe && root.isConnected) { data.constellation = e.detail; renderHeader(); } });

  let renderHeader = function () {
    const rel = data.relation;
    const cover = h("div.cover", data.cover ? h("img", { src: data.cover, alt: "" }) : null,
      isMe ? h("button.btn.sm.cover-btn", { type: "button", onclick: () => uploadProfileImage("cover", (url) => { data.cover = url; renderHeader(); }) }, icon("camera", "sm"), h("span.cover-btn-text", data.cover ? "Изменить обложку" : "Добавить обложку")) : null);

    const actions = h("div.profile-actions");
    const adminItems = data.can_verify ? ["-", u.verified
      ? { label: "Снять галочку", icon: "x", danger: true, onClick: revokeVerify }
      : { label: "Выдать галочку", icon: "check", onClick: grantVerify }] : [];
    if (isMe) {
      actions.append(h("a.btn.outline", { href: "/settings", title: "Редактировать профиль" }, icon("edit", "sm"), h("span.pa-full", "Редактировать профиль"), h("span.pa-short", "Изменить")));
      actions.append(h("a.btn.soft.stats-btn", { href: "/stats", title: "Личная статистика" }, icon("chart", "sm"), h("span", "Статистика")));
      actions.append(h("button.btn.ghost.icon-only.space-btn", { type: "button", "aria-label": "Настроить пространство", title: "Настроить пространство",
        onclick: () => openSpaceEditor(space, (next) => { space = next; root.dataset.mode = space.mode; renderHeader(); }) }, icon("settings")));
      if (data.can_verify) {
        const more = h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Ещё", "aria-haspopup": "menu" }, icon("more"));
        more.addEventListener("click", () => showMenu(more, adminItems.slice(1)));
        actions.append(more);
      }
    } else {
      if (!rel.blocked_by_me) {
        if (u.verified && !rel.following && rel.status !== "friends") {
          actions.append(h("button.btn.primary.follow-official", { type: "button", onclick: () => follow(true) }, icon("bell", "sm"), "Подписаться"));
        }
        actions.append(friendButton(u, rel, (r) => { data.relation = r; renderHeader(); }));
        if (data.can_message) actions.append(h("button.btn.soft", { type: "button", onclick: () => openChat(u.id) }, icon("message", "sm"), "Написать"));
      } else {
        actions.append(h("button.btn.outline", { type: "button", onclick: () => toggleBlock(false) }, "Разблокировать"));
      }
      const more = h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Ещё", "aria-haspopup": "menu" }, icon("more"));
      more.addEventListener("click", () => showMenu(more, [
        !rel.blocked_by_me && rel.status !== "friends" ? (rel.following
          ? { label: "Отписаться", icon: "x", onClick: () => follow(false) }
          : { label: "Подписаться на записи", icon: "bell", onClick: () => follow(true) }) : null,
        { label: "Скопировать ссылку", icon: "link", onClick: () => { navigator.clipboard?.writeText(location.href); toast("Ссылка скопирована", { icon: "link" }); } },
        "-",
        rel.blocked_by_me ? { label: "Разблокировать", icon: "block", onClick: () => toggleBlock(false) }
          : { label: "Заблокировать", icon: "block", danger: true, onClick: () => toggleBlock(true) },
        { label: "Пожаловаться", icon: "flag", danger: true, onClick: () => report("user", u.id) },
        ...adminItems,
      ]));
      actions.append(more);
    }

    const eq = data.equipped || {};
    const av = decorate(avatar(u, "xl"), eq);
    const avatarWrap = h(`div.avatar-slot${eq.frame ? ".has-frame" : ""}`, { style: { position: "relative" } },
      data.user.avatar ? h("button", { type: "button", style: { border: 0, padding: 0, background: "none", borderRadius: "50%" }, "aria-label": "Открыть фото профиля", onclick: () => lightbox([{ url: data.user.avatar, alt: u.name }]) }, av) : av,
      eq.pet ? pet(eq.pet) : null,
      isMe ? h("button.avatar-edit", { type: "button", "aria-label": "Изменить фото профиля", onclick: () => uploadProfileImage("avatar", (url) => { data.user.avatar = url; state.me.avatar = url; renderHeader(); }) }, icon("camera", "sm")) : null);

    const info = [];
    if (!data.hidden) {
      if (data.city) info.push(h("span", icon("pin"), data.city));
      if (data.work) info.push(h("span", icon("work"), data.work));
      if (data.school) info.push(h("span", icon("book"), data.school + (data.school_year ? `, ${data.school_year}` : "")));
      if (data.university) info.push(h("span", icon("book"), data.university + (data.university_year ? `, ${data.university_year}` : "")));
      if (data.education && !data.school && !data.university) info.push(h("span", icon("book"), data.education));
      if (data.birth_date) info.push(h("span", icon("gift"), birthDate(data.birth_date)));
      if (data.relationship) info.push(h("span", icon("heartRel"), data.relationship));
    }
    info.push(h("span", icon("calendar"), `С нами ${joinedDate(data.joined_at)}`));

    const statusText = u.online ? "в сети" : null;
    if (eq.effect) mountEffect(cover, eq.effect);
    header.replaceChildren(cover,
      h("div.profile-main",
        h("div.profile-top", avatarWrap, actions),
        h("div.profile-name",
          h("h1", u.name, vmark(u), shown("constellation") ? constellationSpark(u, data.constellation, isMe) : null, statusText ? h("span.status-pill.online", statusText) : null,
            !isMe && rel.follows_you && rel.status !== "friends" ? h("span.status-pill", "подписан(а) на вас") : null),
          h("div.handle", `@${u.username}`, u.badge ? h("span.official-chip", u.badge) : null),
          statusChip()),
        u.ai ? personaBox() : null,
        shown("about") && data.bio && !data.hidden ? h("p.profile-bio", data.bio) : null,
        !shown("about") ? null : (info.length > 3 && space.mode !== "professional") ? h("div.profile-info.collapsible", ...info,
          h("button.info-more", { type: "button", onclick: (ev) => { ev.currentTarget.parentElement.classList.add("open"); ev.currentTarget.remove(); } }, "Подробнее…"))
          : h("div.profile-info", info),
        shown("showcase") ? showcaseRow() : null,
        h("div.profile-counts",
          stat(data.counts.posts, ["запись", "записи", "записей"], () => selectTab("posts")),
          stat(data.counts.friends, ["друг", "друга", "друзей"], () => selectTab("friends")),
          stat(data.counts.followers, ["подписчик", "подписчика", "подписчиков"], () => showFollows("followers")),
          stat(data.counts.following, ["подписка", "подписки", "подписок"], () => showFollows("following")),
          data.counts.invited ? stat(data.counts.invited, ["приглашение", "приглашения", "приглашений"],
            () => navigate(isMe ? "/invite?tab=tree" : "/invite?tab=board")) : null),
        !isMe && data.mutual_friends ? h("div.mutual-line", icon("users", "sm"), pl(data.mutual_friends, ["общий друг", "общих друга", "общих друзей"])) : null));
  }

  function personaBox() {
    const box = h("div.persona-box");
    api.get(`/api/world/persona/${encodeURIComponent(u.username)}`).then((p) => {
      box.style.setProperty("--oc", p.org.color);
      box.replaceChildren(
        h("span.pb-org", h("span", p.org.emoji), h("b", p.org.name), h("small", p.role)),
        !isMe ? h("div.pb-rel", h("span", `Ваше звание: `, h("b", p.title), ` (${p.rep})`), p.closeness ? h("span", `💜 близость ${p.closeness}`) : null) : null,
        p.facts?.length ? h("div.pb-facts", h("small", "Помнит о вас: "), p.facts.join(" · ")) : null);
    }).catch(() => box.remove());
    return box;
  }

  function stat(n, forms, onClick) {
    if (n == null) return null;
    return h("button.stat", { type: "button", onclick: onClick }, h("b", String(n)), h("span", pl(n, forms).split(" ")[1]));
  }

  function statusChip() {
    const st = u.status;
    if (st) {
      return h(isMe ? "button.profile-status" : "div.profile-status", isMe ? { type: "button", onclick: editStatus, title: "Изменить статус" } : {},
        st.emoji ? h("span.ps-emoji", st.emoji) : null, st.text ? h("span", st.text) : null);
    }
    return isMe ? h("button.profile-status.empty", { type: "button", onclick: editStatus }, "＋ Статус") : null;
  }

  function editStatus() {
    const PRESETS = [["🏖", "В отпуске"], ["💼", "На работе"], ["📚", "Учусь"], ["🏃", "На тренировке"], ["🎮", "Играю"],
      ["🎧", "Слушаю музыку"], ["✈️", "В дороге"], ["🤒", "Болею"], ["😴", "Сплю"], ["🎉", "Праздную"], ["☕", "Пью кофе"], ["🔕", "Не беспокоить"]];
    const EMOJI = "😊 😎 🥳 😴 🤔 😍 🔥 ❤️ 💼 📚 🏖 ✈️ 🎮 🎧 🏃 ☕ 🍕 🎬 🤒 🔕".split(" ");
    let emoji = u.status?.emoji || "😊";
    let hours = 24;
    const text = h("input.input", { maxlength: 60, placeholder: "Что у вас происходит?", value: u.status?.text || "" });
    const emojiRow = h("div.st-emoji");
    const paintEmoji = () => emojiRow.replaceChildren(...EMOJI.map((e) => h(`button${e === emoji ? ".on" : ""}`, { type: "button", onclick: () => { emoji = e; paintEmoji(); } }, e)));
    paintEmoji();
    const dur = h("div.segmented.st-dur");
    const paintDur = () => dur.replaceChildren(...[[1, "1 час"], [4, "4 часа"], [24, "Сутки"], [168, "Неделя"], [0, "Всегда"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(v === hours), onclick: () => { hours = v; paintDur(); } }, t)));
    paintDur();
    const save = h("button.btn.primary", { type: "button" }, "Сохранить");
    const m = modal({
      title: "Статус", narrow: true,
      body: h("div.stack.status-editor",
        h("div.st-presets", PRESETS.map(([e, t]) => h("button", { type: "button", onclick: () => { emoji = e; text.value = t; paintEmoji(); } }, h("span", e), t))),
        emojiRow, text,
        h("div.field", h("label", "Показывать"), dur)),
      footer: [
        u.status ? h("button.btn.ghost", { type: "button", onclick: async () => {
          try { await api.del("/api/me/status"); u.status = null; m.close(); renderHeader(); } catch (e) { toastError(e); }
        } }, "Убрать") : h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"),
        save],
    });
    save.addEventListener("click", async () => {
      try {
        const res = await api.patch("/api/me/status", { emoji, text: text.value, hours });
        u.status = res.status; m.close(); renderHeader();
        toast("Статус обновлён", { icon: "check", duration: 1500 });
      } catch (e) { toastError(e); }
    });
  }

  function showcaseRow() {
    const owned = data.showcase?.owned || [];
    if (!owned.length) return null;
    return h("div.showcase",
      h("span.showcase-label", "Коллекция"),
      ...owned.slice(0, 10).map((it) => h(`span.showcase-item.${it.rarity}`, { title: `${it.name} · ${it.rarity_label}` },
        itemBadge(it))),
      owned.length > 10 ? h("span.showcase-more", `+${owned.length - 10}`) : null,
      h("span.showcase-count", `${owned.length}/${data.showcase.total}`));
  }

  async function grantVerify() {
    try {
      const res = await api.post(`/api/admin/users/${u.id}/verify`, { badge: u.badge || "" });
      Object.assign(data.user, res.user);
      toast(`${u.name} получил(а) галочку`, { icon: "check" });
      renderHeader();
    } catch (e) { toastError(e); }
  }

  async function revokeVerify() {
    if (!await confirmDialog({ title: `Снять галочку у ${u.name}?`, confirm: "Снять", danger: true })) return;
    try {
      const res = await api.del(`/api/admin/users/${u.id}/verify`);
      Object.assign(data.user, res.user);
      toast("Галочка снята");
      renderHeader();
    } catch (e) { toastError(e); }
  }

  async function follow(onoff) {
    try {
      const res = onoff ? await api.post(`/api/people/${u.id}/follow`) : await api.del(`/api/people/${u.id}/follow`);
      data.relation = res.relation;
      toast(onoff ? "Вы подписались" : "Вы отписались", { icon: "check" });
      renderHeader();
    } catch (e) { toastError(e); }
  }

  async function toggleBlock(onoff) {
    if (onoff && !await confirmDialog({ title: `Заблокировать ${u.name}?`, text: "Вы перестанете видеть записи друг друга, дружба и подписки будут удалены, писать вам этот человек не сможет.", confirm: "Заблокировать", danger: true })) return;
    try {
      const res = onoff ? await api.post(`/api/people/${u.id}/block`) : await api.del(`/api/people/${u.id}/block`);
      data.relation = res.relation;
      data.can_message = !onoff;
      toast(onoff ? "Пользователь заблокирован" : "Пользователь разблокирован");
      renderHeader();
      if (onoff) content.replaceChildren(h("div.card.locked", icon("block"), h("p", "Вы заблокировали этого пользователя.")));
      else selectTab(current);
    } catch (e) { toastError(e); }
  }

  async function showFollows(kind) {
    const body = h("div", h("div.spinner"));
    modal({ title: kind === "followers" ? "Подписчики" : "Подписки", body, narrow: true });
    try {
      const { items, hidden } = await api.get(`/api/users/${u.username}/follows`, { type: kind });
      if (hidden) body.replaceChildren(h("p.muted", "Пользователь скрыл этот список."));
      else if (!items.length) body.replaceChildren(h("p.muted", "Пока никого нет."));
      else body.replaceChildren(h("div.people", { style: { margin: "0 -16px" } }, items.map((p) => personRow(p, defaultPersonActions))));
    } catch (e) { body.replaceChildren(h("p.muted", e.message)); }
  }

  // ---- вкладки
  const TABS = [
    { id: "posts", label: "Записи", icon: "edit" },
    { id: "city", label: "Город", icon: "city" },
    { id: "photos", label: "Фото", icon: "image" },
    { id: "friends", label: "Друзья", icon: "users" },
  ];
  let current = null;

  function locked(text) {
    return h("div.card.locked", icon("lock"), h("b", text), h("p", "Добавьте пользователя в друзья, чтобы видеть его записи."));
  }

  function selectTab(id) {
    current = id;
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    const url = id === "posts" ? location.pathname : `${location.pathname}?tab=${id}`;
    history.replaceState({}, "", url);
    if (data.hidden && !isMe && id !== "friends") { content.replaceChildren(locked("Это закрытый профиль")); return; }

    if (id === "posts") {
      const wrap = h("div.stack");
      if (isMe) wrap.append(h("div.card", composer({ placeholder: "Что у вас нового?" })));
      const card = h("div.card.feed");
      const list = infiniteList({
        load: (cursor) => api.get(`/api/users/${u.username}/posts`, { cursor }),
        render: (p) => postCard(p),
        empty: h("div.card.empty", icon("edit"), h("h3", "Записей пока нет"), isMe ? h("p", "Расскажите друзьям, что у вас нового!") : null),
        container: card,
      });
      wrap.append(list.el);
      content.replaceChildren(wrap);
      if (isMe) { offPosted?.(); offPosted = on("post-created", (p) => { list.prepend(postCard(p)); data.counts.posts = (data.counts.posts || 0) + 1; }); }
    } else if (id === "city") {
      content.replaceChildren(cityView(u, isMe, data.constellation));
    } else if (id === "photos") {
      const grid = h("div.photo-grid");
      const all = [];
      const list = infiniteList({
        load: (cursor) => api.get(`/api/users/${u.username}/photos`, { cursor }),
        render: (m) => {
          all.push(m);
          const idx = all.length - 1;
          return h("button", { type: "button", "aria-label": m.alt || "Фото", onclick: () => lightbox(all, idx) }, h("img", { src: m.thumb, alt: m.alt || "", loading: "lazy" }));
        },
        empty: h("div.empty", icon("image"), h("h3", "Фотографий пока нет")),
        container: grid,
      });
      content.replaceChildren(h("div.card", { style: { overflow: "hidden" } }, list.el));
    } else if (id === "reels") {
      const grid = h("div.reel-grid");
      const list = infiniteList({
        load: (cursor) => api.get("/api/reels", { cursor, user: u.username }),
        render: (r) => h("a.reel-tile", { href: `/reels/${r.id}?user=${encodeURIComponent(u.username)}`, "aria-label": r.caption || "Клип" },
          r.poster ? h("img", { src: r.poster, alt: "", loading: "lazy" }) : h("span.reel-tile-ph", icon("film")),
          h("span.reel-tile-views", icon("play", "sm"), String(r.views))),
        empty: h("div.empty", icon("film"), h("h3", "Клипов пока нет"),
          isMe ? h("a.btn.primary.sm", { href: "/reels" }, "Снять первый клип") : null),
        container: grid,
      });
      content.replaceChildren(h("div.card", { style: { overflow: "hidden" } }, list.el));
    } else {
      const box = h("div.card", h("div.spinner"));
      content.replaceChildren(box);
      api.get(`/api/users/${u.username}/friends`).then(({ items, hidden }) => {
        if (hidden) return box.replaceChildren(h("div.locked", icon("lock"), h("b", "Список друзей скрыт")));
        if (!items.length) return box.replaceChildren(h("div.empty", icon("users"), h("h3", "Друзей пока нет")));
        const filter = h("input.input", { type: "search", placeholder: "Поиск среди друзей", "aria-label": "Поиск среди друзей" });
        const list = h("div.people");
        const draw = () => {
          const q = filter.value.trim().toLowerCase();
          list.replaceChildren(...items.filter((p) => !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)).map((p) => personRow(p, defaultPersonActions)));
        };
        filter.addEventListener("input", draw);
        draw();
        box.replaceChildren(h("div.card-pad", { style: { paddingBottom: "4px" } }, h("div.card-title", `${pl(items.length, ["друг", "друга", "друзей"])}`), filter), list);
      }).catch((e) => box.replaceChildren(h("p.muted.card-pad", e.message)));
    }
  }

  tabBar.append(...TABS.map((t) => h("button", { type: "button", role: "tab", dataset: { tab: t.id }, onclick: () => selectTab(t.id) }, icon(t.icon, "sm"), t.label)));
  const _renderHeader = renderHeader;
  renderHeader = function () {
    _renderHeader();
    const blocks = { constellation: () => (!data.hidden && shown("constellation") ? constellationBlock(u, data.constellation, isMe) : null) };
    extras.replaceChildren(...space.order.filter((b) => blocks[b]).map((b) => blocks[b]()).filter(Boolean));
  };
  renderHeader();
  const firstTab = SPACE_MODES[space.mode]?.tab;
  selectTab(TABS.some((t) => t.id === query.tab) ? query.tab : (firstTab && TABS.some((t) => t.id === firstTab) ? firstTab : "posts"));

  // статус «в сети» обновляется в реальном времени
  const offPresence = on("presence", ({ user_id, online }) => {
    if (user_id === u.id && root.isConnected) { data.user.online = online; renderHeader(); }
  });
  setCleanup(() => { offPresence(); offPosted?.(); });
  return root;
}

export { navigate, timeAgo };
