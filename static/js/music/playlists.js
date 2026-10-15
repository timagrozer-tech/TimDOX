// Свои плейлисты, «Отправить другу» и текст песни.
import { api } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { modal, toast, toastError, confirmDialog, promptDialog, setTitle } from "../ui.js";
import { navigate } from "../router.js";
import { playQueue, setShuffle, artUrl, hue } from "./player.js";
import { trackList } from "./kit.js";

const trackWord = (n) => pl(n, ["трек", "трека", "треков"]);

/** Обложка плейлиста: мозаика из первых четырёх обложек треков */
function mosaic(covers, id) {
  const c = (covers || []).slice(0, 4);
  if (!c.length) return h("span.upl-art.empty", { style: { "--hue": String(hue(String(id))) } }, icon("list"));
  if (c.length < 4) return h("span.upl-art", h("img", { src: artUrl(c[0]), alt: "", loading: "lazy" }));
  return h("span.upl-art.grid4", c.map((u) => h("img", { src: artUrl(u), alt: "", loading: "lazy" })));
}

export function playlistTile(p) {
  return h("a.upl", { href: `/music/my/${p.id}` }, mosaic(p.covers, p.id), h("b", p.title), h("small", trackWord(p.count)));
}

/** Блок «Мои плейлисты» во вкладке «Моя музыка» */
export async function playlistsShelf() {
  const box = h("section.mu-shelf.upl-shelf");
  const paint = (items) => box.replaceChildren(
    h("div.mu-shelf-head", h("div", h("h2", "Мои плейлисты"), h("p", items.length ? "Ваши подборки — слушайте и делитесь ссылкой" : "Соберите любимые песни в подборку")),
      h("button.btn.soft.sm", { type: "button", onclick: async () => {
        const title = await promptDialog({ title: "Новый плейлист", label: "Название", confirm: "Создать" });
        if (!title?.trim()) return;
        try { const p = await api.post("/api/music/my-playlists", { title }); navigate(`/music/my/${p.id}`); } catch (e) { toastError(e); }
      } }, icon("plus", "sm"), "Создать")),
    items.length ? h("div.upl-grid", items.map(playlistTile)) : null);
  try { paint((await api.get("/api/music/my-playlists")).items); } catch { paint([]); }
  return box;
}

/** «Добавить в плейлист» из меню трека */
export async function addToPlaylist(t) {
  let items = [];
  try { items = (await api.get("/api/music/my-playlists")).items; } catch (e) { toastError(e); return; }
  const add = async (p) => {
    try { await api.post(`/api/music/my-playlists/${p.id}/tracks`, { key: t.key }); m.close(); toast(`Добавлено в «${p.title}»`, { icon: "check" }); } catch (e) { toastError(e); }
  };
  const input = h("input.input", { placeholder: "Название нового плейлиста", maxlength: 80, "aria-label": "Название нового плейлиста" });
  const create = h("button.btn.primary", { type: "button", onclick: async () => {
    if (!input.value.trim()) { input.focus(); return; }
    try { const p = await api.post("/api/music/my-playlists", { title: input.value, key: t.key }); m.close(); toast(`Создан плейлист «${p.title}»`, { icon: "check" }); } catch (e) { toastError(e); }
  } }, "Создать");
  const m = modal({
    title: "Добавить в плейлист", narrow: true,
    body: h("div.stack",
      h("p.muted", { style: { margin: 0 } }, `«${t.title}»`),
      items.length ? h("div.upl-pick", items.map((p) => h("button.upl-pick-row", { type: "button", onclick: () => add(p) }, mosaic(p.covers, p.id),
        h("span", h("b", p.title), h("small", trackWord(p.count)))))) : null,
      h("div.row", input, create)),
  });
}

/** «Отправить другу»: песня приходит в личные сообщения карточкой, которую можно сразу включить */
export async function sendToFriend(t) {
  const { pickFriends } = await import("../components/people.js");
  const ids = await pickFriends({ title: "Кому отправить песню", confirm: "Отправить" });
  if (!ids?.length) return;
  let sent = 0;
  for (const uid of ids) {
    try {
      const c = await api.post("/api/conversations", { user_id: uid });
      await api.post(`/api/conversations/${c.id}/share`, { type: "track", key: t.key });
      sent += 1;
    } catch (e) { toastError(e); }
  }
  if (sent) toast(sent === 1 ? "Песня отправлена" : `Песня отправлена: ${sent}`, { icon: "send" });
}

