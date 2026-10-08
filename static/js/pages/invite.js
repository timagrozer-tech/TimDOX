// «Пригласить друзей»: ссылка и QR, галочки 3/10/50/100, статистика переходов и конверсии,
// история приглашений, рейтинг и социальное дерево.
import { api } from "../api.js";
import { h, icon, avatar, vmark, tierBadge, TIERS, pl, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, busy, promptDialog, confirmDialog } from "../ui.js";
import { socialTree } from "../components/socialtree.js";

const fmt = (n) => (n ?? 0).toLocaleString("ru-RU");
const TIER_ORDER = ["base", "silver", "gold", "legend"];

async function copy(text, what = "Ссылка скопирована") {
  try { await navigator.clipboard.writeText(text); toast(what, { icon: "check" }); }
  catch { toast("Не получилось скопировать — выделите ссылку вручную", { error: true }); }
}

function shareRow(link) {
  const text = "Присоединяйся ко мне в QEVI — соцсети для своих!";
  const open = (url) => window.open(url, "_blank", "noopener,noreferrer");
  const btn = (cls, label, ic, onClick) => h(`button.iv-share.${cls}`, { type: "button", onclick: onClick, "aria-label": label, title: label }, ic, h("span", label));
  const row = h("div.iv-shares",
    navigator.share ? btn("native", "Поделиться", icon("share", "sm"), () => navigator.share({ title: "QEVI", text, url: link }).catch(() => {})) : null,
    btn("tg", "Telegram", h("b", "TG"), () => open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`)),
    btn("vk", "ВКонтакте", h("b", "VK"), () => open(`https://vk.com/share.php?url=${encodeURIComponent(link)}&title=${encodeURIComponent(text)}`)),
    btn("wa", "WhatsApp", h("b", "WA"), () => open(`https://wa.me/?text=${encodeURIComponent(`${text} ${link}`)}`)),
    btn("copy", "Копировать", icon("copy", "sm"), () => copy(link)));
  return row;
}

function hero(d) {
  const linkBox = h("button.iv-link", { type: "button", onclick: () => copy(d.link), title: "Нажмите, чтобы скопировать" },
    icon("link", "sm"), h("span", d.link.replace(/^https?:\/\//, "")), h("span.iv-link-copy", icon("copy", "sm")));
  const qr = h("figure.iv-qr",
    h("img", { src: "/api/invites/qr", alt: "QR-код вашей ссылки-приглашения", width: 148, height: 148, loading: "lazy" }),
    h("figcaption", h("a", { href: "/api/invites/qr", download: "krug-invite.svg" }, icon("download", "sm"), "Скачать QR")));
  return h("section.card.iv-hero",
    h("div.iv-hero-glow", { "aria-hidden": "true" }),
    h("div.iv-hero-main",
      h("span.iv-kicker", icon("userAdd", "sm"), "Пригласить друзей"),
      h("h1", "Пригласите друзей в QEVI"),
      h("p", "Друзья по вашей ссылке сразу подписываются на вас. Когда они станут активными, вы получаете галочки — от базовой до легендарной."),
      linkBox, shareRow(d.link)),
    qr);
}

function tierLadder(d) {
  const p = d.progress;
  const reached = new Set(TIER_ORDER.slice(0, TIER_ORDER.indexOf(p.tier) + 1));
  const steps = TIER_ORDER.map((t) => h(`div.iv-tier${reached.has(t) ? ".on" : ""}${p.next?.tier === t ? ".next" : ""}`,
    h("div.iv-tier-medal", tierBadge(t, "xl")),
    h("b", TIERS[t].name.replace(" галочка", "")),
    h("small", `${TIERS[t].need} ${t === "base" ? "друга" : "друзей"}`)));
  const bar = p.next
    ? h("div.iv-progress",
      h("div.iv-progress-head", h("span", p.tier ? `У вас ${TIERS[p.tier].name.toLowerCase()}` : "Первая галочка — за 3 друзей"),
        h("b", `${p.qualified} / ${p.next.need}`)),
      h("div.iv-bar", { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": p.next.percent },
        h("i", { style: { "--p": `${p.next.percent}%` } })),
      h("small", `Ещё ${pl(p.next.left, ["засчитанное приглашение", "засчитанных приглашения", "засчитанных приглашений"])} до ${{ base: "базовой", silver: "серебряной", gold: "золотой", legend: "легендарной" }[p.next.tier]} галочки`))
    : h("div.iv-progress.max", h("b", "Легендарная галочка — максимальный уровень. Вы — легенда QEVI ✨"));
  return h("section.card.iv-tiers", h("h2", "Галочки за приглашения"), h("div.iv-tier-row", steps), bar,
    h("details.iv-rules", h("summary", "Когда приглашение засчитывается?"),
      h("p", `Когда друг поставит фото профиля и заглянет в QEVI в ${d.rules.active_days} разных дня (и подтвердит почту). Если за ${d.rules.pending_days} дней этого не случится — приглашение не засчитается. Так галочки получают за настоящих людей, а не за пустые аккаунты.`)));
}

function statTiles(d) {
  const t = d.totals;
  const tile = (label, value, hint, ic) => h("div.iv-stat", h("span.iv-stat-ic", icon(ic, "sm")), h("b", value), h("span", label), hint ? h("small", hint) : null);
  return h("div.iv-stats",
    tile("переходов", fmt(t.clicks), "уникальных за день", "link"),
    tile("регистраций", fmt(t.signups), t.pending ? `${t.pending} ждут активности` : null, "userAdd"),
    tile("засчитано", fmt(t.qualified), t.rejected ? `${t.rejected} не засчитано` : null, "check"),
    tile("конверсия", t.conversion == null ? "—" : `${t.conversion}%`, "из перехода в регистрацию", "chart"),
    tile("место", d.rank ? `#${d.rank}` : "—", "в общем рейтинге", "trophy"));
}

// ---------------------------------------------------------------- вкладки
function historyTab() {
  const list = h("div.iv-list");
  const more = h("button.btn.ghost.sm", { type: "button", hidden: true }, "Показать ещё");
  let before = null;
  const load = async () => {
    const d = await api.get("/api/invites/history", before ? { before } : undefined);
    if (!d.items.length && !before) {
      list.replaceChildren(h("div.iv-empty", icon("userAdd"), h("b", "Здесь появятся приглашённые"), h("p", "Отправьте ссылку паре друзей — и следите, как растёт ваш QEVI.")));
      return;
    }
    list.append(...d.items.map((it) => h(`a.iv-row.${it.status}`, { href: `/u/${it.user.username}` },
      avatar(it.user, "sm"),
      h("div.iv-row-main", h("b", it.user.name, vmark(it.user)),
        h("small", it.status === "pending" && it.steps
          ? `${it.steps.avatar ? "✓ фото" : "○ фото"} · ${it.steps.days}/${it.steps.days_need} дня активности`
          : it.reason || `пришёл(-ла) ${timeAgo(it.created_at)}`)),
      h(`span.iv-status.${it.status}`, it.status_text))));
    before = d.before;
    more.hidden = !d.more;
  };
  more.addEventListener("click", () => busy(more, load));
  load().catch((e) => list.replaceChildren(h("p.muted", e.message)));
  return h("div.stack", list, more);
}

function leaderboardTab() {
  const box = h("div.iv-board");
  let period = "month";
  const seg = h("div.seg.iv-seg", ["week", "month", "all"].map((p) => h("button", { type: "button", dataset: { p }, class: p === period ? "on" : "" },
    { week: "Неделя", month: "Месяц", all: "Всё время" }[p])));
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    period = b.dataset.p;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    load();
  });
  const load = async () => {
    box.replaceChildren(h("div.spinner"));
    try {
      const d = await api.get("/api/invites/leaderboard", { period });
      if (!d.items.length) { box.replaceChildren(h("div.iv-empty", icon("trophy"), h("b", "Рейтинг пока пуст"), h("p", "Станьте первым, кто приведёт друзей за этот период."))); return; }
      box.replaceChildren(...d.items.map((it) => h(`a.iv-lead${it.me ? ".me" : ""}${it.rank <= 3 ? ".top.r" + it.rank : ""}`, { href: `/u/${it.user.username}` },
        h("span.iv-rank", it.rank <= 3 ? ["🥇", "🥈", "🥉"][it.rank - 1] : String(it.rank)),
        avatar(it.user, "sm"), h("b", it.user.name, vmark(it.user)), h("span.iv-lead-n", fmt(it.count)))),
      d.me && !d.items.some((i) => i.me) ? h("div.iv-lead.me.out", h("span.iv-rank", "—"), h("b", "Вы"), h("span.iv-lead-n", fmt(d.me.count))) : "");
    } catch (e) { box.replaceChildren(h("p.muted", e.message)); }
  };
  load();
  return h("div.stack", seg, box);
}

function treeTab() {
  const box = h("div.iv-tree", h("div.spinner"));
  let scope = "me";
  const seg = h("div.seg.iv-seg", h("button.on", { type: "button", dataset: { s: "me" } }, "Моё дерево"), h("button", { type: "button", dataset: { s: "all" } }, "Весь QEVI"));
  const load = async () => {
    box.replaceChildren(h("div.spinner"));
    try {
      const d = await api.get("/api/invites/tree", { scope });
      box.replaceChildren(socialTree(d, { height: Math.min(620, Math.max(420, innerHeight - 260)) }),
        d.truncated ? h("small.muted", "Показана часть дерева — оно очень большое.") : "");
    } catch (e) { box.replaceChildren(h("p.muted", e.message)); }
  };
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.s === scope) return;
    scope = b.dataset.s;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    load();
  });
  load();
  return h("div.stack", seg, box);
}

