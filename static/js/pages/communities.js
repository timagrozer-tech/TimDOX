// Сообщества: список, создание, страница сообщества, участники, управление.
import { api, state, on } from "../api.js";
import { h, icon, avatar, pl, joinedDate } from "../dom.js";
import { infiniteList, setTitle, toast, toastError, modal, busy, confirmDialog, showMenu } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { composer } from "../components/composer.js";
import { postCard, communityAvatar } from "../components/post.js";

function communityRow(c) {
  const sub = [c.is_private ? "Закрытое сообщество" : "Открытое сообщество", pl(c.members_count, ["участник", "участника", "участников"])];
  if (c.membership === "pending") sub.push("заявка отправлена");
  else if (c.role === "admin") sub.push("вы администратор");
  return h("a.person.comm-row", { href: `/c/${c.slug}` },
    communityAvatar(c, "lg"),
    h("div.who", h("span.name", c.name), h("div.sub", sub.join(" · "))),
    c.is_private ? icon("lock", "sm") : null);
}

export async function communitiesPage({ query }) {
  setTitle("Сообщества");
  let tab = ["my", "popular", "manage"].includes(query.tab) ? query.tab : "my";
  const tabBar = h("div.tabs", { role: "tablist" });
  const list = h("div.card");
  const search = h("input.input", { type: "search", placeholder: "Поиск сообществ", "aria-label": "Поиск сообществ" });
  let timer;
  async function draw() {
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab && !search.value.trim())));
    list.replaceChildren(h("div.spinner"));
    try {
      const q = search.value.trim();
      const { items } = await api.get("/api/communities", q ? { q } : { tab });
      list.replaceChildren(...(items.length ? [h("div.people", items.map(communityRow))] : [h("div.empty", icon("users"),
        h("h3", q ? "Ничего не найдено" : tab === "my" ? "Вы пока не состоите в сообществах" : "Сообществ пока нет"),
        tab === "my" && !q ? h("button.btn.soft", { type: "button", onclick: () => { tab = "popular"; draw(); } }, "Смотреть популярные") : null)]));
    } catch (e) { list.replaceChildren(h("p.muted.card-pad", e.message)); }
  }
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 300); });
  tabBar.append(...[["my", "Мои"], ["popular", "Популярные"], ["manage", "Управление"]].map(([id, label]) =>
    h("button", { type: "button", role: "tab", dataset: { tab: id }, onclick: () => { tab = id; search.value = ""; draw(); } }, label)));
  draw();
  return h("div.stack",
    h("div.page-head", h("h1", "Сообщества"), h("div.spacer"), h("button.btn.primary.sm", { type: "button", onclick: createCommunity }, icon("plus", "sm"), "Создать")),
    h("div.search-box", icon("search"), search),
    h("div.card", tabBar), list);
}

function createCommunity() {
  const name = h("input.input", { maxlength: 80, placeholder: "Например, «Любители Тулы»" });
  const slug = h("input.input", { maxlength: 40, placeholder: "tula_fans" });
  const desc = h("textarea.textarea", { rows: 3, maxlength: 2000, placeholder: "О чём это сообщество?" });
  const priv = h("input", { type: "checkbox" });
  const wall = h("input", { type: "checkbox" });
  const err = h("div.form-error.hidden");
  const translit = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  let touched = false;
  slug.addEventListener("input", () => { touched = true; });
  name.addEventListener("input", () => {
    if (!touched) slug.value = name.value.toLowerCase().split("").map((c) => translit[c] ?? c).join("").replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40);
  });
  const create = h("button.btn.primary", { type: "button" }, "Создать сообщество");
  const m = modal({
    title: "Новое сообщество",
    body: h("div.stack", err,
      h("div.field", h("label", "Название"), name),
      h("div.field", h("label", "Адрес страницы"), h("div.input-prefix", h("span", "/c/"), slug), h("div.field-hint", "Латиница, цифры и _")),
      h("div.field", h("label", "Описание"), desc),
      h("label.check", priv, h("span", h("b", "Закрытое сообщество"), h("br"), "Вступление по заявке, записи видят только участники")),
      h("label.check", wall, h("span", h("b", "Открытая стена"), h("br"), "Участники могут публиковать записи"))),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), create],
  });
  create.addEventListener("click", () => busy(create, async () => {
    try {
      const c = await api.post("/api/communities", { name: name.value, slug: slug.value, description: desc.value, is_private: priv.checked, wall_open: wall.checked });
      m.close();
      toast("Сообщество создано", { icon: "check" });
      navigate(`/c/${c.slug}`);
    } catch (e) {
      err.textContent = Object.values(e.fields || {}).join(". ") || e.message;
      err.classList.remove("hidden");
    }
  }));
  setTimeout(() => name.focus(), 50);
}

