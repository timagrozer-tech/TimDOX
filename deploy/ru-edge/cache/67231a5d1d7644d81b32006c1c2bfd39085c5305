// Отдельная страница записи — сразу с комментариями.
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { setTitle } from "../ui.js";
import { navigate } from "../router.js";
import { postCard } from "../components/post.js";

export async function postPage({ params }) {
  const post = await api.get(`/api/posts/${encodeURIComponent(params.id)}`);
  setTitle(post.text ? post.text.slice(0, 40) : `Запись ${post.author.name}`);
  const back = h("button.btn.ghost.icon-only.back", { type: "button", "aria-label": "Назад", onclick: () => (history.length > 1 ? history.back() : navigate("/")) }, icon("back"));
  return h("div.stack",
    h("div.page-head", back, h("h1", "Запись")),
    h("div.card.feed", postCard(post, { clamp: false, openComments: true, onDelete: () => navigate("/") })));
}
