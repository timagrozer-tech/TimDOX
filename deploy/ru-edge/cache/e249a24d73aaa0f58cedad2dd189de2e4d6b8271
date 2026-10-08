// Витрина стикеров в профиле и на «Стикерной планете» созвездия: созданные, любимые, редкие и популярные наборы,
// счётчики и достижения коллекционера. Оформление витрины (стекло, золото, голограмма, космос) — из магазина за KC.
import { api } from "../api.js";
import { h, icon, pl } from "../dom.js";
import { navigate } from "../router.js";
import { stickerEl } from "./stickerview.js";

const openPack = (slug) => import("../pages/stickers.js").then((m) => m.showPackPreview(slug));

function packTile(p) {
  return h("button.sc-pack", { type: "button", onclick: () => openPack(p.slug), "aria-label": p.title },
    h("div.sc-cover", p.cover ? stickerEl(p.cover) : h("span", "📦")),
    h("b", p.title), h("small", pl(p.count, ["стикер", "стикера", "стикеров"])),
    p.price ? h("span.sc-price", `${p.price} KC`) : null);
}

export function stickerShowcase(user, isMe, { compact = false } = {}) {
  const box = h(`div.sc${compact ? ".compact" : ""}`, h("div.spinner"));
  api.get(`/api/users/${encodeURIComponent(user.username)}/stickers`).then((d) => {
    const s = d.stats;
    const skin = d.showcase ? `skin-${d.showcase.replace("showcase_", "")}` : "skin-base";
    const sec = (title, list) => (list.length ? h("section.sc-sec", h("h4", title), h("div.sc-row", list.slice(0, compact ? 4 : 12).map(packTile))) : null);
    const done = d.achievements.filter((a) => a.done);
    box.className = `sc ${skin}${compact ? " compact" : ""}`;
    box.replaceChildren(
      h("div.sc-stats",
        h("div", h("b", String(s.packs)), h("small", "наборов")),
        h("div", h("b", String(s.stickers)), h("small", "стикеров")),
        h("div", h("b", String(s.created)), h("small", "создано")),
        h("div", h("b", String(s.installs)), h("small", "добавили"))),
      sec("🎨 Созданные наборы", d.created),
      sec("⭐ Любимые наборы", d.favorites),
      sec("💎 Редкие коллекции", d.rare),
      compact ? null : sec("🔥 Популярные", d.popular),
      h("section.sc-sec", h("h4", `🏆 Достижения коллекционера · ${done.length}/${d.achievements.length}`),
        h("div.sc-ach", (compact ? done.slice(0, 6) : d.achievements).map((a) => h(`div.sc-badge${a.done ? ".done" : ""}`, { title: a.desc },
          h("span.sc-badge-ic", a.emoji), h("b", a.title), compact ? null : h("small", a.desc),
          !a.done && !compact ? h("span.sc-prog", { style: { "--p": `${Math.round(a.progress * 100)}%` } }) : null)),
          compact && !done.length ? h("p.muted", "Пока без наград") : null)),
      !d.created.length && !d.favorites.length && !compact ? h("p.muted.sc-empty", isMe ? "Отметьте любимые наборы звёздочкой и создайте свой — они появятся здесь." : "Коллекция пока пустая.") : null,
      isMe && !compact ? h("div.sc-actions",
        h("button.btn.primary.sm", { type: "button", onclick: () => navigate("/stickers") }, icon("sticker", "sm"), "Студия стикеров"),
        h("button.btn.soft.sm", { type: "button", onclick: () => navigate("/shop?tab=stickers") }, icon("sparkle", "sm"), "Оформить витрину")) : null);
  }).catch((e) => box.replaceChildren(h("p.muted", e.message)));
  return box;
}
