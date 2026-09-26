// «Гости»: кто заходил на мою страницу за последние 30 дней.
import { api, state, setCounters } from "../api.js";
import { h, icon, avatar, timeAgo } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";

export async function guestsPage() {
  setTitle("Гости");
  const data = await api.get("/api/guests");
  setCounters({ guests: 0 });
  const toggle = h("input", { type: "checkbox", checked: data.invisible });
  toggle.addEventListener("change", async () => {
    try {
      await api.patch("/api/me/settings", { invisible: toggle.checked });
      toast(toggle.checked ? "Режим невидимки включён — вы не появитесь в чужих гостях" : "Режим невидимки выключен", { icon: "eye" });
    } catch (e) { toastError(e); toggle.checked = !toggle.checked; }
  });
  const list = data.items.length
    ? h("div.people", data.items.map((g) => h(`div.person${g.is_new ? ".is-new" : ""}`,
      h("a", { href: `/u/${g.username}`, "aria-label": g.name }, avatar(g, "lg")),
      h("div.who", h("a.name", { href: `/u/${g.username}` }, g.name),
        h("div.sub", [g.city, g.is_friend ? "друг" : null].filter(Boolean).join(" · ") || `@${g.username}`)),
      h("div.acts", g.is_new ? h("span.status-pill.online", "новый") : null, h("span.muted", { style: { fontSize: "13px" } }, timeAgo(g.visited_at))))))
    : h("div.empty", icon("eye"), h("h3", "Гостей пока не было"), h("p", "Здесь появятся люди, которые заходили на вашу страницу за последние 30 дней."));
  return h("div.stack",
    h("div.page-head", h("h1", "Гости")),
    h("div.card.card-pad", h("label.check", toggle, h("span", h("b", "Режим невидимки"), h("br"),
      "Ваши посещения чужих страниц не будут отображаться у них в гостях"))),
    h("div.card", list),
    h("p.muted", { style: { fontSize: "13px", textAlign: "center" } }, `Показаны посещения за 30 дней. ${state.me.name.split(" ")[0]}, ваших гостей видите только вы.`));
}