function linksTab(d, refresh) {
  const rows = d.codes.map((c) => h("div.iv-code",
    h("div.iv-code-main", h("b", c.main ? "Основная ссылка" : c.label), h("small", c.link.replace(/^https?:\/\//, ""))),
    h("div.iv-code-nums", h("span", h("b", fmt(c.clicks)), "переходов"), h("span", h("b", fmt(c.signups)), "регистраций"), h("span", h("b", fmt(c.qualified)), "засчитано")),
    h("div.iv-code-act",
      h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Скопировать", onclick: () => copy(c.link) }, icon("copy", "sm")),
      c.main ? null : h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Отключить ссылку", onclick: async () => {
        if (!await confirmDialog({ title: "Отключить ссылку?", text: "Переходы по ней больше не будут засчитываться.", confirm: "Отключить" })) return;
        try { await api.del(`/api/invites/codes/${c.code}`); refresh(); } catch (e) { toastError(e); }
      } }, icon("trash", "sm")))));
  const add = h("button.btn.soft", { type: "button" }, icon("plus", "sm"), "Новая ссылка для канала");
  add.addEventListener("click", async () => {
    const label = await promptDialog({ title: "Новая ссылка", label: "Где вы её опубликуете?", placeholder: "Например: Telegram-канал", confirm: "Создать" });
    if (!label) return;
    try { const c = await api.post("/api/invites/codes", { label }); copy(c.link, "Ссылка создана и скопирована"); refresh(); } catch (e) { toastError(e); }
  });
  return h("div.stack", h("p.muted", { style: { margin: 0 } }, "Отдельные ссылки для разных каналов покажут, откуда приходят люди."), ...rows, add);
}

