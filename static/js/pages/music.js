// Раздел «Музыка»: только полные треки — «Волна QEVI», радио, русскоязычная сцена, тренды, жанры, подборки, «Моя музыка», поиск.
import { api } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { setTitle, toastError } from "../ui.js";
import { navigate, setCleanup } from "../router.js";
import { trackList, trackCard, shelf, playlistCard, genreTile, stationTile } from "../music/kit.js";
import { playQueue, subscribe, current, isPlaying, toggle, setLiked, setShuffle } from "../music/player.js";

const TABS = [["home", "Главная", "music"], ["russian", "На русском", "mic"], ["my", "Моя музыка", "heart"], ["radio", "Радио", "radio"]];

function head(active, onSearch, q = "") {
  const input = h("input.mu-search-input", { type: "search", placeholder: "Треки, исполнители, радиостанции", value: q, "aria-label": "Поиск музыки", autocomplete: "off", enterkeyhint: "search" });
  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => onSearch(input.value.trim()), 380); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); onSearch(input.value.trim()); } });
  return h("header.mu-head",
    h("div.mu-title-row",
      h("div", h("h1.mu-h1", "Музыка"), h("p.mu-lead", "Полные треки, живое радио и новые открытия — без рекламы")),
      h("span.mu-logo", { "aria-hidden": "true" }, h("i"), h("i"), h("i"))),
    h("label.mu-search", icon("search"), input),
    h("nav.mu-tabs", { "aria-label": "Разделы музыки" }, TABS.map(([id, label, ic]) =>
      h(`a${active === id ? ".on" : ""}`, { href: id === "home" ? "/music" : `/music?tab=${id}`, "aria-current": active === id ? "page" : null }, icon(ic, "sm"), label))));
}

function offline() {
  return h("div.card.empty", icon("music"), h("h3", "Музыкальный каталог не отвечает"),
    h("p", "Похоже, сервис временно недоступен. Радио и «Моя музыка» могут работать — попробуйте их или зайдите чуть позже."),
    h("a.btn.primary", { href: "/music?tab=radio" }, "Включить радио"));
}

// «Волна QEVI» — бесконечный поток под вкус человека
function waveCard() {
  const btn = h("button.mw-play", { type: "button" }, icon("play"), h("span", "Слушать"));
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 600 200");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "mw-waves");
  const card = h("section.mw", { "aria-label": "Волна QEVI" },
    svg,
    h("div.mw-body",
      h("span.mw-kicker", icon("headphones", "sm"), "Только для вас"),
      h("h2", "Волна QEVI"),
      h("p", "Бесконечная музыка под ваш вкус. Отмечайте треки сердечком — волна будет точнее."),
      btn));
  // волны — SVG-пути (без innerHTML)
  [0, 1, 2].forEach((i) => {
    const p = document.createElementNS(NS, "path");
    const amp = 26 - i * 6, y = 110 + i * 22;
    let d = `M0 ${y}`;
    for (let x = 0; x <= 1200; x += 50) d += ` Q ${x + 25} ${y + (x / 50 % 2 ? amp : -amp)} ${x + 50} ${y}`;
    p.setAttribute("d", d);
    p.setAttribute("class", `mw-w mw-w${i}`);
    svg.append(p);
  });
  const paint = () => {
    const on = current() && isPlaying() && card.dataset.active === "1";
    card.classList.toggle("playing", !!on);
    btn.replaceChildren(icon(on ? "pause" : "play"), h("span", on ? "Пауза" : card.dataset.active === "1" && current() ? "Продолжить" : "Слушать"));
  };
  btn.addEventListener("click", async () => {
    if (card.dataset.active === "1" && current()) { toggle(); return; }
    btn.disabled = true;
    try {
      const d = await api.get("/api/music/wave");
      setShuffle(false);
      playQueue(d.items, 0, "Волна QEVI");
      card.dataset.active = "1";
    } catch (e) { toastError(e); }
    btn.disabled = false;
    paint();
  });
  const off = subscribe(paint);
  setCleanup(off);
  paint();
  return card;
}

function radioShelf(stations) {
  if (!stations?.length) return null;
  return h("section.mu-shelf",
    h("div.mu-shelf-head", h("div", h("h2", "Русские хиты в прямом эфире"), h("p", "Любимые песни целиком — на российских радиостанциях")),
      h("a.btn.soft.sm", { href: "/music?tab=radio" }, "Все станции")),
    h("div.mu-row.sr-row", stations.slice(0, 12).map((s) => stationTile(s, stations))));
}

