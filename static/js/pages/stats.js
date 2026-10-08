// Личная статистика: отклик на записи, рост аудитории, лучшее время для публикаций. Видна только владельцу.
import { api, state } from "../api.js";
import { h, icon, avatar, pl, timeAgo } from "../dom.js";
import { setTitle, toastError } from "../ui.js";
import { REACTIONS } from "../components/post.js";

const PERIODS = [[7, "7 дней"], [30, "30 дней"], [90, "3 месяца"], [365, "Год"], [0, "Всё время"]];
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
let period = 30;

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} млн` : n >= 1e4 ? `${(n / 1e3).toFixed(1).replace(".0", "")} тыс.` : n.toLocaleString("ru-RU"));

function bucketLabel(key, step, long = false) {
  if (step === "month") { const [y, m] = key.split("-"); return long ? `${MONTHS_FULL[+m - 1]} ${y}` : MONTHS[+m - 1]; }
  const [, m, d] = key.split("-");
  const s = `${+d} ${MONTHS[+m - 1]}`;
  return step === "week" && long ? `неделя с ${s}` : s;
}

// «Круглый» верх шкалы: 1, 2, 5 × 10^n
function niceMax(v) {
  if (v <= 4) return Math.max(v, 1);
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v);
}

function delta(cur, prev) {
  if (prev == null) return null;
  if (!prev) return cur ? h("span.st-delta.up", icon("up", "sm"), "новое") : null;
  const d = Math.round(((cur - prev) / prev) * 100);
  if (!d) return h("span.st-delta.flat", "без изменений");
  return h(`span.st-delta.${d > 0 ? "up" : "down"}`, icon(d > 0 ? "up" : "down", "sm"), `${d > 0 ? "+" : "−"}${Math.abs(d)}%`);
}

function tile(label, value, prev, ico) {
  return h("div.st-tile",
    h("div.st-tile-label", icon(ico, "sm"), label),
    h("div.st-tile-value", fmt(value)),
    delta(value, prev) || h("span.st-delta.flat", " "));
}

// Столбчатая диаграмма (один ряд) с подсказкой при наведении/нажатии
function columns({ items, value, label, tip, highlight = null, height = 180, ticks = true, xLabels }) {
  const max = niceMax(Math.max(0, ...items.map(value)));
  const tipEl = h("div.st-tip", { role: "status" });
  const plot = h("div.st-plot", { style: { height: `${height}px` } });
  const wrap = h("div.st-plotwrap");
  const hide = () => { tipEl.classList.remove("on"); plot.querySelectorAll(".st-bar.hot").forEach((b) => b.classList.remove("hot")); };
  items.forEach((it, i) => {
    const v = value(it);
    const bar = h(`button.st-bar${highlight?.(it, i) ? ".peak" : ""}`, {
      type: "button", "aria-label": `${label(it, true)}: ${v}`,
      style: { "--h": `${(v / max) * 100}%` },
    }, h("span"));
    const show = () => {
      hide(); bar.classList.add("hot");
      tipEl.replaceChildren(...tip(it));
      const box = wrap.getBoundingClientRect(), b = bar.getBoundingClientRect();
      const x = b.left - box.left + b.width / 2;
      tipEl.style.left = `${Math.min(Math.max(x, 70), box.width - 70)}px`;
      tipEl.classList.add("on");
    };
    bar.addEventListener("pointerenter", show);
    bar.addEventListener("focus", show);
    bar.addEventListener("click", show);
    bar.addEventListener("blur", hide);
    plot.append(bar);
  });
  plot.addEventListener("pointerleave", hide);
  const grid = ticks ? h("div.st-grid", [max, max / 2, 0].map((t) => h("div", h("span", fmt(Math.round(t)))))) : null;
  const xs = xLabels ? h("div.st-x", xLabels.map((l) => h("span", l))) : null;
  wrap.append(...[grid, plot, tipEl].filter(Boolean));
  return h(`div.st-chart${ticks ? "" : ".no-ticks"}`, wrap, xs);
}

const tipRow = (name, v, strong = false) => h("div.st-tip-row", h(strong ? "b" : "span", fmt(v)), h("span", name));

function activityCard(data) {
  const t = data.timeline;
  const total = (it) => it.reactions + it.comments + it.reposts;
  const sum = t.reduce((a, it) => a + total(it), 0);
  const edge = (i) => bucketLabel(t[i].key, data.step);
  const xLabels = t.length > 2 ? [edge(0), edge(Math.floor(t.length / 2)), edge(t.length - 1)] : t.map((_, i) => edge(i));
  const chart = columns({
    items: t, value: total, height: 190, xLabels,
    label: (it, long) => bucketLabel(it.key, data.step, long),
    tip: (it) => [h("div.st-tip-h", bucketLabel(it.key, data.step, true)),
      tipRow("отклик всего", total(it), true), tipRow("реакции", it.reactions), tipRow("комментарии", it.comments),
      tipRow("репосты", it.reposts), tipRow("новые подписчики", it.followers), tipRow("ваши записи", it.posts)],
  });
  // табличный вид — те же числа без наведения
  const rows = t.filter((it) => total(it) || it.followers || it.posts).reverse();
  const table = h("details.st-table", h("summary", "Показать таблицей"),
    rows.length ? h("div.st-table-scroll", h("table",
      h("thead", h("tr", ["Период", "Реакции", "Комм.", "Репосты", "Подписчики", "Записи"].map((c) => h("th", c)))),
      h("tbody", rows.map((it) => h("tr", h("td", bucketLabel(it.key, data.step, true)),
        [it.reactions, it.comments, it.reposts, it.followers, it.posts].map((v) => h("td", fmt(v)))))))) : h("p.muted", "Пока пусто"));
  const stepWord = { day: "по дням", week: "по неделям", month: "по месяцам" }[data.step];
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Отклик на ваши записи"), h("span.muted", stepWord)),
    h("p.st-sub", sum ? "Реакции, комментарии и репосты от других людей. Нажмите на столбик, чтобы увидеть подробности." : "За этот период откликов пока не было."),
    chart, table);
}

function reactionsCard(data) {
  const byType = data.reactions_by_type;
  const max = Math.max(1, ...Object.values(byType));
  const sum = Object.values(byType).reduce((a, b) => a + b, 0);
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Какие реакции ставят"), h("span.muted", pl(sum, ["реакция", "реакции", "реакций"]))),
    h("div.st-hbars", REACTIONS.map((r) => h("div.st-hbar", { title: r.label },
      h("span.st-hbar-emoji", { "aria-hidden": "true" }, r.emoji),
      h("span.st-hbar-name", r.label),
      h("span.st-hbar-track", h("span", { style: { width: `${(byType[r.type] / max) * 100}%` } })),
      h("b.st-hbar-v", fmt(byType[r.type]))))));
}

function timeCard(data) {
  const hours = data.hours, wd = data.weekdays;
  const hMax = Math.max(...hours), wMax = Math.max(...wd);
  if (!hMax) return null;
  const peak = hours.indexOf(hMax);
  const wPeak = wd.indexOf(wMax);
  const range = (i) => `${String(i).padStart(2, "0")}:00–${String((i + 1) % 24).padStart(2, "0")}:00`;
  const hourChart = columns({
    items: hours.map((v, i) => ({ v, i })), value: (it) => it.v, height: 120, ticks: false,
    highlight: (it) => it.v === hMax,
    label: (it) => range(it.i),
    tip: (it) => [h("div.st-tip-h", range(it.i)), tipRow("откликов", it.v, true)],
    xLabels: ["00", "06", "12", "18", "23"],
  });
  const wdChart = columns({
    items: wd.map((v, i) => ({ v, i })), value: (it) => it.v, height: 90, ticks: false,
    highlight: (it) => it.v === wMax,
    label: (it) => WEEKDAYS[it.i],
    tip: (it) => [h("div.st-tip-h", WEEKDAYS[it.i]), tipRow("откликов", it.v, true)],
    xLabels: WEEKDAYS,
  });
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Когда вас читают")),
    h("p.st-tipline", icon("star", "sm"), h("span", "Больше всего откликов ", h("b", range(peak)), " (по Москве), самый активный день — ", h("b", WEEKDAYS[wPeak]), ". Публикуйте незадолго до этого времени.")),
    h("div.st-sublabel", "По часам"), hourChart,
    h("div.st-sublabel", "По дням недели"), wdChart);
}

function topPostsCard(data) {
  if (!data.top_posts.length) return null;
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Лучшие записи"), h("span.muted", "по отклику")),
    h("ol.st-top", data.top_posts.map((p, i) => h("li", h("a.st-top-item", { href: `/post/${p.id}` },
      h("span.st-top-n", String(i + 1)),
      p.thumb ? h("img.st-top-thumb", { src: p.thumb, alt: "", loading: "lazy" }) : null,
      h("span.st-top-body",
        h("span.st-top-text", p.text || (p.thumb ? "Фото" : "Запись")),
        h("span.st-top-meta",
          h("span", "👍 ", fmt(p.reactions)), h("span", "💬 ", fmt(p.comments)),
          p.reposts ? h("span", "🔁 ", fmt(p.reposts)) : null, p.saves ? h("span", "🔖 ", fmt(p.saves)) : null,
          h("span.muted", timeAgo(p.created_at)))))))));
}

function fansCard(data) {
  if (!data.fans.length) return null;
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Самые активные читатели")),
    h("div.st-fans", data.fans.map((f) => h("a.st-fan", { href: `/u/${f.username}` }, avatar(f, "lg"), h("span", f.name.split(" ")[0])))));
}

function overallCard(data) {
  const o = data.overall, r = o.reels;
  const item = (v, l) => h("div.st-mini", h("b", fmt(v)), h("span", l));
  return h("section.card.card-pad.st-card",
    h("div.st-card-head", h("h2", "Ваш аккаунт целиком")),
    h("div.st-minis",
      item(o.days_on_krug, ["день", "дня", "дней"][pluralIdx(o.days_on_krug)] + " в QEVI"),
      item(o.followers, "подписчиков"), item(o.friends, "друзей"), item(o.following, "подписок"),
      item(o.posts, "записей"), item(o.reactions, "реакций всего"), item(o.guests_30, "гостей за 30 дней"),
      r.n ? item(r.views, `просмотров клипов (${r.n})`) : null, r.n ? item(r.likes, "лайков клипов") : null),
    h("div.st-links",
      h("a.btn.soft.sm", { href: "/guests" }, icon("eye", "sm"), "Гости"),
      h("a.btn.soft.sm", { href: "/world" }, icon("world", "sm"), "Задания и репутация")));
}

function pluralIdx(n) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 1 : 2;
}

export async function statsPage() {
  setTitle("Статистика");
  const body = h("div.stack.st-body");
  const seg = h("div.segmented.st-periods", { role: "group", "aria-label": "Период" });
  const load = async () => {
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.d === period)));
    body.classList.add("loading");
    try {
      const data = await api.get(`/api/me/stats?days=${period}`);
      render(data);
    } catch (e) { toastError(e); }
    body.classList.remove("loading");
  };
  PERIODS.forEach(([d, l]) => seg.append(h("button", { type: "button", dataset: { d: String(d) }, onclick: () => { period = d; load(); } }, l)));

  function render(data) {
    const t = data.totals, p = data.prev || {};
    const pv = (k) => (data.prev ? p[k] : null);
    const engaged = t.reactions + t.comments + t.reposts;
    const prevEngaged = data.prev ? p.reactions + p.comments + p.reposts : null;
    const periodWord = period ? `за ${PERIODS.find(([d]) => d === period)[1].toLowerCase()}` : "за всё время";
    const hero = h("section.card.card-pad.st-hero",
      h("div.st-hero-label", `Отклик ${periodWord}`),
      h("div.st-hero-row", h("div.st-hero-value", fmt(engaged)), delta(engaged, prevEngaged)),
      h("div.st-hero-sub", data.per_post != null ? `≈ ${String(data.per_post).replace(".", ",")} на запись · ` : "",
        data.prev ? "сравнение с предыдущим таким же периодом" : "реакции, комментарии и репосты"));
    const tiles = h("div.st-tiles",
      tile("Реакции", t.reactions, pv("reactions"), "heart"),
      tile("Комментарии", t.comments, pv("comments"), "comment"),
      tile("Репосты", t.reposts, pv("reposts"), "repeat"),
      tile("Сохранения", t.saves, pv("saves"), "bookmark"),
      tile("Новые подписчики", t.followers, pv("followers"), "bell"),
      tile("Новые друзья", t.friends, pv("friends"), "users"),
      tile("Ваши записи", t.posts, pv("posts"), "edit"),
      tile("Просмотры историй", t.story_views, pv("story_views"), "story"));
    const empty = !engaged && !t.posts && !t.followers
      ? h("div.card.empty", icon("trend"), h("h3", "Пока тихо"), h("p", "Опубликуйте запись или историю — здесь появится, как на неё откликаются."),
        h("a.btn.primary", { href: "/" }, "Написать запись"))
      : null;
    body.replaceChildren(hero, tiles, ...(empty ? [empty] : [activityCard(data), reactionsCard(data), timeCard(data), topPostsCard(data), fansCard(data)]).filter(Boolean), overallCard(data));
  }

  const page = h("div.stack.st-page",
    h("div.page-head.st-head", h("div", h("h1", "Статистика"), h("p.muted", `${state.me.name.split(" ")[0]}, эту страницу видите только вы`)), seg),
    body);
  await load();
  return page;
}
