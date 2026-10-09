// «Песни Yarko»: песни, которые публикуют сами люди. Лента (новые, популярные, мои), жанры, публикация, правка, удаление.
// Играют в общем плеере; аудио — готовый файл на нашем хостинге (без внешних сервисов).
import { api, state } from "../api.js";
import { h, icon, pl, thumb } from "../dom.js";
import { modal, toast, toastError, showMenu, confirmDialog } from "../ui.js";
import { navigate } from "../router.js";
import { fmtDur } from "../components/mediakit.js";
import { playFrom, playNext, current, isPlaying, likeButton, coverOf, shareTrack, toggleLike, isLiked } from "./player.js";

const MAX_MB = 25;
const eq = () => h("span.mu-eq", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"));
const stateCls = (t) => { const c = current(); return c && c.key === t.key ? (isPlaying() ? ".is-current.is-playing" : ".is-current") : ""; };

/** Меню песни: следующей, в мою музыку, в ленту, автор, а у своих — правка и удаление */
function songMenu(anchor, t, onChange) {
  showMenu(anchor, [
    { label: "Играть следующей", icon: "queueAdd", onClick: () => playNext(t) },
    { label: isLiked(t.key) ? "Убрать из «Моей музыки»" : "В «Мою музыку»", icon: "heart", onClick: () => toggleLike(t) },
    { label: "Поделиться в ленте", icon: "share", onClick: () => shareTrack(t) },
    t.author ? { label: `Профиль: ${t.author.name}`, icon: "user", onClick: () => navigate(`/u/${t.author.username}`) } : null,
    t.lyrics ? { label: "Текст песни", icon: "book", onClick: () => modal({ title: t.title, body: h("pre.song-lyrics", t.lyrics) }) } : null,
    t.mine ? "-" : null,
    t.mine ? { label: "Изменить", icon: "edit", onClick: () => openSongForm(null, (s) => onChange?.("edit", s), t) } : null,
    t.mine || state.me?.is_admin ? { label: "Удалить песню", icon: "trash", danger: true, onClick: async () => {
      if (!(await confirmDialog({ title: "Удалить песню?", text: `«${t.title}» исчезнет у всех, в том числе из «Моей музыки».`, confirm: "Удалить", danger: true }))) return;
      try { await api.del(`/api/music/songs/${t.id}`); toast("Песня удалена", { icon: "trash" }); onChange?.("delete", t); } catch (e) { toastError(e); }
    } } : null,
  ], { title: t.title });
}

export function songRow(t, list, context, onChange) {
  const more = h("button.tr-more", { type: "button", "aria-label": "Ещё" }, icon("more"));
  more.addEventListener("click", (e) => { e.stopPropagation(); songMenu(more, t, onChange); });
  const who = t.artist || t.author?.name || "";
  const row = h(`div.tr.song-row${stateCls(t)}`, { dataset: { track: t.key }, role: "button", tabindex: 0, "aria-label": `${t.title} — ${who}` },
    h("span.tr-cover", coverOf(t), h("span.tr-over", icon("play", "sm"), icon("pause", "sm")), eq()),
    h("span.tr-main", h("span.tr-title", t.title),
      h("span.tr-sub", who, t.author && t.artist && t.artist !== t.author.name ? ` · ${t.author.name.split(" ")[0]}` : "",
        t.plays ? ` · ▶ ${t.plays}` : "", t.genre_name ? ` · ${t.genre_name}` : "")),
    t.likes > 0 ? h("span.tr-likes", icon("heart", "sm"), String(t.likes)) : null,
    h("span.tr-dur", fmtDur(t.duration)),
    likeButton(t, "tr-like"),
    more);
  const go = () => playFrom(list, t, context);
  row.addEventListener("click", go);
  row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  return row;
}

/** Карточка песни для горизонтальной ленты на главной «Музыки» */
export function songCard(t, list) {
  const card = h(`div.tc${stateCls(t)}`, { dataset: { track: t.key }, role: "button", tabindex: 0, "aria-label": `${t.title} — ${t.artist || t.author?.name}` },
    h("span.tc-art", coverOf(t), h("span.tc-fab", icon("play"), icon("pause")), eq(),
      t.author ? h("span.tc-by", { title: t.author.name }, t.author.avatar ? h("img", { src: thumb(t.author.avatar), alt: "" }) : t.author.name[0]) : null),
    h("span.tc-title", t.title),
    h("span.tc-sub", t.artist || t.author?.name || ""));
  const go = () => playFrom(list, t, "Песни Yarko");
  card.addEventListener("click", go);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return card;
}

/** Вкладка «Песни» */
export async function songsTab(box) {
  const first = await api.get("/api/music/songs");
  let sort = "new", genre = "", items = first.items, next = first.next, seq = 0;
  const list = h("div.tr-list");
  const moreBtn = h("button.btn.soft.mu-more", { type: "button" }, "Показать ещё");
  const empty = h("div.card.empty.mu-empty", { hidden: true });
  const onChange = (kind, s) => {
    if (kind === "delete") items = items.filter((x) => x.id !== s.id);
    else if (kind === "edit") items = items.map((x) => (x.id === s.id ? s : x));
    else if (kind === "new") items = [s, ...items];
    paint();
  };
  const paint = () => {
    list.replaceChildren(...items.map((t) => songRow(t, items, "Песни Yarko", onChange)));
    moreBtn.hidden = !next;
    empty.hidden = items.length > 0;
    empty.replaceChildren(h("span.mu-empty-ic", icon("mic")),
      h("h2", sort === "mine" ? "Вы ещё не публиковали песен" : "Здесь пока тихо"),
      h("p", "Загрузите свою песню — её смогут послушать все в Yarko."),
      h("button.btn.primary", { type: "button", onclick: () => openSongForm(null, (s) => onChange("new", s)) }, icon("upload", "sm"), "Опубликовать песню"));
  };
  const load = async (append = false) => {
    const my = ++seq;
    const params = { sort: sort === "mine" ? "new" : sort, genre, user: sort === "mine" ? "me" : "" };
    if (append && next) params.cursor = next;
    box.classList.add("loading");
    try {
      const d = await api.get("/api/music/songs", params);
      if (my !== seq) return;
      items = append ? [...items, ...d.items] : d.items;
      next = d.next;
      paint();
    } catch (e) { toastError(e); }
    box.classList.remove("loading");
  };
  moreBtn.addEventListener("click", () => load(true));
  const chip = (label, on, fn) => h(`button${on ? ".on" : ""}`, { type: "button", "aria-pressed": String(on), onclick: fn }, label);
  const sorts = h("div.mu-chips");
  const genres = h("div.mu-chips.song-genres");
  const paintChips = () => {
    sorts.replaceChildren(
      chip("Новые", sort === "new", () => { sort = "new"; paintChips(); load(); }),
      chip("Популярные", sort === "popular", () => { sort = "popular"; paintChips(); load(); }),
      chip("Мои песни", sort === "mine", () => { sort = "mine"; paintChips(); load(); }));
    genres.replaceChildren(chip("Все жанры", !genre, () => { genre = ""; paintChips(); load(); }),
      ...first.genres.map((g) => chip(g.name, genre === g.slug, () => { genre = g.slug; paintChips(); load(); })));
  };
  paintChips(); paint();
  box.replaceChildren(
    h("section.mu-cover-head.song-hero", { style: { "--hue": "280" } },
      h("span.mu-cover-emoji", "🎙️"),
      h("div", h("small", "Музыка от людей Yarko"), h("h1", "Песни"), h("p", "Публикуйте свои песни — их услышат все. Слушайте авторов из сообщества.")),
      h("div.mu-mine-btns",
        h("button.btn.primary", { type: "button", onclick: () => openSongForm(null, (s) => { if (sort !== "popular") onChange("new", s); }) }, icon("upload", "sm"), "Опубликовать"),
        h("button.btn.soft", { type: "button", onclick: () => items.length && playFrom(items, items[0], "Песни Yarko") }, icon("play", "sm"), "Слушать"))),
    sorts, genres,
    h("div.card.mu-card", list), empty, moreBtn);
}

// ---------------------------------------------------------------- публикация и правка
function audioDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

/** Окно публикации (file — уже выбранный файл или null) или правки (edit — песня) */
export async function openSongForm(file, onDone, edit = null) {
  const genresList = (await api.get("/api/music/songs", { meta: 1 }).catch(() => ({ genres: [] }))).genres;
  let audio = file, duration = 0, coverFile = null;
  const title = h("input.input", { maxlength: 120, placeholder: "Название песни", value: edit?.title || "", "aria-label": "Название", required: true });
  const artist = h("input.input", { maxlength: 80, placeholder: `Исполнитель (по умолчанию — ${state.me?.name || "вы"})`, value: edit?.artist || "", "aria-label": "Исполнитель" });
  const genre = h("select.input", { "aria-label": "Жанр" }, h("option", { value: "" }, "Жанр"),
    ...genresList.map((g) => h("option", { value: g.slug, selected: (edit?.genre || "") === g.slug }, g.name)));
  const lyrics = h("textarea.textarea", { rows: 4, maxlength: 6000, placeholder: "Текст песни (необязательно)", "aria-label": "Текст песни" });
  lyrics.value = edit?.lyrics || "";
  const fileLabel = h("span.song-file-name", edit ? "" : "Файл не выбран");
  const coverPrev = h("span.song-cover-prev", edit?.artwork ? h("img", { src: edit.artwork, alt: "" }) : icon("image"));
  const bar = h("div.bar", { hidden: true }, h("i", { style: { width: "0%" } }));
  const status = h("small.muted");
  const save = h("button.btn.primary", { type: "button" }, edit ? "Сохранить" : "Опубликовать");
  let upload = null;

  const pickAudio = async (f) => {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) { toast(`Файл больше ${MAX_MB} МБ — выберите сжатый MP3 или M4A`, { error: true }); return; }
    audio = f;
    duration = await audioDuration(f);
    fileLabel.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} МБ${duration ? ` · ${fmtDur(duration)}` : ""}`;
    if (!title.value.trim()) title.value = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").slice(0, 120);
  };
  const audioInput = h("input", { type: "file", accept: "audio/*,.mp3,.m4a,.ogg,.wav,.flac", hidden: true, onchange: () => pickAudio(audioInput.files[0]) });
  const coverInput = h("input", { type: "file", accept: "image/*", hidden: true, onchange: () => {
    const f = coverInput.files[0]; if (!f) return;
    coverFile = f; coverPrev.replaceChildren(h("img", { src: URL.createObjectURL(f), alt: "" }));
  } });
  if (file) await pickAudio(file);

  const m = modal({
    title: edit ? "Изменить песню" : "Новая песня",
    body: h("div.song-form",
      edit ? null : h("div.song-pick",
        h("button.btn.soft", { type: "button", onclick: () => audioInput.click() }, icon("music", "sm"), "Выбрать файл"),
        fileLabel, audioInput,
        h("small.muted", `MP3, M4A, OGG, WAV или FLAC, до ${MAX_MB} МБ`)),
      h("div.song-main",
        edit ? null : h("button.song-cover", { type: "button", "aria-label": "Обложка", onclick: () => coverInput.click() }, coverPrev, h("small", "Обложка"), coverInput),
        h("div.stack.grow", title, artist, genre)),
      lyrics,
      h("small.muted", "Публикуйте только свои песни или те, на которые у вас есть права. Чужую музыку без разрешения удалим."),
      status, bar),
    footer: [h("button.btn.ghost", { type: "button", onclick: () => { upload?.abort(); m.close(); } }, "Отмена"), save],
    onClose: () => upload?.abort(),
  });

  save.addEventListener("click", async () => {
    if (!title.value.trim()) { title.focus(); return toast("Укажите название песни", { error: true }); }
    save.disabled = true;
    try {
      if (edit) {
        const s = await api.patch(`/api/music/songs/${edit.id}`, { title: title.value, artist: artist.value, genre: genre.value || edit.genre, lyrics: lyrics.value });
        m.close(); toast("Сохранено", { icon: "check" }); onDone?.(s);
        return;
      }
      if (!audio) { save.disabled = false; return toast("Выберите файл песни", { error: true }); }
      const fd = new FormData();
      fd.append("title", title.value);
      fd.append("artist", artist.value);
      fd.append("genre", genre.value);
      fd.append("lyrics", lyrics.value);
      if (duration) fd.append("duration", String(duration));
      if (coverFile) fd.append("cover", coverFile, coverFile.name || "cover.jpg");
      fd.append("audio", audio, audio.name || "song.mp3");
      bar.hidden = false;
      upload = api.upload("/api/music/songs", fd, (p) => {
        bar.firstChild.style.width = `${Math.round(p * 100)}%`;
        status.textContent = p < 1 ? `Загружаем… ${Math.round(p * 100)}%` : "Сохраняем…";
      });
      const s = await upload.promise;
      upload = null;
      m.close();
      toast("Песня опубликована 🎶", { icon: "check" });
      onDone?.(s);
    } catch (e) {
      upload = null; save.disabled = false; status.textContent = "";
      if (e.code !== "aborted") toastError(e);
    }
  });
}

export const songsCount = (n) => pl(n, ["песня", "песни", "песен"]);