async function homeTab(box) {
  const d = await api.get("/api/music/home");
  setLiked(d.liked);
  const ru = d.ru || {};
  const ruTracks = ru.tracks || [];
  const allTrending = d.trending;
  box.replaceChildren(
    waveCard(),
    radioShelf(ru.radio),
    ruTracks.length ? h("section.mu-shelf",
      h("div.mu-shelf-head", h("div", h("h2", "На русском"), h("p", "Полные треки русскоязычных исполнителей")),
        h("a.btn.soft.sm", { href: "/music?tab=russian" }, "Все")),
      h("div.card.mu-card", trackList(ruTracks.slice(0, 8), "На русском"))) : null,
    d.friends.length ? shelf("Друзья слушают", d.friends.map((t) => trackCard(t, d.friends, "Друзья слушают")), { sub: "Что недавно отметили сердечком ваши друзья и подписки" }) : null,
    d.krug_top.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Любят в QEVI"), h("p", "Больше всего сердечек за месяц"))),
      h("div.card.mu-card", trackList(d.krug_top, "Любят в QEVI"))) : null,
    allTrending.length ? h("section.mu-shelf",
      h("div.mu-shelf-head", h("div", h("h2", "В тренде недели"), h("p", "Самое популярное у независимых музыкантов мира")),
        h("button.btn.soft.sm", { type: "button", onclick: () => playQueue(allTrending, 0, "В тренде") }, icon("play", "sm"), "Слушать все")),
      h("div.card.mu-card", trackList(allTrending.slice(0, 10), "В тренде", { ranked: true }))) : null,
    h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Жанры"))), h("div.gt-grid", d.genres.map(genreTile))),
    shelf("Подборки недели", d.playlists.map(playlistCard)),
    shelf("Новые открытия", d.underground.map((t) => trackCard(t, d.underground, "Новые открытия")), { sub: "Молодые артисты, которых стоит услышать" }),
    d.online ? null : offline(),
    h("p.mu-credits", "Все треки — целиком: музыка с открытой платформы независимых музыкантов Audius, радио — каталог Radio Browser."));
}