// ---------------------------------------------------------------- Страница сообщества
export async function communityPage({ params, query }) {
  let offPosted = null, cleanupSet = false;
  const slug = params.slug;
  let c = await api.get(`/api/communities/${encodeURIComponent(slug)}`);
  setTitle(c.name);
  const header = h("section.card.profile-card");
  const tabBar = h("div.tabs", { role: "tablist" });
  const content = h("div");
  let current = query.tab === "members" ? "members" : "posts";
  const isAdmin = c.role === "admin";
  const isMod = ["admin", "moderator"].includes(c.role);

  async function reload() {
    c = await api.get(`/api/communities/${encodeURIComponent(slug)}`);
    renderHeader();
  }

  function renderHeader() {
    const actions = h("div.profile-actions");
    if (c.membership === "member") {
      const b = h("button.btn.outline", { type: "button", "aria-haspopup": "menu" }, icon("check", "sm"), "Вы участник");
      b.addEventListener("click", () => showMenu(b, [{ label: "Выйти из сообщества", icon: "logout", danger: true, onClick: leave }]));
      actions.append(b);
    } else if (c.membership === "pending") {
      actions.append(h("button.btn.outline", { type: "button", onclick: leave }, "Отменить заявку"));
    } else {
      actions.append(h("button.btn.primary", { type: "button", onclick: joinC }, icon("userPlus", "sm"), c.is_private ? "Подать заявку" : "Вступить"));
    }
    if (isAdmin) actions.append(h("button.btn.ghost.icon-only", { type: "button", "aria-label": "Управление", title: "Управление", onclick: manage }, icon("settings")));
    header.replaceChildren(
      h("div.cover", c.cover ? h("img", { src: c.cover, alt: "" }) : null,
        isAdmin ? h("button.btn.sm.cover-btn", { type: "button", onclick: () => upload("cover") }, icon("camera", "sm"), "Обложка") : null),
      h("div.profile-main",
        h("div.profile-top",
          h("div", { style: { position: "relative" } }, h("span.avatar.xl.comm-avatar.big", c.avatar ? h("img", { src: c.avatar, alt: "" }) : c.name[0]),
            isAdmin ? h("button.avatar-edit", { type: "button", "aria-label": "Изменить аватар", onclick: () => upload("avatar") }, icon("camera", "sm")) : null),
          actions),
        h("div.profile-name", h("h1", c.name.replace(/№ /g, "№\u00a0"), c.is_private ? h("span.status-pill", icon("lock", "sm"), " закрытое") : null), h("div.handle", `/c/${c.slug}`)),
        c.description ? h("p.profile-bio", c.description) : null,
        h("div.profile-counts",
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); select("members"); } }, h("b", c.members_count), " ", pl(c.members_count, ["участник", "участника", "участников"]).split(" ")[1]),
          h("span", `создано ${joinedDate(c.created_at)}`)),
        c.friends_inside.length ? h("div.row", { style: { marginTop: "10px", gap: "4px" } },
          ...c.friends_inside.map((f) => h("a", { href: `/u/${f.username}`, title: f.name }, avatar(f, "xs", { presence: false }))),
          h("span.muted", { style: { fontSize: "13px", marginLeft: "6px" } }, `${pl(c.friends_inside.length, ["друг", "друга", "друзей"])} здесь`)) : null,
        isMod && c.pending_count ? h("button.btn.soft.sm", { type: "button", style: { marginTop: "12px" }, onclick: () => select("members") }, icon("userPlus", "sm"), `Заявки на вступление: ${c.pending_count}`) : null));
  }

  async function joinC() {
    try { await api.post(`/api/communities/${slug}/join`); toast(c.is_private ? "Заявка отправлена администраторам" : "Вы вступили в сообщество", { icon: "check" }); await reload(); select(current); } catch (e) { toastError(e); }
  }
  async function leave() {
    try { await api.del(`/api/communities/${slug}/join`); toast("Вы вышли из сообщества"); await reload(); select(current); } catch (e) { toastError(e); }
  }
  function upload(kind) {
    const input = h("input", { type: "file", accept: "image/*", hidden: true });
    input.addEventListener("change", async () => {
      const fd = new FormData(); fd.append("file", input.files[0]);
      try { await api.form(`/api/communities/${slug}/${kind}`, fd); await reload(); toast("Изображение обновлено", { icon: "check" }); } catch (e) { toastError(e); }
    });
    input.click();
  }

  function manage() {
    const name = h("input.input", { value: c.name, maxlength: 80 });
    const desc = h("textarea.textarea", { rows: 4, maxlength: 2000, value: c.description });
    const priv = h("input", { type: "checkbox", checked: c.is_private });
    const wall = h("input", { type: "checkbox", checked: c.wall_open });
    const save = h("button.btn.primary", { type: "button" }, "Сохранить");
    const del = h("button.btn.danger", { type: "button" }, icon("trash", "sm"), "Удалить сообщество");
    const m = modal({
      title: "Управление сообществом",
      body: h("div.stack",
        h("div.field", h("label", "Название"), name),
        h("div.field", h("label", "Описание"), desc),
        h("label.check", priv, "Закрытое сообщество (вступление по заявке)"),
        h("label.check", wall, "Участники могут публиковать записи"),
        c.pinned ? h("button.btn.ghost.sm", { type: "button", onclick: async () => { await api.patch(`/api/communities/${slug}`, { pinned_post_id: null }); m.close(); await reload(); select("posts"); } }, "Открепить запись") : null,
        h("hr.divider"), del),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
    });
    save.addEventListener("click", () => busy(save, async () => {
      try {
        await api.patch(`/api/communities/${slug}`, { name: name.value, description: desc.value, is_private: priv.checked, wall_open: wall.checked });
        m.close(); toast("Сохранено", { icon: "check" }); await reload(); select(current);
      } catch (e) { toastError(e); }
    }));
    del.addEventListener("click", async () => {
      if (!await confirmDialog({ title: "Удалить сообщество?", text: "Все записи сообщества будут удалены безвозвратно.", confirm: "Удалить", danger: true })) return;
      try { await api.del(`/api/communities/${slug}`); m.close(); toast("Сообщество удалено"); navigate("/communities"); } catch (e) { toastError(e); }
    });
  }

  function select(id) {
    current = id;
    tabBar.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    history.replaceState({}, "", id === "posts" ? location.pathname : `${location.pathname}?tab=${id}`);
    if (!c.can_view) {
      content.replaceChildren(h("div.card.locked", icon("lock"), h("b", "Это закрытое сообщество"), h("p", "Подайте заявку, чтобы видеть записи и участников.")));
      return;
    }
    if (id === "posts") {
      const wrap = h("div.stack");
      if (c.can_post) wrap.append(h("div.card", composer({ placeholder: isMod ? "Новая запись сообщества…" : "Предложите запись…", community: c })));
      if (c.pinned) wrap.append(h("div.card.feed.pinned", h("div.pin-label", icon("pin", "sm"), "Закреплённая запись"), postCard(c.pinned)));
      const card = h("div.card.feed");
      const list = infiniteList({
        load: (cursor) => api.get(`/api/communities/${slug}/posts`, { cursor }),
        render: (p) => (c.pinned && p.id === c.pinned.id ? null : postCard(p, { onPin: async () => { await reload(); select("posts"); } })),
        empty: h("div.card.empty", icon("edit"), h("h3", "Записей пока нет")),
        container: card,
      });
      wrap.append(list.el);
      content.replaceChildren(wrap);
      offPosted?.();
      offPosted = on("post-created", (p) => { if (p.community?.id === c.id) list.prepend(postCard(p)); });
      if (!cleanupSet) { cleanupSet = true; setCleanup(() => offPosted?.()); }
    } else {
      const box = h("div.stack", h("div.card", h("div.spinner")));
      content.replaceChildren(box);
      drawMembers(box);
    }
  }

  async function drawMembers(box) {
    const roleLabel = { admin: "администратор", moderator: "модератор", member: "" };
    const parts = [];
    try {
      if (isMod) {
        const { items: pending } = await api.get(`/api/communities/${slug}/members`, { status: "pending" });
        if (pending.length) {
          parts.push(h("section.card", h("div.card-pad", { style: { paddingBottom: 0 } }, h("h2.card-title", "Заявки на вступление", h("span.badge", String(pending.length)))),
            h("div.people", pending.map((p) => {
              const acts = h("div.acts",
                h("button.btn.primary.sm", { type: "button", onclick: () => act(p.id, { action: "approve" }, "Заявка одобрена") }, "Принять"),
                h("button.btn.outline.sm", { type: "button", onclick: () => act(p.id, { action: "reject" }, "Заявка отклонена") }, "Отклонить"));
              return h("div.person", h("a", { href: `/u/${p.username}` }, avatar(p, "lg")), h("div.who", h("a.name", { href: `/u/${p.username}` }, p.name), h("div.sub", p.city || `@${p.username}`)), acts);
            }))));
        }
      }
      const { items } = await api.get(`/api/communities/${slug}/members`);
      parts.push(h("section.card", h("div.card-pad", { style: { paddingBottom: 0 } }, h("h2.card-title", pl(items.length, ["участник", "участника", "участников"]))),
        h("div.people", items.map((p) => {
          const acts = h("div.acts");
          if (p.role !== "member") acts.append(h("span.status-pill", roleLabel[p.role]));
          if (isMod && p.id !== state.me.id && (isAdmin || p.role === "member")) {
            const more = h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Действия" }, icon("more"));
            more.addEventListener("click", () => showMenu(more, [
              isAdmin && p.role !== "moderator" ? { label: "Назначить модератором", icon: "shield", onClick: () => act(p.id, { action: "role", role: "moderator" }, "Назначен модератором") } : null,
              isAdmin && p.role !== "admin" ? { label: "Назначить администратором", icon: "shield", onClick: () => act(p.id, { action: "role", role: "admin" }, "Назначен администратором") } : null,
              isAdmin && p.role !== "member" ? { label: "Снять права", icon: "user", onClick: () => act(p.id, { action: "role", role: "member" }, "Права сняты") } : null,
              { label: "Исключить", icon: "userX", danger: true, onClick: () => act(p.id, { action: "remove" }, "Участник исключён") },
            ]));
            acts.append(more);
          }
          return h("div.person", h("a", { href: `/u/${p.username}` }, avatar(p, "lg")), h("div.who", h("a.name", { href: `/u/${p.username}` }, p.name), h("div.sub", p.city || `@${p.username}`)), acts);
        }))));
      box.replaceChildren(...parts);
    } catch (e) { box.replaceChildren(h("p.muted", e.message)); }
  }
  async function act(uid, payload, msg) {
    try { await api.post(`/api/communities/${slug}/members/${uid}`, payload); toast(msg, { icon: "check" }); await reload(); select("members"); } catch (e) { toastError(e); }
  }

  tabBar.append(...[["posts", "Записи", "edit"], ["members", "Участники", "users"]].map(([id, label, ic]) =>
    h("button", { type: "button", role: "tab", dataset: { tab: id }, onclick: () => select(id) }, icon(ic, "sm"), label)));
  renderHeader();
  select(current);
  return h("div.stack", header, h("div.card", tabBar), content);
}
