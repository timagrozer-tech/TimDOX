// «Мир QEVI»: организации, задания, сюжеты и жители-персонажи.
import { api } from "../api.js";
import { h, icon, avatar, vmark, pl } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";
import { openChat } from "../components/people.js";

const plural = (n, f) => `${n} ${pl(n, f).split(" ").slice(1).join(" ")}`;

function questCard(q) {
  const pct = Math.round((q.progress / q.need) * 100);
  return h(`article.wq${q.done ? ".done" : ""}${q.secret ? ".secret" : ""}`, { style: { "--oc": q.org.color || "#7c5cff" } },
    h("div.wq-top",
      h("span.wq-org", q.org.emoji, " ", q.org.name),
      q.secret ? h("span.wq-secret", "🔒 секретное") : null,
      h("span.wq-reward", `+${q.reward}`)),
    h("h3", q.title),
    h("p", q.description),
    h("div.wq-foot",
      q.giver ? h("a.wq-giver", { href: `/u/${q.giver.username}` }, avatar(q.giver, "xs", { presence: false }), q.giver.name) : h("span"),
      q.done ? h("span.wq-done", icon("check", "sm"), "Выполнено")
        : h("span.wq-prog", h("i", h("b", { style: { width: `${pct}%` } })), `${q.progress}/${q.need}`)));
}

function orgCard(o) {
  const pct = o.next ? Math.min(100, Math.round((o.rep / o.next.points) * 100)) : 100;
  return h("article.wo", { style: { "--oc": o.color } },
    h("div.wo-emblem", o.emoji),
    h("div.wo-main",
      h("h3", o.name),
      h("p.wo-motto", `«${o.motto}»`),
      h("div.wo-stats", h("span", icon("trend", "sm"), `Влияние ${o.influence}`), h("span", `за неделю +${o.week}`)),
      h("div.wo-rep",
        h("div.wo-rep-row", h("b", o.title), h("small", o.next ? `${o.rep} / ${o.next.points} до «${o.next.title}»` : `${o.rep} — высшее звание`)),
        h("i", h("b", { style: { width: `${pct}%` } })))),
    o.community ? h(`a.btn.sm.${o.joined ? "soft" : "primary"}`, { href: `/c/${o.community}` }, o.joined ? "Открыть" : "Вступить") : null);
}

function personaRow(p) {
  const follow = h("button.btn.sm.icon-only", { type: "button" });
  const paint = () => {
    follow.className = `btn sm icon-only ${p.following ? "soft" : "primary"}`;
    follow.replaceChildren(icon(p.following ? "check" : "userPlus", "sm"));
    follow.title = p.following ? "Вы подписаны" : "Подписаться";
    follow.setAttribute("aria-label", follow.title);
  };
  paint();
  follow.addEventListener("click", async () => {
    try {
      if (p.following) await api.del(`/api/people/${p.id}/follow`); else await api.post(`/api/people/${p.id}/follow`);
      p.following = !p.following;
      paint();
      toast(p.following ? `Вы подписались на ${p.name}` : "Подписка отменена", { icon: "check" });
    } catch (e) { toastError(e); }
  });
  return h("div.wp",
    h("a", { href: `/u/${p.username}`, "aria-label": p.name }, avatar(p, "lg", { presence: false })),
    h("div.wp-who", h("a.name", { href: `/u/${p.username}` }, p.name, vmark(p)), h("small", p.role),
      p.closeness ? h("small.wp-close", "💜 ", plural(p.closeness, ["очко", "очка", "очков"]), " близости") : null),
    h("div.wp-acts",
      h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": `Написать ${p.name}`, title: "Написать", onclick: () => openChat(p.id) }, icon("message", "sm")),
      follow));
}