export async function invitePage({ query = {} } = {}) {
  setTitle("Пригласить друзей");
  const root = h("div.iv-page.stack");
  const draw = async () => {
    const d = await api.get("/api/invites/me");
    const TABS = [["history", "История", "list", historyTab], ["board", "Рейтинг", "trophy", leaderboardTab],
      ["tree", "Дерево", "tree", treeTab], ["links", "Мои ссылки", "link", () => linksTab(d, draw)]];
    let cur = TABS.some(([id]) => id === query.tab) ? query.tab : "history";
    const pane = h("div.iv-pane");
    const tabs = h("div.iv-tabs", { role: "tablist" }, TABS.map(([id, label, ic]) => h("button.iv-tab", {
      type: "button", role: "tab", dataset: { id }, "aria-selected": String(id === cur) }, icon(ic, "sm"), label)));
    const show = () => {
      tabs.querySelectorAll(".iv-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === cur)));
      pane.replaceChildren(TABS.find(([id]) => id === cur)[3]());
      history.replaceState(history.state, "", `/invite${cur === "history" ? "" : "?tab=" + cur}`);
    };
    tabs.addEventListener("click", (e) => { const b = e.target.closest(".iv-tab"); if (b && b.dataset.id !== cur) { cur = b.dataset.id; show(); } });
    root.replaceChildren(hero(d), statTiles(d), tierLadder(d), h("section.card.iv-tabs-card", tabs, pane));
    show();
  };
  root.append(h("div.spinner"));
  draw().catch((e) => root.replaceChildren(h("p.muted", e.message)));
  return root;
}
