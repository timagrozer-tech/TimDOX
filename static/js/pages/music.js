// Раздел «Музыка»: чарт России, российские артисты и альбомы, радио, «Волна Круга», независимая сцена, «Моя музыка», поиск.
import { api } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { setTitle, toastError } from "../ui.js";
import { navigate, setCleanup } from "../router.js";
import { trackList, trackCard, shelf, playlistCard, genreTile, stationTile, artistCircle, albumCard, legendChip } from "../music/kit.js";
import { playQueue, subscribe, current, isPlaying, toggle, setLiked, setShuffle } from "../music/player.js";

const TABS = [["home", "Главная", "music"], ["chart", "Чарт", "trend"], ["my", "Моя музыка", "heart"], ["radio", "Радио", "radio"]];

function head(active, onSearch, q = "") {
  const input = h("input.mu-search-input", { type: "search", placeholder: "Песни, артисты, радиостанции", value: q, "aria-label": "Поиск музыки", autocomplete: "off", enterkeyhint: "search" });
  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => onSearch(input.value.trim()), 380); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); onSearch(input.value.trim()); } });
  return h("header.mu-head",
    h("div.mu-title-row",
      h("div", h("h1.mu-h1", "Музыка"), h("p.mu-lead", "Чарт России, любимые артисты, радио и новые открытия")),
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

// «Волна Круга» — бесконечный поток под вкус человека
function waveCard() {
  const btn = h("button.mw-play", { type: "button" }, icon("play"), h("span", "Слушать"));
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 600 200");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "mw-waves");
  const card = h("section.mw", { "aria-label": "Волна Круга" },
    svg,
    h("div.mw-body",
      h("span.mw-kicker", icon("headphones", "sm"), "Только для вас"),
      h("h2", "Волна Круга"),
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
      playQueue(d.items, 0, "Волна Круга");
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

// Главный блок: чарт России
function chartHero(chart) {
  const top = chart.slice(0, 3);
  return h("section.ru-hero", { "aria-label": "Чарт России" },
    h("div.ru-hero-body",
      h("span.ru-kicker", h("i.ru-flag"), "Топ-100 · Россия"),
      h("h2", "Чарт России"),
      h("p", "Самые популярные песни страны прямо сейчас. Фрагменты по 30 секунд — целиком в один тап в Яндекс Музыке или VK."),
      h("div.ru-hero-btns",
        h("button.mw-play", { type: "button", onclick: () => { setShuffle(false); playQueue(chart, 0, "Чарт России"); } }, icon("play"), h("span", "Слушать чарт")),
        h("a.ru-link", { href: "/music?tab=chart" }, "Весь топ-100", icon("back", "sm")))),
    h("div.ru-stack", { "aria-hidden": "true" }, top.map((t, i) => h(`span.ru-stack-${i}`, t.artwork ? h("img", { src: t.artwork, alt: "", referrerpolicy: "no-referrer" }) : null, h("b", String(i + 1))))));
}

function radioShelf(stations) {
  if (!stations?.length) return null;
  return h("section.mu-shelf",
    h("div.mu-shelf-head", h("div", h("h2", "Хиты в прямом эфире"), h("p", "Любимые песни целиком — на российских радиостанциях")),
      h("a.btn.soft.sm", { href: "/music?tab=radio" }, "Все станции")),
    h("div.mu-row.sr-row", stations.slice(0, 12).map((s) => stationTile(s, stations))));
}

async function homeTab(box) {
  const d = await api.get("/api/music/home");
  setLiked(d.liked);
  const ru = d.ru || {};
  const chart = ru.chart || [];
  const allTrending = d.trending;
  box.replaceChildren(
    chart.length ? chartHero(chart) : null,
    chart.length ? h("section.mu-shelf",
      h("div.mu-shelf-head", h("div", h("h2", "Топ-10 недели"), h("p", "По прослушиваниям в России")),
        h("a.btn.soft.sm", { href: "/music?tab=chart" }, "Весь чарт")),
      h("div.card.mu-card", trackList(chart.slice(0, 10), "Чарт России", { ranked: true }))) : null,
    ru.artists?.length ? shelf("Артисты чарта", ru.artists.map(artistCircle), { sub: "Кого слушают в России больше всего" }) : null,
    radioShelf(ru.radio),
    ru.albums?.length ? shelf("Популярные альбомы", ru.albums.map(albumCard)) : null,
    ru.legends?.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Легенды и любимцы"), h("p", "Русский рок, поп и рэп — все песни артиста в одном месте"))),
      h("div.lg-cloud", ru.legends.map(legendChip))) : null,
    d.friends.length ? shelf("Друзья слушают", d.friends.map((t) => trackCard(t, d.friends, "Друзья слушают")), { sub: "Что недавно отметили сердечком ваши друзья и подписки" }) : null,
    d.krug_top.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Любят в Круге"), h("p", "Больше всего сердечек за месяц"))),
      h("div.card.mu-card", trackList(d.krug_top, "Любят в Круге"))) : null,
    h("div.mu-divider", h("span", "Независимая сцена мира"), h("small", "полные треки молодых артистов без рекламы")),
    waveCard(),
    allTrending.length ? h("section.mu-shelf",
      h("div.mu-shelf-head", h("div", h("h2", "В тренде у независимых"), h("p", "Самое популярное за неделю")),
        h("button.btn.soft.sm", { type: "button", onclick: () => playQueue(allTrending, 0, "В тренде") }, icon("play", "sm"), "Слушать все")),
      h("div.card.mu-card", trackList(allTrending.slice(0, 10), "В тренде", { ranked: true }))) : null,
    h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Жанры"))), h("div.gt-grid", d.genres.map(genreTile))),
    shelf("Подборки недели", d.playlists.map(playlistCard)),
    shelf("Новые открытия", d.underground.map((t) => trackCard(t, d.underground, "Новые открытия")), { sub: "Молодые артисты, которых стоит услышать" }),
    d.online ? null : offline(),
    h("p.mu-credits", "Чарт, артисты и альбомы — Apple Music (официальные 30-секундные фрагменты). Полные треки — Audius. Радио — каталог Radio Browser."));
}

async function chartTab(box) {
  const d = await api.get("/api/music/chart");
  box.replaceChildren(
    h("section.mu-cover-head.chart", { style: { "--hue": "330" } },
      h("span.mu-cover-emoji", "🏆"),
      h("div", h("small", "Россия · обновляется каждый день"), h("h1", "Топ-100"), h("p", "Самые прослушиваемые песни страны. Фрагменты по 30 секунд, полные версии — в меню ⋯ у каждой песни.")),
      h("div.mu-mine-btns",
        h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.items, 0, "Чарт России"); } }, icon("play", "sm"), "Слушать"),
        h("button.btn.soft", { type: "button", onclick: () => { playQueue(d.items, Math.floor(Math.random() * d.items.length), "Чарт России"); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку"))),
    h("div.card.mu-card", trackList(d.items, "Чарт России", { ranked: true })));
}

async function myTab(box) {
  const d = await api.get("/api/music/likes");
  setLiked(d.items.map((t) => t.key));
  if (!d.items.length) {
    box.replaceChildren(h("div.card.empty.mu-empty", h("span.mu-empty-ic", icon("heart")), h("h3", "Здесь будет ваша музыка"),
      h("p", "Нажимайте ♥ у треков и радиостанций — они соберутся здесь, а «Волна Круга» начнёт подстраиваться под ваш вкус."),
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
  const ru = d.ru || [];
  if (!ru.length && !d.tracks.length && !d.stations.length) {
    box.replaceChildren(h("div.card.empty", icon("search"), h("h3", "Ничего не нашлось"), h("p", "Проверьте написание или попробуйте имя исполнителя.")));
    return;
  }
  // артисты, найденные среди песен, — быстрый переход на их страницу
  const artists = [];
  for (const t of ru) if (t.artist_id && !artists.some((a) => a.id === t.artist_id) && artists.length < 8) artists.push({ id: t.artist_id, name: t.artist, artwork: t.artwork });
  box.replaceChildren(
    artists.length ? shelf("Артисты", artists.map(artistCircle)) : null,
    ru.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Песни"), h("p", "Фрагменты по 30 секунд, полные версии — в меню ⋯"))), h("div.card.mu-card", trackList(ru, `Поиск: ${q}`))) : null,
    d.tracks.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Полные треки независимых артистов"))), h("div.card.mu-card", trackList(d.tracks, `Поиск: ${q}`))) : null,
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
      else if (tab === "chart") await chartTab(box);
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

export async function artistPage({ params }) {
  setTitle("Артист");
  const key = params.id;
  const d = await api.get("/api/music/artist", /^\d+$/.test(key) ? { id: key } : { name: key });
  const a = d.artist;
  setTitle(a.name);
  const ctx = a.name;
  return h("div.mu-page",
    h("a.mu-back", { href: "/music" }, icon("back", "sm"), "Музыка"),
    h("section.mu-cover-head.artist", { style: { "--hue": String((a.name.length * 53) % 360) } },
      a.artwork ? h("img.mu-cover-img.round", { src: a.artwork, alt: "", referrerpolicy: "no-referrer" }) : h("span.mu-cover-emoji.round", "🎤"),
      h("div", h("small", "Артист"), h("h1", a.name), h("p", d.tracks.length ? `${pl(d.tracks.length, ["песня", "песни", "песен"])} · фрагменты по 30 секунд` : "Песни не найдены")),
      d.tracks.length ? h("div.mu-mine-btns",
        h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.tracks, 0, ctx); } }, icon("play", "sm"), "Слушать"),
        h("button.btn.soft", { type: "button", onclick: () => { playQueue(d.tracks, Math.floor(Math.random() * d.tracks.length), ctx); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку")) : null),
    d.tracks.length ? h("div.card.mu-card", trackList(d.tracks, ctx)) : h("div.card.empty", h("p", "У этого исполнителя пока нет песен в каталоге")),
    h("p.mu-credits", "Фрагменты — Apple Music. Полные версии песен — в меню ⋯ у каждой песни."));
}

export async function albumPage({ params }) {
  setTitle("Альбом");
  const d = await api.get(`/api/music/album/${encodeURIComponent(params.id)}`);
  const a = d.album;
  setTitle(a.title);
  const q = encodeURIComponent(`${a.artist} ${a.title}`);
  return h("div.mu-page",
    h("a.mu-back", { href: "/music" }, icon("back", "sm"), "Музыка"),
    h("section.mu-cover-head.pl", { style: { "--hue": String((a.title.length * 37) % 360) } },
      a.artwork ? h("img.mu-cover-img", { src: a.artwork, alt: "", referrerpolicy: "no-referrer" }) : h("span.mu-cover-emoji", "💿"),
      h("div", h("small", ["Альбом", a.year].filter(Boolean).join(" · ")), h("h1", a.title), h("p", [a.artist, pl(d.tracks.length, ["песня", "песни", "песен"])].filter(Boolean).join(" · "))),
      h("div.mu-mine-btns",
        d.tracks.length ? h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.tracks, 0, a.title); } }, icon("play", "sm"), "Слушать") : null,
        h("a.btn.soft", { href: `https://music.yandex.ru/search?text=${q}`, target: "_blank", rel: "noopener" }, icon("external", "sm"), "Альбом целиком"))),
    d.tracks.length ? h("div.card.mu-card", trackList(d.tracks, a.title, { ranked: true })) : h("div.card.empty", h("p", "Песни альбома недоступны")));
}

export function openMusic() { navigate("/music"); }