/** Текст песни (у песен людей Yarko, если автор его добавил) */
export async function showLyrics(t) {
  let text = t.lyrics;
  if (text == null && t.source === "yarko") {
    try { text = (await api.get(`/api/music/songs/${t.id}`)).lyrics; } catch (e) { toastError(e); return; }
  }
  modal({ title: t.title, narrow: true,
    body: text ? h("pre.song-lyrics", text) : h("p.muted", "Автор пока не добавил текст этой песни.") });
}

/** Страница своего плейлиста: /music/my/:id */
export async function myPlaylistPage({ params }) {
  const p = await api.get(`/api/music/my-playlists/${encodeURIComponent(params.id)}`);
  setTitle(p.title);
  const listBox = h("div.card.mu-card");
  const paintList = () => {
    listBox.replaceChildren(p.tracks.length ? trackList(p.tracks, p.title)
      : h("div.empty.card-pad", h("p.muted", p.mine ? "Плейлист пуст. Добавляйте треки через «⋯» → «Добавить в плейлист»." : "Плейлист пока пуст.")));
    if (p.mine) {
      listBox.querySelectorAll(".tr").forEach((row, i) => {
        const del = h("button.tr-more.upl-del", { type: "button", "aria-label": "Убрать из плейлиста", title: "Убрать из плейлиста", onclick: async (e) => {
          e.stopPropagation();
          try { await api.del(`/api/music/my-playlists/${p.id}/tracks`, { key: p.tracks[i].key }); p.tracks.splice(i, 1); paintList(); } catch (err) { toastError(err); }
        } }, icon("x", "sm"));
        row.append(del);
      });
    }
  };
  paintList();
  const share = async () => {
    const url = `${location.origin}/music/my/${p.id}`;
    try { await navigator.clipboard.writeText(url); toast("Ссылка на плейлист скопирована", { icon: "link" }); } catch { toast(url); }
  };
  const actions = h("div.mu-mine-btns",
    p.tracks.length ? h("button.btn.primary", { type: "button", onclick: () => { setShuffle(false); playQueue(p.tracks, 0, p.title); } }, icon("play", "sm"), "Слушать") : null,
    p.tracks.length > 2 ? h("button.btn.soft", { type: "button", onclick: () => { playQueue(p.tracks, Math.floor(Math.random() * p.tracks.length), p.title); setShuffle(true); } }, icon("shuffle", "sm"), "Вперемешку") : null,
    h("button.btn.soft", { type: "button", onclick: share }, icon("link", "sm"), "Ссылка"),
    p.mine ? h("button.btn.soft", { type: "button", onclick: async () => {
      const title = await promptDialog({ title: "Переименовать плейлист", label: "Название", value: p.title, confirm: "Сохранить" });
      if (!title?.trim()) return;
      try { Object.assign(p, await api.patch(`/api/music/my-playlists/${p.id}`, { title })); head.querySelector("h1").textContent = p.title; } catch (e) { toastError(e); }
    } }, icon("edit", "sm"), "Название") : null,
    p.mine ? h("button.btn.soft", { type: "button", onclick: async () => {
      if (!await confirmDialog({ title: "Удалить плейлист?", text: "Сами песни останутся в «Музыке».", confirm: "Удалить", danger: true })) return;
      try { await api.del(`/api/music/my-playlists/${p.id}`); navigate("/music?tab=my"); } catch (e) { toastError(e); }
    } }, icon("trash", "sm"), "Удалить") : null);
  const head = h("section.mu-cover-head.upl-head", { style: { "--hue": String(hue(String(p.id))) } },
    mosaic(p.covers, p.id),
    h("div", h("small", p.mine ? "Мой плейлист" : `Плейлист · ${p.owner?.name || ""}`), h("h1", p.title), h("p", trackWord(p.tracks.length))),
    actions);
  return h("div.stack", h("a.mu-back", { href: "/music?tab=my" }, icon("back", "sm"), "Моя музыка"), head, listBox);
}

