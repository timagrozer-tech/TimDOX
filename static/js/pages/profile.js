// Страница пользователя: обложка, аватар, информация, записи, фото, друзья.
import { api, state, on } from "../api.js";
import { h, icon, avatar, pl, birthDate, joinedDate, timeAgo } from "../dom.js";
import { infiniteList, setTitle, toast, toastError, showMenu, confirmDialog, lightbox, modal } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { composer } from "../components/composer.js";
import { postCard, report } from "../components/post.js";
import { friendButton, openChat, personRow, defaultPersonActions } from "../components/people.js";
import { uploadProfileImage } from "./settings.js";

export async function profilePage({ params, query }) {
  const data = await api.get(`/api/users/${encodeURIComponent(params.username)}`);
  const u = data.user;
  const isMe = u.id === state.me.id;
  setTitle(u.name);

  if (data.blocked) {
    return h("div.card.empty", icon("block"), h("h3", u.name), h("p", "Страница недоступна."));
  }

  const root = h("div.stack");
  const header = h("section.card.profile-card");
  const tabBar = h("div.tabs", { role: "tablist" });
  const content = h("div");
  const tabsCard = h("div.card", tabBar);
  root.append(header, tabsCard, content);

  function renderHeader() {
    const rel = data.relation;
    const cover = h("div.cover", data.cover ? h("img", { src: data.cover, alt: "" }) : null,
      isMe ? h("button.btn.sm.cover-btn", { type: "button", onclick: () => uploadProfileImage("cover", (url) => { data.cover = url; renderHeader(); }) }, icon("camera", "sm"), data.cover ? "Изменить обложку" : "Добавить обложку") : null);

    const actions = h("div.profile-actions");
    if (isMe) {
      actions.append(h("a.btn.outline", { href: "/settings" }, icon("edit", "sm"), "Редактировать профиль"));
    } else {
      if (!rel.blocked_by_me) {
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
      ]));
      actions.append(more);
    }

    const av = avatar(u, "xl");
    const avatarWrap = h("div", { style: { position: "relative" } },
      data.user.avatar ? h("button", { type: "button", style: { border: 0, padding: 0, background: "none", borderRadius: "50%" }, "aria-label": "Открыть фото профиля", onclick: () => lightbox([{ url: data.user.avatar, alt: u.name }]) }, av) : av,
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
    header.replaceChildren(cover,
      h("div.profile-main",
        h("div.profile-top", avatarWrap, actions),
        h("div.profile-name",
          h("h1", u.name, statusText ? h("span.status-pill.online", statusText) : null,
            !isMe && rel.follows_you && rel.status !== "friends" ? h("span.status-pill", "подписан(а) на вас") : null),
          h("div.handle", `@${u.username}`)),
        data.bio && !data.hidden ? h("p.profile-bio", data.bio) : null,
        h("div.profile-info", info),
        h("div.profile-counts",
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); selectTab("friends"); } }, h("b", data.counts.friends), " ", pl(data.counts.friends, ["друг", "друга", "друзей"]).split(" ")[1]),
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); showFollows("followers"); } }, h("b", data.counts.followers), " ", pl(data.counts.followers, ["подписчик", "подписчика", "подписчиков"]).split(" ")[1]),
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); showFollows("following"); } }, h("b", data.counts.following), " ", pl(data.counts.following, ["подписка", "подписки", "подписок"]).split(" ")[1]),
          !isMe && data.mutual_friends ? h("span", pl(data.mutual_friends, ["общий друг", "общих друга", "общих друзей"])) : null)));
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
      if (isMe) setCleanup(on("post-created", (p) => list.prepend(postCard(p))));
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
  renderHeader();
  selectTab(TABS.some((t) => t.id === query.tab) ? query.tab : "posts");

  // статус «в сети» обновляется в реальном времени
  setCleanup(on("presence", ({ user_id, online }) => {
    if (user_id === u.id) { data.user.online = online; renderHeader(); }
  }));
  return root;
}

export { navigate, timeAgo };