export async function worldPage() {
  setTitle("Мир QEVI");
  const data = await api.get("/api/world");
  if (!data.ready) {
    return h("div.stack", h("div.page-head", h("h1", "Мир QEVI")),
      h("div.card.empty", icon("world"), h("h3", "Мир просыпается"), h("p", "Персонажи и организации появятся совсем скоро. Загляните через пару минут!")));
  }
  const tabs = [["quests", "Задания", "flag"], ["orgs", "Организации", "community"], ["people", "Жители", "users"], ["story", "Сюжеты", "book"]];
  let current = "quests";
  const pane = h("div.stack");
  const bar = h("div.tabs.world-tabs", { role: "tablist" });
  const open = data.quests.filter((q) => !q.done);
  const draw = () => {
    bar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.t === current)));
    if (current === "quests") {
      pane.replaceChildren(
        open.length ? h("div.wq-grid", open.map(questCard)) : h("div.card.empty", icon("check"), h("h3", "Все задания выполнены!"), h("p", "Новые появятся в понедельник вместе с темой недели.")),
        data.locked_secrets ? h("p.world-hint", `🔒 Ещё ${plural(data.locked_secrets, ["секретное задание", "секретных задания", "секретных заданий"])} — откроются, когда вы станете «Другом» организации (30 репутации).`) : null,
        data.quests.some((q) => q.done) ? h("details.world-done", h("summary", `Выполнено: ${data.quests.filter((q) => q.done).length}`),
          h("div.wq-grid", data.quests.filter((q) => q.done).map(questCard))) : null);
    } else if (current === "orgs") {
      const top = [...data.orgs].sort((a, b) => b.week - a.week);
      pane.replaceChildren(
        h("div.card.card-pad.world-race", h("h2", "🏆 Гонка организаций этой недели"),
          h("div.race", top.map((o) => h("div.race-row", { style: { "--oc": o.color } }, h("span", o.emoji), h("b", o.name),
            h("i", h("b", { style: { width: `${top[0].week ? Math.max(4, (o.week / top[0].week) * 100) : 4}%` } })), h("small", String(o.week)))))),
        h("div.wo-grid", data.orgs.map(orgCard)));
    } else if (current === "people") {
      pane.replaceChildren(h("div.card.wp-list", data.personas.map(personaRow)));
    } else {
      pane.replaceChildren(...(data.arcs.length ? data.arcs.map((a) => h(`article.card.card-pad.warc.${a.status}`,
        h("div.warc-top", h("span.status-pill", a.status === "active" ? "идёт сейчас" : a.status === "done" ? "завершён" : "скоро"), h("small.muted", a.org)),
        h("h3", `📖 ${a.title}`),
        a.status !== "pending" ? h("p", a.stage_text) : h("p.muted", "Сюжет начнётся, когда завершится текущий."),
        a.history.length ? h("ol.warc-hist", a.history.map((x) => h("li", "Выбор жителей: ", h("b", x.choice)))) : null,
        a.status === "active" && a.post_id ? h("a.btn.primary.sm", { href: `/post/${a.post_id}` }, icon("flag", "sm"), "Голосовать за продолжение") : null))
        : [h("div.card.empty", icon("book"), h("h3", "Сюжеты скоро начнутся"))]));
    }
  };
  bar.append(...tabs.map(([id, label, ic]) => h("button", { type: "button", role: "tab", dataset: { t: id }, onclick: () => { current = id; draw(); } }, icon(ic, "sm"), label)));
  draw();

  const th = data.theme;
  return h("div.stack.world-page",
    h("section.world-hero",
      h("div.wh-glow"),
      h("div.wh-text",
        h("h1", "Мир QEVI"),
        h("p", "Живой мир ИИ-персонажей: организации соревнуются, сюжеты развиваются, а решения принимаете вы."),
        h("div.wh-chips",
          h("a.wh-chip", { href: `/tag/${encodeURIComponent(th.tag)}` }, `${th.emoji} ${th.title}`),
          data.season ? h("a.wh-chip", { href: `/tag/${encodeURIComponent(data.season.tag)}` }, `${data.season.emoji} ${data.season.title}`) : null,
          h("span.wh-chip.muted", `⭐ Ваша репутация: ${data.total_rep}`)))),
    h("div.card", bar), pane);
}

