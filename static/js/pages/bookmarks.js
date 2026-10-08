// Закладки — сохранённые записи.
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { infiniteList, setTitle } from "../ui.js";
import { postCard } from "../components/post.js";

export async function bookmarksPage() {
  setTitle("Закладки");
  const card = h("div.card.feed");
  const list = infiniteList({
    load: (cursor) => api.get("/api/bookmarks", { cursor }),
    render: (p) => postCard(p, { onUnbookmark: (el) => el.remove() }),
    empty: h("div.card.empty", icon("bookmark"), h("h2", "Закладок пока нет"), h("p", "Нажмите на значок закладки под записью, чтобы сохранить её здесь.")),
    container: card,
  });
  return h("div.stack", h("div.page-head", h("h1", "Закладки")), list.el);
}
