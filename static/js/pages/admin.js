// Модерация для создателя сети: жалобы, люди (блокировка), журнал действий администрации, статистика.
import { api, state, setCounters } from "../api.js";
import { h, icon, avatar, vmark, timeAgo, pl } from "../dom.js";
import { setTitle, toast, toastError, confirmDialog, busy } from "../ui.js";
import { navigate } from "../router.js";

const WHAT = { post: "Запись", comment: "Комментарий", user: "Страница", reel: "Клип", reel_comment: "Комментарий к клипу", message: "Сообщение", story: "История", community: "Сообщество" };

function reportCard(it, onDone) {
  const t = it.target;
  const act = async (action, btn) => {
    if (action.includes("ban") && !await confirmDialog({ title: `Заблокировать ${it.author?.name || "автора"}?`, text: "Человек выйдет со всех устройств и не сможет войти, пока вы не снимете блокировку.", confirm: "Заблокировать", danger: true })) return;
    await busy(btn, async () => {
      try {
        await api.post("/api/admin/reports/resolve", { target_type: it.target_type, target_id: it.target_id, action });
        toast({ dismiss: "Жалоба отклонена", delete: "Удалено", ban: "Автор заблокирован", delete_ban: "Удалено, автор заблокирован" }[action], { icon: "check" });
        onDone();
      } catch (e) { toastError(e); }
    });
  };
  const btn = (label, action, cls = "soft") => {
    const b = h(`button.btn.sm.${cls}`, { type: "button" }, label);
    b.addEventListener("click", () => act(action, b));
    return b;
  };
  return h("article.card.card-pad.mod-card",
    h("div.mod-head",
      h("span.mod-type", WHAT[it.target_type] || it.target_type),
      h("span.mod-count", pl(it.count, ["жалоба", "жалобы", "жалоб"])),
      h("div.spacer"),
      h("small.muted", timeAgo(it.last_at))),
    it.author ? h("a.mini-person", { href: `/u/${it.author.username}` }, avatar(it.author, "sm", { presence: false }),
      h("div.who", h("span.name", it.author.name, vmark(it.author)), h("span.sub", it.author_banned ? "заблокирован(а)" : `@${it.author.username}`))) : null,
    t ? h("div.mod-body",
      t.text ? h("p.mod-text", t.text.length > 400 ? `${t.text.slice(0, 400)}…` : t.text) : null,
      t.photos?.length ? h("div.mod-photos", t.photos.map((src) => h("img", { src, alt: "", loading: "lazy" }))) : null,
      t.link ? h("a.mod-link", { href: t.link }, icon("link", "sm"), "Открыть") : null)
      : h("p.muted", "Уже удалено"),
    h("div.mod-reasons", it.reasons.map((r) => h("span.mod-reason", r))),
    h("div.mod-actions",
      btn("Оставить", "dismiss", "ghost"),
      t && it.target_type !== "user" ? btn("Удалить", "delete", "outline") : null,
      it.author && !it.author_banned && it.author.id !== state.me.id ? btn(it.target_type === "user" ? "Заблокировать" : "Удалить и заблокировать", it.target_type === "user" ? "ban" : "delete_ban", "danger") : null));
}

// Журнал действий администрации и модераторов: кто, что, с кем и когда — записи нельзя изменить или удалить
function modLog() {
  const list = h("div.card.modlog");
  const more = h("button.btn.ghost.sm", { type: "button", hidden: true }, "Показать ещё");
  let before = null;
  const row = (it) => h("div.modlog-row",
    it.actor ? avatar(it.actor, "sm", { presence: false }) : h("span.avatar.sm", "?"),
    h("div.modlog-body",
      h("div", h("b", it.actor?.name || "Удалённый аккаунт"), h("span.modlog-role", it.role === "moderator" ? "модератор" : "администратор")),
      h("div.modlog-what", it.label, it.target_user ? h("span", " · ", h("a", { href: `/u/${it.target_user.username}` }, `@${it.target_user.username}`)) : null,
        it.target_type && it.target_type !== "user" ? h("span.muted", ` · ${WHAT[it.target_type] || it.target_type} #${it.target_id}`) : null),
      it.details?.text ? h("div.modlog-text", `«${it.details.text}»`) : null,
      it.details?.reasons?.length ? h("div.mod-reasons", it.details.reasons.map((r) => h("span.mod-reason", r))) : null),
    h("small.muted", { title: new Date(it.created_at).toLocaleString("ru-RU") }, timeAgo(it.created_at)));
  const load = async () => {
    try {
      const d = await api.get("/api/admin/modlog", before ? { before } : undefined);
      if (!before && !d.items.length) list.append(h("div.empty", icon("list"), h("h2", "Журнал пуст"), h("p", "Здесь появятся блокировки, удаления, решения по жалобам и выдача галочек.")));
      list.append(...d.items.map(row));
      before = d.items.at(-1)?.id;
      more.hidden = !d.more;
    } catch (e) { list.append(h("p.muted", e.message)); }
  };
  more.addEventListener("click", () => busy(more, load));
  load();
  return h("div.stack", h("p.muted", { style: { margin: "0 4px" } }, "Все действия администрации и модераторов сообществ. Записи нельзя изменить или удалить."), list, more);
}

