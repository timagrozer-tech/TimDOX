// Артисты Yarko: карточка артиста, альбомы (создание, правка), музыкальные награды, лента артистов.
import { api, state } from "../api.js";
import { h, icon, avatar, pl } from "../dom.js";
import { modal, toast, toastError, setTitle, confirmDialog, showMenu } from "../ui.js";
import { navigate } from "../router.js";
import { fmtDur } from "../components/mediakit.js";
import { playQueue, setShuffle, hue } from "./player.js";
import { songRow, openSongForm } from "./songs.js";

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} млн` : n >= 1e4 ? `${Math.round(n / 1e3)} тыс.` : String(n || 0));

// ---------------------------------------------------------------- лента артистов (во вкладке «Песни»)
export async function artistsShelf() {
  let d;
  try { d = await api.get("/api/music/artists"); } catch { return null; }
  if (!d.items.length) return null;
  return h("section.mu-shelf",
    h("div.mu-shelf-head", h("div", h("h2", "Артисты Yarko"), h("p", "Авторы, которые публикуют свою музыку"))),
    h("div.mu-row.ar-row", d.items.map((a) => h("a.ar-tile", { href: `/music/artist/${a.user.username}` },
      h("span.ar-av", avatar(a.user, "lg", { presence: false })),
      h("b", a.name), h("small", `${pl(a.songs, ["песня", "песни", "песен"])} · ▶ ${fmtNum(a.plays)}`)))));
}

// ---------------------------------------------------------------- награды
function awardTile(a) {
  return h(`div.aw.${a.rarity}${a.earned ? ".on" : ""}`, { title: `${a.name} — ${a.why}` },
    h("span.aw-emoji", a.earned ? a.emoji : "🔒"),
    h("b", a.name), h("small", a.earned ? `получена ${new Date(a.at).toLocaleDateString("ru-RU")}` : a.why));
}

// ---------------------------------------------------------------- альбом-карточка
function albumCard(a) {
  return h("a.alb", { href: `/music/album/${a.id}` },
    h("span.alb-art", { style: { "--hue": String(hue(String(a.id) + a.title)) } },
      a.cover ? h("img", { src: a.cover, alt: "" }) : h("span.alb-ph", icon("music")),
      h("span.alb-kind", a.kind_name)),
    h("b.alb-title", a.title),
    h("small", `${pl(a.count, ["трек", "трека", "треков"])}${a.duration ? ` · ${Math.max(1, Math.round(a.duration / 60))} мин` : ""}`));
}

// ---------------------------------------------------------------- страница артиста
export async function artistPage({ params }) {
  setTitle("Артист");
  const d = await api.get(`/api/music/artists/${encodeURIComponent(params.username)}`);
  setTitle(d.name);
  const all = d.songs;
  const earned = d.awards.filter((a) => a.earned).length;
  let following = d.following;
  const followBtn = h("button.btn", { type: "button" });
  const paintFollow = () => {
    followBtn.className = `btn ${following ? "soft" : "primary"}`;
    followBtn.replaceChildren(icon(following ? "check" : "userPlus", "sm"), following ? "Вы подписаны" : "Подписаться");
  };
  followBtn.addEventListener("click", async () => {
    try {
      if (following) await api.del(`/api/people/${d.id}/follow`); else await api.post(`/api/people/${d.id}/follow`);
      following = !following; paintFollow();
      toast(following ? "Вы будете узнавать о новых песнях и альбомах" : "Вы отписались", { icon: "check" });
    } catch (e) { toastError(e); }
  });
  paintFollow();
  const stat = (n, label) => h("div.ap-stat", h("b", fmtNum(n)), h("small", label));
  const songsBox = h("div.card.mu-card.tr-list");
  const paintSongs = (list) => songsBox.replaceChildren(...list.map((t) => songRow(t, list, `Артист: ${d.name}`, () => navigate(location.pathname))));
  paintSongs(all);
  return h("div.mu-page.ap",
    h("a.mu-back", { href: "/music?tab=songs" }, icon("back", "sm"), "Песни"),
    h("section.ap-hero", { style: { "--hue": String(hue(d.username)) } },
      d.banner ? h("img.ap-banner", { src: d.banner, alt: "" }) : h("span.ap-banner.ap-banner-ph"),
      h("div.ap-head",
        h("span.ap-av", avatar(d.user, "xl", { presence: false })),
        h("div.ap-titles",
          h("small", d.genre_name ? `Артист · ${d.genre_name}` : "Артист Yarko"),
          h("h1", d.name),
          h("a.ap-user", { href: `/u/${d.username}` }, `@${d.username}`)),
        h("div.ap-stats", stat(d.stats.plays, "прослушиваний"), stat(d.stats.listeners, "слушателей"), stat(d.stats.followers, "подписчиков"), stat(d.stats.songs, "песен")),
        d.bio ? h("p.ap-bio", d.bio) : null,
        h("div.mu-mine-btns",
          all.length ? h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.top.length ? d.top : all, 0, `Артист: ${d.name}`); } }, icon("play", "sm"), "Слушать") : null,
          all.length > 2 ? h("button.btn.soft", { type: "button", onclick: () => { playQueue(all, Math.floor(Math.random() * all.length), `Артист: ${d.name}`); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку") : null,
          d.mine ? h("button.btn.soft", { type: "button", onclick: () => openArtistForm(d) }, icon("edit", "sm"), "Карточка") : followBtn,
          d.mine ? h("button.btn.soft", { type: "button", "aria-label": "Ещё", onclick: (e) => showMenu(e.currentTarget, [
            { label: "Опубликовать песню", icon: "upload", onClick: () => openSongForm(null, () => navigate(location.pathname)) },
            { label: "Создать альбом", icon: "list", onClick: () => openAlbumForm(null, () => navigate(location.pathname)) },
          ]) }, icon("more", "sm")) : null))),
    d.top.length > 1 ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Популярные"))),
      h("div.card.mu-card.tr-list", d.top.slice(0, 5).map((t, i) => songRow(t, d.top, `Артист: ${d.name}`, null, { num: i + 1 })))) : null,
    d.albums.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Альбомы"))), h("div.alb-grid", d.albums.map(albumCard))) : null,
    h("section.mu-shelf",
      h("div.mu-shelf-head", h("div", h("h2", "Музыкальные награды"), h("p", `${earned} из ${d.awards.length} — только за музыку в Yarko`))),
      h("div.aw-grid", d.awards.map(awardTile))),
    all.length ? h("section.mu-shelf", h("div.mu-shelf-head", h("div", h("h2", "Все песни"), h("p", pl(all.length, ["песня", "песни", "песен"])))), songsBox)
      : h("div.card.empty", h("p", d.mine ? "Опубликуйте первую песню — и карточка оживёт" : "Песен пока нет")));
}

function openArtistForm(d) {
  const name = h("input.input", { maxlength: 60, value: d.name, placeholder: "Сценическое имя", "aria-label": "Сценическое имя" });
  const bio = h("textarea.textarea", { rows: 4, maxlength: 1000, placeholder: "О себе: стиль, история, где выступаете", "aria-label": "О себе" });
  bio.value = d.bio || "";
  const genre = h("select.input", { "aria-label": "Основной жанр" }, h("option", { value: "" }, "Основной жанр"));
  api.get("/api/music/songs", { meta: 1 }).then((m) => m.genres.forEach((g) => genre.append(h("option", { value: g.slug, selected: d.genre === g.slug }, g.name)))).catch(() => {});
  const bannerIn = h("input", { type: "file", accept: "image/*", hidden: true });
  const save = h("button.btn.primary", { type: "button" }, "Сохранить");
  const m = modal({
    title: "Карточка артиста",
    body: h("div.song-form", name, genre, bio,
      h("div.song-pick", h("button.btn.soft", { type: "button", onclick: () => bannerIn.click() }, icon("image", "sm"), "Обложка карточки"), bannerIn,
        h("small.muted", "Широкая картинка сверху карточки — фото со сцены, логотип, атмосфера"))),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api.put("/api/music/artist", { name: name.value, bio: bio.value, genre: genre.value });
      if (bannerIn.files[0]) { const fd = new FormData(); fd.append("banner", bannerIn.files[0]); await api.form("/api/music/artist", fd); }
      m.close(); toast("Карточка обновлена", { icon: "check" }); navigate(location.pathname);
    } catch (e) { save.disabled = false; toastError(e); }
  });
}

// ---------------------------------------------------------------- альбомы
/** Создание (edit = null) или правка альбома: название, тип, описание, обложка и песни в нужном порядке */
export async function openAlbumForm(edit = null, onDone = null) {
  const me = state.me?.username;
  let mine = [];
  try { mine = (await api.get("/api/music/songs", { user: "me" })).items; } catch (e) { return toastError(e); }
  if (!mine.length) { toast("Сначала опубликуйте хотя бы одну песню", { icon: "music" }); return; }
  let order = edit ? edit.tracks.map((t) => t.id) : [];
  const title = h("input.input", { maxlength: 100, placeholder: "Название альбома", value: edit?.title || "", "aria-label": "Название альбома" });
  const kind = h("select.input", { "aria-label": "Тип релиза" },
    ...[["album", "Альбом"], ["ep", "EP (мини-альбом)"], ["single", "Сингл"]].map(([v, n]) => h("option", { value: v, selected: (edit?.kind || "album") === v }, n)));
  const about = h("textarea.textarea", { rows: 3, maxlength: 1500, placeholder: "Об альбоме (необязательно)", "aria-label": "Об альбоме" });
  about.value = edit?.about || "";
  const coverIn = h("input", { type: "file", accept: "image/*", hidden: true });
  const coverPrev = h("span.song-cover-prev", edit?.cover ? h("img", { src: edit.cover, alt: "" }) : icon("image"));
  coverIn.addEventListener("change", () => { const f = coverIn.files[0]; if (f) coverPrev.replaceChildren(h("img", { src: URL.createObjectURL(f), alt: "" })); });
  const list = h("div.alb-pick");
  const paint = () => list.replaceChildren(...mine.map((t) => {
    const n = order.indexOf(t.id) + 1;
    return h(`button.alb-pick-item${n ? ".on" : ""}`, { type: "button", "aria-pressed": String(!!n), onclick: () => {
      order = n ? order.filter((x) => x !== t.id) : [...order, t.id]; paint();
    } }, h("span.alb-num", n ? String(n) : "+"), h("span", h("b", t.title), h("small", fmtDur(t.duration))));
  }));
  paint();
  const save = h("button.btn.primary", { type: "button" }, edit ? "Сохранить" : "Выпустить");
  const m = modal({
    title: edit ? "Изменить альбом" : "Новый альбом",
    body: h("div.song-form",
      h("div.song-main",
        edit ? null : h("button.song-cover", { type: "button", "aria-label": "Обложка", onclick: () => coverIn.click() }, coverPrev, h("small", "Обложка"), coverIn),
        h("div.stack.grow", title, kind)),
      about,
      h("small", "Песни — нажимайте по порядку треков"), list),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
  });
  save.addEventListener("click", async () => {
    if (!title.value.trim()) { title.focus(); return toast("Укажите название", { error: true }); }
    if (!order.length) return toast("Выберите хотя бы одну песню", { error: true });
    save.disabled = true;
    try {
      let a;
      if (edit) a = await api.patch(`/api/music/albums/${edit.id}`, { title: title.value, kind: kind.value, about: about.value, songs: order });
      else {
        const fd = new FormData();
        fd.append("title", title.value); fd.append("kind", kind.value); fd.append("about", about.value); fd.append("songs", order.join(","));
        if (coverIn.files[0]) fd.append("cover", coverIn.files[0]);
        a = await api.form("/api/music/albums", fd);
      }
      m.close();
      toast(edit ? "Альбом сохранён" : `${a.kind_name} «${a.title}» вышел 💿`, { icon: "check" });
      if (onDone) onDone(a); else navigate(`/music/album/${a.id}`);
    } catch (e) { save.disabled = false; toastError(e); }
  });
  void me;
}

export async function albumPage({ params }) {
  setTitle("Альбом");
  const d = await api.get(`/api/music/albums/${encodeURIComponent(params.id)}`);
  setTitle(d.title);
  const ctx = `${d.kind_name}: ${d.title}`;
  return h("div.mu-page",
    h("a.mu-back", { href: d.artist ? `/music/artist/${d.artist.username}` : "/music?tab=songs" }, icon("back", "sm"), d.artist?.name || "Песни"),
    h("section.mu-cover-head.pl", { style: { "--hue": String(hue(String(d.id) + d.title)) } },
      d.cover ? h("img.mu-cover-img", { src: d.cover, alt: "" }) : h("span.mu-cover-emoji", "💿"),
      h("div",
        h("small", d.kind_name),
        h("h1", d.title),
        h("p", d.artist ? h("a", { href: `/music/artist/${d.artist.username}` }, d.artist.name) : "", ` · ${pl(d.tracks.length, ["трек", "трека", "треков"])}`,
          d.duration ? ` · ${Math.max(1, Math.round(d.duration / 60))} мин` : "", d.plays ? ` · ▶ ${fmtNum(d.plays)}` : ""),
        d.about ? h("p.alb-about", d.about) : null),
      h("div.mu-mine-btns",
        d.tracks.length ? h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(d.tracks, 0, ctx); } }, icon("play", "sm"), "Слушать") : null,
        d.mine ? h("button.btn.soft", { type: "button", onclick: () => openAlbumForm(d, () => navigate(location.pathname)) }, icon("edit", "sm"), "Изменить") : null,
        d.mine ? h("button.btn.ghost", { type: "button", onclick: async () => {
          if (!(await confirmDialog({ title: "Удалить альбом?", text: "Песни останутся у вас — исчезнет только сам альбом.", confirm: "Удалить", danger: true }))) return;
          try { await api.del(`/api/music/albums/${d.id}`); toast("Альбом удалён", { icon: "trash" }); navigate(`/music/artist/${d.artist.username}`); } catch (e) { toastError(e); }
        } }, icon("trash", "sm")) : null)),
    d.tracks.length ? h("div.card.mu-card.tr-list", d.tracks.map((t, i) => songRow(t, d.tracks, ctx, null, { num: i + 1 })))
      : h("div.card.empty", h("p", "В альбоме пока нет песен")));
}
