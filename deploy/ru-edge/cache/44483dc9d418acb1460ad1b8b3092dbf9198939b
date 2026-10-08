// Поиск людей, записей и хэштегов; страница хэштега.
import { api } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { infiniteList, setTitle } from "../ui.js";
import { postCard, communityAvatar } from "../components/post.js";
import { personRow, defaultPersonActions } from "../components/people.js";

export async function searchPage({ query }) {
  setTitle("Поиск");
  let type = ["people", "posts", "tags", "communities"].includes(query.type) ? query.type : "all";
  const input = h("input.input", { type: "search", name: "q", value: query.q || "", placeholder: "Имя, город, место учёбы, #тег или текст записи", "aria-label": "Поисковый запрос", autocomplete: "off" });
  const results = h("div.stack");
  const seg = h("div.segmented", { role: "group", "aria-label": "Что искать" });
  const types = [["all", "Всё"], ["people", "Люди"], ["communities", "Сообщества"], ["posts", "Записи"], ["tags", "Хэштеги"]];
  seg.append(...types.map(([id, label]) => h("button", { type: "button", "aria-pressed": String(id === type), onclick: () => { type = id; run(); } }, label)));

  let timer = null, gen = 0;
  async function run() {
    seg.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(types[i][0] === type)));
    const q = input.value.trim();
    const url = `/search${q ? `?q=${encodeURIComponent(q)}${type !== "all" ? `&type=${type}` : ""}` : ""}`;
    history.replaceState({}, "", url);
    if (!q) {
      results.replaceChildren(h("div.card.empty", icon("search"), h("h3", "Найдите друзей и интересные записи"), h("p", "Ищите по имени, логину, городу, месту учёбы или работы.")));
      return;
    }
    const my = ++gen;
    results.replaceChildren(h("div.spinner"));
    let data;
    try { data = await api.get("/api/search", { q, type }); } catch (e) { results.replaceChildren(h("p.muted", e.message)); return; }
    if (my !== gen) return;
    const blocks = [];
    if (data.people.length) blocks.push(h("section.card", h("div.card-pad", { style: { paddingBottom: 0 } }, h("h2.card-title", icon("users", "sm"), "Люди")),
      h("div.people", data.people.map((p) => personRow(p, defaultPersonActions)))));
    if (data.communities?.length) blocks.push(h("section.card", h("div.card-pad", { style: { paddingBottom: 0 } }, h("h2.card-title", icon("community", "sm"), "Сообщества")),
      h("div.people", data.communities.map((c) => h("a.person.comm-row", { href: `/c/${c.slug}` }, communityAvatar(c, "lg"),
        h("div.who", h("span.name", c.name), h("div.sub", `${c.is_private ? "Закрытое" : "Открытое"} · ${pl(c.members_count, ["участник", "участника", "участников"])}`)))))));
    if (data.tags.length) blocks.push(h("section.card.card-pad", h("h2.card-title", icon("hash", "sm"), "Хэштеги"),
      h("div", data.tags.map((t) => h("a.trend", { href: `/tag/${encodeURIComponent(t.tag)}` }, h("b", `#${t.tag}`), h("small", pl(t.n, ["запись", "записи", "записей"])))))));
    if (data.posts.length) blocks.push(h("section", h("h2.card-title", { style: { padding: "4px 4px 0" } }, icon("edit", "sm"), "Записи"),
      h("div.card.feed", data.posts.map((p) => postCard(p)))));
    results.replaceChildren(...(blocks.length ? blocks : [h("div.card.empty", icon("search"), h("h3", "Ничего не найдено"), h("p", `По запросу «${q}» ничего нет. Попробуйте изменить запрос.`))]));
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  const form = h("form.search-box", { role: "search", onsubmit: (e) => { e.preventDefault(); clearTimeout(timer); run(); } }, icon("search"), input);
  run();
  setTimeout(() => input.focus(), 50);
  return h("div.stack", h("div.page-head", h("h1", "Поиск")), form, seg, results);
}

export async function tagPage({ params }) {
  const tag = params.tag.toLowerCase().replace(/^#/, "");
  setTitle(`#${tag}`);
  const count = h("p.muted");
  const card = h("div.card.feed");
  const list = infiniteList({
    load: (cursor) => api.get(`/api/tags/${encodeURIComponent(tag)}`, { cursor }),
    render: (p) => postCard(p),
    empty: h("div.card.empty", icon("hash"), h("h3", "Записей с этим тегом нет"), h("p", "Станьте первым — добавьте тег в свою запись.")),
    container: card,
    onLoaded: (d) => { if (d.total != null) count.textContent = pl(d.total, ["запись", "записи", "записей"]); },
  });
  return h("div.stack",
    h("div.card.tag-head", h("div.tag-icon", icon("hash", "lg")), h("div", h("h1", { style: { fontSize: "24px" } }, `#${tag}`), count)),
    list.el);
}