export async function adminPage({ query }) {
  if (!state.me?.is_admin) { navigate("/", { replace: true }); return h("div"); }
  setTitle("Модерация");
  let tab = ["reports", "people", "log", "stats"].includes(query.tab) ? query.tab : "reports";
  const content = h("div.stack");
  const tabs = h("div.tabs", { role: "tablist" });

  async function draw() {
    tabs.replaceChildren(...[["reports", "Жалобы", "flag"], ["people", "Люди", "users"], ["log", "Журнал", "list"], ["stats", "Статистика", "trend"]].map(([id, label, ic]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; history.replaceState(history.state, "", id === "reports" ? "/admin" : `/admin?tab=${id}`); draw(); } },
        icon(ic, "sm"), label, id === "reports" && state.counters.reports ? h("span.badge", String(state.counters.reports)) : null)));
    content.replaceChildren(h("div.spinner"));
    try {
      if (tab === "reports") {
        const { items } = await api.get("/api/admin/reports");
        content.replaceChildren(...(items.length ? items.map((it) => reportCard(it, () => { draw(); api.get("/api/counters").then(setCounters).catch(() => {}); }))
          : [h("div.card.empty", icon("check"), h("h2", "Жалоб нет"), h("p", "Всё спокойно. Новые жалобы появятся здесь, а в меню загорится счётчик."))]));
      } else if (tab === "log") {
        content.replaceChildren(modLog());
      } else if (tab === "people") {
        const q = h("input.input", { type: "search", placeholder: "Имя, логин или почта", "aria-label": "Поиск людей" });
        const onlyBanned = h("input.switch", { type: "checkbox", role: "switch", "aria-label": "Только заблокированные" });
        const list = h("div.people");
        let timer = null, gen = 0;
        const load = async () => {
          const my = ++gen;
          const { items } = await api.get("/api/admin/users", { q: q.value.trim(), banned: onlyBanned.checked ? "1" : "" });
          if (my !== gen) return;
          list.replaceChildren(...(items.length ? items.map((u) => {
            const b = h(`button.btn.sm.${u.banned ? "soft" : "danger"}`, { type: "button" }, u.banned ? "Разблокировать" : "Заблокировать");
            b.addEventListener("click", async () => {
              if (!u.banned && !await confirmDialog({ title: `Заблокировать ${u.name}?`, text: "Человек выйдет со всех устройств.", confirm: "Заблокировать", danger: true })) return;
              busy(b, async () => {
                try { await (u.banned ? api.del(`/api/admin/users/${u.id}/ban`) : api.post(`/api/admin/users/${u.id}/ban`)); toast(u.banned ? "Блокировка снята" : "Заблокирован(а)", { icon: "check" }); load(); } catch (e) { toastError(e); }
              });
            });
            return h(`div.person${u.banned ? ".is-banned" : ""}`,
              h("a", { href: `/u/${u.username}` }, avatar(u, "lg", { presence: false })),
              h("div.who", h("a.name", { href: `/u/${u.username}` }, u.name, vmark(u)),
                h("div.sub", [`@${u.username}`, u.email, `с ${new Date(u.joined_at).toLocaleDateString("ru-RU")}`, pl(u.posts, ["запись", "записи", "записей"]),
                  u.reports ? `жалоб: ${u.reports}` : null, u.email_verified ? null : "почта не подтверждена"].filter(Boolean).join(" · "))),
              h("div.acts", u.admin ? h("span.status-pill", "админ") : b));
          }) : [h("p.muted.card-pad", "Никого не нашли")]));
        };
        q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 300); });
        onlyBanned.addEventListener("change", load);
        content.replaceChildren(h("div.card.card-pad.stack", q, h("label.row", { style: { gap: "10px" } }, onlyBanned, "Только заблокированные")), h("div.card", list));
        load().catch((e) => list.replaceChildren(h("p.muted.card-pad", e.message)));
      } else {
        const s = await api.get("/api/admin/stats");
        const tile = (n, label, sub) => h("div.stat-tile", h("b", String(n ?? "—")), h("span", label), sub ? h("small", sub) : null);
        content.replaceChildren(h("div.stat-grid",
          tile(s.users, "человек", `+${s.users_day} за сутки · +${s.users_week} за неделю`),
          tile(s.online, "сейчас в сети"),
          tile(s.active_day, "заходили за сутки"),
          tile(s.posts, "записей", `+${s.posts_day} за сутки`),
          tile(s.messages_day, "сообщений за сутки"),
          tile(s.reels, "клипов"),
          tile(s.communities, "сообществ"),
          tile(s.reports_open, "открытых жалоб"),
          tile(s.banned, "заблокировано")));
      }
    } catch (e) { content.replaceChildren(h("div.card.empty", h("p", e.message))); }
  }
  draw();
  return h("div.stack", h("div.page-head", h("h1", "Модерация")), h("div.card", tabs), content);
}