async function russianTab(box) {
  const d = await api.get("/api/music/russian");
  box.replaceChildren(
    h("section.mu-cover-head", { style: { "--hue": "220" } },
      h("span.mu-cover-emoji", "🎙️"),
      h("div", h("small", "Полные треки"), h("h1", "На русском"), h("p", "Рэп, поп, рок и лирика от русскоязычных исполнителей — целиком и без рекламы.")),
      d.items.length ? h("div.mu-mine-btns",
        h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.items, 0, "На русском"); } }, icon("play", "sm"), "Слушать"),
        h("button.btn.soft", { type: "button", onclick: () => { playQueue(d.items, Math.floor(Math.random() * d.items.length), "На русском"); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку")) : null),
    d.items.length ? h("div.card.mu-card", trackList(d.items, "На русском")) : h("div.card.empty", h("p", "Пока ничего не нашлось — загляните чуть позже")),
    radioShelf((await api.get("/api/music/radio")).items));
}

async function myTab(box) {
  const d = await api.get("/api/music/likes");
  setLiked(d.items.map((t) => t.key));
  if (!d.items.length) {
    box.replaceChildren(h("div.card.empty.mu-empty", h("span.mu-empty-ic", icon("heart")), h("h3", "Здесь будет ваша музыка"),
      h("p", "Нажимайте ♥ у треков и радиостанций — они соберутся здесь, а «Волна QEVI» начнёт подстраиваться под ваш вкус."),
      h("a.btn.primary", { href: "/music" }, "Найти музыку")));
    return;
  }
  const tracks = d.items.filter((t) => !t.live), stations = d.items.filter((t) => t.live);
  box.replaceChildren(
    h("section.mu-mine",
      h("div.mu-mine-art", icon("heart")),
      h("div", h("h2", "Моя музыка"), h("p", pl(tracks.length, ["трек", "трека", "треков"]), stations.length ? ` · ${pl(stations.length, ["станция", "станции", "станций"])}` : "")),
      h("div.mu-mine-btns",
        tracks.length ? h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(tracks, 0, "Моя музыка"); } }, icon("play", "sm"), "Слушать") : null,
        tracks.length > 2 ? h("button.btn.soft", { type: "button", onclick: () => { playQueue(tracks, Math.floor(Math.random() * tracks.length), "Моя музыка"); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку") : null)),
    tracks.length ? h("div.card.mu-card", trackList(tracks, "Моя музыка")) : null,
    stations.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Мои станции"))), h("div.sr-grid", stations.map((s) => stationTile(s, stations)))) : null);
}

async function radioTab(box, tag = "") {
  const d = await api.get("/api/music/radio", { tag });
  const chips = h("div.mu-chips", d.tags.map((t) => h(`button${t.id === tag ? ".on" : ""}`, { type: "button", onclick: async () => {
    box.classList.add("loading");
    try { await radioTab(box, t.id); } catch (e) { toastError(e); }
    box.classList.remove("loading");
  } }, t.name)));
  box.replaceChildren(
    h("section.mu-radio-hero", h("span.mu-onair", h("i"), "В эфире"), h("h2", "Радио"), h("p", "Популярные российские станции в хорошем качестве. Слушайте фоном, пока листаете ленту.")),
    chips,
    d.items.length ? h("div.sr-grid", d.items.map((s) => stationTile(s, d.items))) : h("div.card.empty", h("p", "Станций с таким жанром не нашлось")));
}

async function searchView(box, q) {
  box.replaceChildren(h("div.spinner"));
  const d = await api.get("/api/music/search", { q });
  if (!d.tracks.length && !d.stations.length) {
    box.replaceChildren(h("div.card.empty", icon("search"), h("h3", "Ничего не нашлось"), h("p", "Попробуйте другое слово или имя исполнителя — ищем среди полных треков и радиостанций.")));
    return;
  }
  box.replaceChildren(
    d.tracks.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Треки"))), h("div.card.mu-card", trackList(d.tracks, `Поиск: ${q}`))) : null,
    d.stations.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Радиостанции"))), h("div.sr-grid", d.stations.map((s) => stationTile(s, d.stations)))) : null);
}

export async function musicPage({ query }) {
  setTitle("Музыка");
  const tab = TABS.some(([id]) => id === query.tab) ? query.tab : "home";
  const box = h("div.mu-body");
  let q = query.q || "";
  const load = async () => {
    try {
      if (q.length >= 2) await searchView(box, q);
      else if (tab === "my") await myTab(box);
      else if (tab === "radio") await radioTab(box);
      else if (tab === "russian") await russianTab(box);
      else await homeTab(box);
    } catch (e) {
      box.replaceChildren(e.status === 503 ? offline() : h("div.card.empty", h("h3", "Не удалось загрузить музыку"), h("p", e.message)));
    }
  };
  const onSearch = (value) => {
    q = value;
    history.replaceState(history.state, "", q.length >= 2 ? `/music?q=${encodeURIComponent(q)}` : tab === "home" ? "/music" : `/music?tab=${tab}`);
    load();
  };
  const page = h("div.mu-page", head(tab, onSearch, q), box);
  await load();
  return page;
}

export async function genrePage({ params }) {
  setTitle("Музыка");
  const d = await api.get("/api/music/genre", { g: params.slug });
  setTitle(d.genre.name);
  return h("div.mu-page",
    h("a.mu-back", { href: "/music" }, icon("back", "sm"), "Музыка"),
    h("section.mu-cover-head", { style: { "--hue": String((params.slug.length * 47) % 360) } },
      h("span.mu-cover-emoji", d.genre.emoji),
      h("div", h("small", "Жанр"), h("h1", d.genre.name), h("p", `${pl(d.items.length, ["трек", "трека", "треков"])} в тренде недели`)),
      h("button.btn.primary.mu-cover-play", { type: "button", onclick: () => { setShuffle(false); playQueue(d.items, 0, `Жанр: ${d.genre.name}`); } }, icon("play", "sm"), "Слушать")),
    d.items.length ? h("div.card.mu-card", trackList(d.items, `Жанр: ${d.genre.name}`, { ranked: true })) : h("div.card.empty", h("p", "В этом жанре пока пусто")));
}

export async function playlistPage({ params }) {
  setTitle("Подборка");
  const d = await api.get(`/api/music/playlist/${encodeURIComponent(params.id)}`);
  const p = d.playlist || { title: "Подборка", artist: "", count: d.tracks.length };
  setTitle(p.title);
  const total = d.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  return h("div.mu-page",
    h("a.mu-back", { href: "/music" }, icon("back", "sm"), "Музыка"),
    h("section.mu-cover-head.pl", { style: { "--hue": String((params.id.length * 71) % 360) } },
      p.artwork ? h("img.mu-cover-img", { src: p.artwork, alt: "", referrerpolicy: "no-referrer" }) : h("span.mu-cover-emoji", "🎧"),
      h("div", h("small", "Подборка"), h("h1", p.title), h("p", [p.artist, pl(d.tracks.length, ["трек", "трека", "треков"]), total ? `${Math.round(total / 60)} мин` : ""].filter(Boolean).join(" · "))),
      h("button.btn.primary.mu-cover-play", { type: "button", onclick: () => { setShuffle(false); playQueue(d.tracks, 0, p.title); } }, icon("play", "sm"), "Слушать")),
    d.tracks.length ? h("div.card.mu-card", trackList(d.tracks, p.title)) : h("div.card.empty", h("p", "Подборка пуста")),
    h("p.mu-credits", "Подборка с платформы Audius"));
}

export function openMusic() { navigate("/music"); }
