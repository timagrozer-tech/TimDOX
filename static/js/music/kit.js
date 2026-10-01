// Элементы раздела «Музыка»: строки треков, карточки, подборки, жанры, станции, трек в записи и выбор трека.
import { api } from "../api.js";
import { h, icon, thumb } from "../dom.js";
import { modal, toastError } from "../ui.js";
import { fmtDur } from "../components/mediakit.js";
import { playFrom, playQueue, toggle, current, isPlaying, likeButton, trackMenu, coverOf, hue, loadLikes } from "./player.js";

const eq = () => h("span.mu-eq", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"));
const stateClasses = (t) => {
  const c = current();
  return c && c.key === t.key ? (isPlaying() ? ".is-current.is-playing" : ".is-current") : "";
};

/** Строка трека в списке. list — весь список (он станет очередью), context — подпись «откуда играет» */
export function trackRow(t, list, context = "", { rank = null } = {}) {
  const more = h("button.tr-more", { type: "button", "aria-label": "Ещё" }, icon("more"));
  more.addEventListener("click", (e) => { e.stopPropagation(); trackMenu(more, t); });
  const row = h(`div.tr${stateClasses(t)}`, { dataset: { track: t.key }, role: "button", tabindex: 0, "aria-label": `${t.title} — ${t.artist}` },
    rank != null ? h("span.tr-rank", String(rank)) : null,
    h("span.tr-cover", coverOf(t), h("span.tr-over", icon("play", "sm"), icon("pause", "sm")), eq()),
    h("span.tr-main", h("span.tr-title", t.title), h("span.tr-sub", t.live ? "в эфире · " : "", t.by ? `${t.by.name.split(" ")[0]} · ` : "", t.artist)),
    t.likes > 1 ? h("span.tr-likes", icon("heart", "sm"), String(t.likes)) : null,
    h("span.tr-dur", t.live ? h("span.mu-live", "LIVE") : fmtDur(t.duration)),
    likeButton(t, "tr-like"),
    more);
  const go = () => playFrom(list, t, context);
  row.addEventListener("click", go);
  row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  return row;
}

export function trackList(list, context, opts = {}) {
  return h("div.tr-list", list.map((t, i) => trackRow(t, list, context, { rank: opts.ranked ? i + 1 : null })));
}

/** Квадратная карточка трека для горизонтальных лент */
export function trackCard(t, list, context = "") {
  const card = h(`div.tc${stateClasses(t)}`, { dataset: { track: t.key }, role: "button", tabindex: 0, "aria-label": `${t.title} — ${t.artist}` },
    h("span.tc-art", coverOf(t), h("span.tc-fab", icon("play"), icon("pause")), eq(),
      t.by ? h("span.tc-by", { title: `${t.by.name} любит этот трек` }, t.by.avatar ? h("img", { src: thumb(t.by.avatar), alt: "", loading: "lazy" }) : t.by.name[0]) : null),
    h("span.tc-title", t.title),
    h("span.tc-sub", t.by ? `♥ ${t.by.name.split(" ")[0]}` : t.artist));
  const go = () => playFrom(list, t, context);
  card.addEventListener("click", go);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return card;
}

export function shelf(title, items, { more = null, sub = null } = {}) {
  if (!items?.length) return null;
  return h("section.mu-shelf",
    h("div.mu-shelf-head", h("div", h("h2", title), sub ? h("p", sub) : null), more),
    h("div.mu-row", items));
}

export function playlistCard(p) {
  return h("a.pc", { href: `/music/playlist/${encodeURIComponent(p.id)}` },
    h("span.pc-art", { style: { "--hue": String(hue(p.id)) } }, h("span.pc-back"), h("span.pc-back2"),
      p.artwork ? h("img", { src: p.artwork, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span.mu-cover.mu-cover-empty", icon("list"))),
    h("span.tc-title", p.title),
    h("span.tc-sub", `${p.count} ${p.count % 10 === 1 && p.count % 100 !== 11 ? "трек" : "треков"} · ${p.artist}`));
}

export function genreTile(g, i) {
  return h("a.gt", { href: `/music/genre/${g.slug}`, style: { "--gi": String(i) } },
    h("span.gt-emoji", { "aria-hidden": "true" }, g.emoji), h("b", g.name));
}

export function stationTile(s, list) {
  const tile = h(`div.st-radio${stateClasses(s)}`, { dataset: { track: s.key }, role: "button", tabindex: 0, "aria-label": s.title },
    h("span.sr-logo", { style: { "--hue": String(hue(s.key)) } },
      s.artwork ? h("img", { src: s.artwork, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      h("span.sr-letter", s.title.replace(/^(радио|radio)\s+/i, "")[0] || "R"), eq()),
    h("span.sr-name", s.title), h("span.sr-tags", s.artist),
    likeButton(s, "sr-like"));
  const go = () => playFrom(list, s, "Радио");
  tile.addEventListener("click", go);
  tile.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return tile;
}

/** Трек, прикреплённый к записи в ленте */
export function musicAttachment(t, { removable = null } = {}) {
  const card = h(`div.mu-attach${stateClasses(t)}`, { dataset: { track: t.key } },
    h("button.ma-play", { type: "button", "aria-label": `Слушать «${t.title}»` }, coverOf(t), h("span.ma-icon", icon("play"), icon("pause")), eq()),
    h("div.ma-main",
      h("b.ma-title", t.title),
      h("span.ma-artist", t.artist),
      h("span.ma-src", t.live ? icon("radio", "sm") : icon("music", "sm"), t.live ? "Радио в Круге" : "Музыка Круга", t.duration ? ` · ${fmtDur(t.duration)}` : "")),
    removable ? h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Убрать трек", onclick: removable }, icon("x", "sm")) : likeButton(t, "ma-like"));
  card.querySelector(".ma-play").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const c = current();
    if (c && c.key === t.key) toggle(); else playQueue([t], 0, "Из ленты");
  });
  loadLikes();
  return card;
}

/** Окно выбора трека для записи: поиск по каталогу и «Моя музыка» */
export function pickTrack() {
  return new Promise((resolve) => {
    let done = false, timer = null, seq = 0;
    const input = h("input.input.mu-pick-input", { type: "search", placeholder: "Найти трек или исполнителя", "aria-label": "Поиск трека", autocomplete: "off" });
    const list = h("div.mu-pick-list", h("div.spinner"));
    const choose = (t) => { done = true; m.close(); resolve(t); };
    const paint = (items, empty) => {
      list.replaceChildren(...(items.length ? items.map((t) => h("button.mu-pick-item", { type: "button", onclick: () => choose(t) },
        coverOf(t), h("span", h("b", t.title), h("small", t.artist)), h("small.mu-pick-dur", t.live ? "эфир" : fmtDur(t.duration))))
        : [h("p.muted.mu-pick-empty", empty)]));
    };
    const showLiked = async () => {
      try { const d = await api.get("/api/music/likes"); paint(d.items, "В «Моей музыке» пока пусто — найдите трек поиском"); } catch (e) { toastError(e); }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { showLiked(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        list.replaceChildren(h("div.spinner"));
        try {
          const d = await api.get("/api/music/search", { q });
          if (my === seq) paint([...d.tracks, ...d.stations], "Ничего не нашлось");
        } catch (e) { toastError(e); }
      }, 350);
    });
    const m = modal({ title: "Добавить музыку", body: h("div.mu-pick", input, list), onClose: () => { if (!done) resolve(null); } });
    showLiked();
    setTimeout(() => input.focus(), 60);
  });
}
