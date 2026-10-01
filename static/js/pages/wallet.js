// Кошелёк: монеты, кристаллы, уровень города, задания дня и недели, история.
import { api, state } from "../api.js";
import { h, icon, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, busy } from "../ui.js";

const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");

/** Ежедневный вход засчитывается после первого действия человека в интерфейсе, а не фоновым запросом */
export function initCheckin() {
  const day = new Date().toISOString().slice(0, 10);
  const key = `krug-checkin-${state.me?.id}`;
  try { if (localStorage.getItem(key) === day) return; } catch { /* приватный режим */ }
  const go = async () => {
    removeEventListener("pointerdown", go, true);
    removeEventListener("keydown", go, true);
    try {
      const r = await api.post("/api/wallet/checkin");
      try { localStorage.setItem(key, day); } catch { /* ничего */ }
      document.dispatchEvent(new CustomEvent("wallet:changed"));
      if (r.granted) toast(r.streak % 7 === 0 ? `+${r.granted} KC · серия ${r.streak} дней!` : `+${r.granted} KC за вход · серия ${r.streak}`, { icon: "coin", duration: 2600 });
    } catch { /* не мешаем работе */ }
  };
  addEventListener("pointerdown", go, true);
  addEventListener("keydown", go, true);
}

export async function walletPage() {
  setTitle("Кошелёк");
  let w = await api.get("/api/wallet");
  const top = h("section.card.wl-top");
  const qBox = h("section.card.wl-card");
  const weekBox = h("section.card.wl-card");
  const hist = h("div.wl-hist");
  const more = h("button.btn.ghost.sm", { type: "button", hidden: true }, "Показать ещё");

  const paintTop = () => {
    const L = w.level;
    const pct = L.max ? 100 : Math.round(((L.xp - L.from) / Math.max(1, L.to - L.from)) * 100);
    top.replaceChildren(
      h("div.wl-balances",
        h("div.wl-bal.kc", h("span.wl-ic", "🪙"), h("div", h("b", fmt(w.kc)), h("small", "KRUG Coin"))),
        h("div.wl-bal.kr", h("span.wl-ic", "💎"), h("div", h("b", fmt(w.kr)), h("small", "Кристаллы")))),
      h("div.wl-level",
        h("div.wl-level-row", h("b", `Уровень ${L.level}`), h("small", L.max ? "Максимум" : `${fmt(L.xp)} / ${fmt(L.to)} опыта`)),
        h("div.wl-bar", h("span", { style: { width: `${pct}%` } }))),
      h("div.wl-streak", icon("star", "sm"), w.streak ? `Серия входов: ${w.streak} ${w.streak % 10 === 1 && w.streak % 100 !== 11 ? "день" : [2, 3, 4].includes(w.streak % 10) && ![12, 13, 14].includes(w.streak % 100) ? "дня" : "дней"} · на 7-й день +40 KC` : "Заходите каждый день — на 7-й день серии +40 KC"));
  };

  const paintQuests = () => {
    const anySwapped = w.quests.some((q) => q.swapped);
    qBox.replaceChildren(
      h("div.wl-head", h("h2", "Задания дня"), h("small", "Все три — ещё +20 KC")),
      ...w.quests.map((q) => {
        const pct = Math.round((q.progress / q.target) * 100);
        const action = q.claimed ? h("span.wl-done", icon("check", "sm"), "Получено")
          : q.done ? h("button.btn.primary.sm", { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
            try {
              const r = await api.post(`/api/quests/${q.slot}/claim`);
              w = { ...w, ...r };
              toast(`+${r.got.kc + r.got.bonus} KC${r.got.bonus ? " · все задания дня!" : ""}`, { icon: "coin" });
              paintTop(); paintQuests(); paintWeek(); loadHist(true);
            } catch (err) { toastError(err); }
          }) }, "Забрать")
          : !anySwapped ? h("button.btn.ghost.sm.icon-only", { type: "button", "aria-label": "Заменить задание", title: "Заменить (раз в день)", onclick: (e) => busy(e.currentTarget, async () => {
            try { const r = await api.post(`/api/quests/${q.slot}/swap`); w.quests = r.quests; paintQuests(); } catch (err) { toastError(err); }
          }) }, icon("repeat", "sm")) : null;
        return h(`div.wl-quest${q.claimed ? ".claimed" : ""}`,
          h("div.wl-q-main", h("b", q.title), h("div.wl-bar.sm", h("span", { style: { width: `${pct}%` } })),
            h("small", `${q.progress} из ${q.target} · +${q.reward.kc} KC, +${q.reward.xp} опыта`)),
          action);
      }));
  };

  const paintWeek = () => {
    const k = w.weekly;
    weekBox.replaceChildren(
      h("div.wl-head", h("h2", "Неделя"), h("small", `${k.days} из ${k.target} дней со всеми заданиями`)),
      h("div.wl-week", ...Array.from({ length: k.target }, (_, i) => h(`span${i < k.days ? ".on" : ""}`))),
      h("div.wl-week-foot", h("small", `Награда: ${k.reward.kc} KC и ${k.reward.kr} 💎`),
        k.claimed ? h("span.wl-done", icon("check", "sm"), "Получено")
          : h("button.btn.primary.sm", { type: "button", disabled: k.days < k.target, onclick: (e) => busy(e.currentTarget, async () => {
            try { const r = await api.post("/api/quests/weekly/claim"); w = { ...w, ...r }; toast(`+${r.got.kc} KC и ${r.got.kr} 💎`, { icon: "coin" }); paintTop(); paintWeek(); loadHist(true); } catch (err) { toastError(err); }
          }) }, "Забрать")));
  };

  let before = null;
  async function loadHist(reset = false) {
    if (reset) { before = null; hist.replaceChildren(); }
    try {
      const d = await api.get("/api/wallet/history", before ? { before } : undefined);
      hist.append(...d.items.map((it) => h("div.wl-h-row",
        h("div.grow", h("b", it.title), h("small", timeAgo(it.at))),
        h(`span.wl-delta${it.delta < 0 ? ".neg" : ""}`, `${it.delta > 0 ? "+" : ""}${fmt(it.delta)} ${it.currency === "KR" ? "💎" : "KC"}`))));
      if (!hist.children.length) hist.append(h("p.muted", "Пока пусто. Публикуйте, общайтесь и выполняйте задания — монеты появятся здесь."));
      before = d.items.at(-1)?.id;
      more.hidden = !d.more;
    } catch (e) { hist.replaceChildren(h("p.muted", e.message)); }
  }
  more.addEventListener("click", () => busy(more, () => loadHist()));

  paintTop(); paintQuests(); paintWeek(); loadHist();
  const onChange = async () => {
    if (!top.isConnected) return document.removeEventListener("wallet:changed", onChange);
    try { w = await api.get("/api/wallet"); paintTop(); paintQuests(); paintWeek(); loadHist(true); } catch { /* ничего */ }
  };
  document.addEventListener("wallet:changed", onChange);
  return h("div.stack.wallet-page",
    h("div.page-head", h("h1", "Кошелёк")),
    top, qBox, weekBox,
    h("section.card.wl-card", h("div.wl-head", h("h2", "Как заработать")),
      h("ul.wl-how",
        h("li", h("b", "+10"), " за вход каждый день"),
        h("li", h("b", "+15"), " за запись от 40 символов или с фото — до 3 в день"),
        h("li", h("b", "+3"), " за комментарий к чужой записи — до 10 в день"),
        h("li", h("b", "+1"), " за каждого, кто отреагировал на ваши записи"),
        h("li", h("b", "+2"), " за каждого, кто их прокомментировал")),
      h("p.field-hint", "За активность — не больше 200 KC в день, плюс задания. Монеты нельзя купить или вывести: это очки для города и оформления.")),
    h("section.card.wl-card", h("div.wl-head", h("h2", "История")), hist, more));
}
