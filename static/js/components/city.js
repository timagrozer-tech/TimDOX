// Город — изометрическая карта на SVG. Отрисовка без картинок: каждое здание — призма с крышей и окнами.
// Окна вечером горят по активности владельца за неделю, по улицам ходят жители, Nexus Core открывает Созвездие.
import { api } from "../api.js";
import { h, icon, avatar } from "../dom.js";
import { toast, toastError, busy, promptDialog, confirmDialog } from "../ui.js";
import { openConstellation } from "./constellation.js";

const NS = "http://www.w3.org/2000/svg";
const TW = 56, TH = 28;
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}
const iso = (x, y) => [(x - y) * TW / 2, (x + y) * TH / 2];
const pts = (arr) => arr.map((p) => p.join(",")).join(" ");
const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");
// детерминированный «случай» — один и тот же город выглядит одинаково при каждом открытии
const rnd = (seed) => { let t = seed + 0x6d2b79f5; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Призма на клетке: верх, левая и правая грани. inset — отступ от краёв клетки (0..1) */
function prism(x, y, hgt, c, inset = 0.18) {
  const [cx, cy] = iso(x, y);
  const k = 1 - inset * 2;
  const hw = TW / 2 * k, hh = TH / 2 * k;
  const top = [[cx, cy + TH / 2 - hh - hgt], [cx + hw, cy + TH / 2 - hgt], [cx, cy + TH / 2 + hh - hgt], [cx - hw, cy + TH / 2 - hgt]];
  const base = top.map(([px, py]) => [px, py + hgt]);
  return {
    top, base, cx, cy: cy + TH / 2, hw, hh,
    el: [
      s("polygon", { points: pts([top[3], top[2], base[2], base[3]]), fill: c[1] }),
      s("polygon", { points: pts([top[2], top[1], base[1], base[2]]), fill: c[2] }),
      s("polygon", { points: pts(top), fill: c[0] }),
    ],
  };
}

function windows(p, hgt, floors, lit, seed) {
  const out = [];
  const rows = Math.max(1, floors);
  for (let f = 0; f < rows; f++) {
    const fy = (f + 0.5) / rows;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const t = 0.3 + i * 0.4;
        const x = p.cx + side * p.hw * t;
        const y = p.cy - hgt * (1 - fy) + p.hh * t - 2;
        const on = rnd(seed * 31 + f * 7 + i * 3 + (side > 0 ? 1 : 0)) < lit;
        out.push(s("rect", { x: x - 2, y: y - 2.5, width: 4, height: 5, rx: 0.8, class: on ? "cw on" : "cw" }));
      }
    }
  }
  return out;
}

const PAL = {
  house: [["#f4efe6", "#d9cfbf", "#c2b6a3"], "#e2574c"],
  apartment: [["#e9eef5", "#c9d3e1", "#aebbd0"]],
  tower: [["#bfe3ff", "#7fb6e6", "#5d97cf"]],
  shop: [["#fff3d6", "#f2d79b", "#e3c074"]],
  school: [["#ffe1c7", "#f2b98a", "#e09a62"]],
  cafe: [["#ffe9ef", "#f3bfcc", "#e39fb2"]],
  hall: [["#fbfbfd", "#dfe3ec", "#c8cfdd"]],
};

function drawBuilding(b, lit, opts) {
  const { x, y, level: L, kind, id } = b;
  const g = s("g", { class: `cb k-${kind}`, "data-id": id, tabindex: opts.interactive ? 0 : null, role: opts.interactive ? "button" : null,
    "aria-label": opts.label(b) });
  const [cx, cy] = iso(x, y);
  const midY = cy + TH / 2;
  if (kind === "road") {
    g.append(s("polygon", { points: pts([[cx, cy + 2], [cx + TW / 2 - 2, midY], [cx, cy + TH - 2], [cx - TW / 2 + 2, midY]]), class: "c-road" }),
      s("line", { x1: cx - 8, y1: midY - 4, x2: cx + 8, y2: midY + 4, class: "c-road-line" }));
    return g;
  }
  if (kind === "tree" || kind === "park") {
    const n = kind === "park" ? 3 + Math.min(L, 3) : 1 + Math.floor(L / 2);
    if (kind === "park") g.append(s("polygon", { points: pts([[cx, cy + 3], [cx + TW / 2 - 3, midY], [cx, cy + TH - 3], [cx - TW / 2 + 3, midY]]), class: "c-lawn" }));
    for (let i = 0; i < n; i++) {
      const ox = (rnd(id * 13 + i) - 0.5) * (kind === "park" ? 28 : 8), oy = (rnd(id * 17 + i) - 0.5) * (kind === "park" ? 10 : 4);
      const r = 6 + L * 0.8;
      g.append(s("rect", { x: cx + ox - 1.2, y: midY + oy - 6, width: 2.4, height: 7, fill: "#8a5a3b" }),
        s("circle", { cx: cx + ox, cy: midY + oy - 9, r, class: "c-leaf" }),
        s("circle", { cx: cx + ox - r * 0.3, cy: midY + oy - 10 - r * 0.3, r: r * 0.45, class: "c-leaf-hi" }));
    }
    return g;
  }
  if (kind === "lamp") {
    g.append(s("rect", { x: cx - 1, y: midY - 22, width: 2, height: 22, fill: "#4b5563" }),
      s("circle", { cx, cy: midY - 23, r: 3.2, class: "c-lamp" }), s("circle", { cx, cy: midY - 23, r: 9, class: "c-lamp-glow" }));
    return g;
  }
  if (kind === "fountain" || kind === "pond") {
    const rx = kind === "pond" ? 20 : 15, ry = rx / 2;
    g.append(s("ellipse", { cx, cy: midY, rx: rx + 2, ry: ry + 1, fill: "#cbd5e1" }), s("ellipse", { cx, cy: midY, rx, ry, class: "c-water" }));
    if (kind === "fountain") g.append(s("rect", { x: cx - 1.5, y: midY - 14, width: 3, height: 14, fill: "#cbd5e1" }), s("path", { d: `M${cx} ${midY - 16} q -8 2 -10 12 M${cx} ${midY - 16} q 8 2 10 12`, class: "c-spray" }));
    else g.append(s("ellipse", { cx: cx - 5, cy: midY - 2, rx: 4, ry: 1.6, fill: "rgba(255,255,255,.6)" }));
    return g;
  }
  if (kind === "nexus") {
    const p = prism(x, y, 8, ["#3b2f6b", "#2a2150", "#1f193d"], 0.22);
    g.append(...p.el, s("circle", { cx, cy: midY - 26, r: 18, class: "c-nexus-halo" }),
      s("circle", { cx, cy: midY - 26, r: 9, class: "c-nexus" }), s("circle", { cx: cx - 3, cy: midY - 29, r: 2.6, fill: "#fff", opacity: 0.85 }));
    return g;
  }
  const c = (PAL[kind] || PAL.house)[0];
  const hgt = kind === "tower" ? 70 + L * 18 : kind === "apartment" ? 34 + L * 9 : kind === "hall" ? 26 : kind === "school" ? 20 + L * 3 : 14 + L * 4;
  const p = prism(x, y, hgt, c, kind === "tower" || kind === "apartment" ? 0.2 : 0.16);
  g.append(...p.el);
  const floors = kind === "tower" ? 4 + L * 2 : kind === "apartment" ? 2 + L : kind === "hall" ? 1 : 1;
  if (kind !== "cafe") g.append(...windows(p, hgt, floors, lit, id));
  if (kind === "house") {
    const [a, b2, c2, d] = p.top;
    const peak = [[a[0], a[1] - 12], [c2[0], c2[1] - 12]];
    g.append(s("polygon", { points: pts([d, peak[0], peak[1], c2]), fill: "#c4473e" }), s("polygon", { points: pts([c2, peak[1], peak[0], b2]), fill: "#e2574c" }));
  }
  if (kind === "hall") {
    g.append(s("ellipse", { cx, cy: p.top[0][1] + p.hh, rx: 12, ry: 6, fill: "#c8cfdd" }), s("path", { d: `M${cx - 12} ${p.top[0][1] + p.hh} a12 12 0 0 1 24 0`, fill: "#e8ecf4" }),
      s("rect", { x: cx - 0.8, y: p.top[0][1] + p.hh - 22, width: 1.6, height: 10, fill: "#64748b" }), s("path", { d: `M${cx + 0.8} ${p.top[0][1] + p.hh - 22} l8 3 l-8 3z`, class: "c-flag" }));
  }
  if (kind === "shop" || kind === "cafe") {
    const [, b2, c2] = p.top;
    g.append(s("polygon", { points: pts([[c2[0], c2[1] + hgt * 0.35], [b2[0], b2[1] + hgt * 0.35], [b2[0] + 4, b2[1] + hgt * 0.35 + 6], [c2[0] + 4, c2[1] + hgt * 0.35 + 6]]), class: "c-awning" }));
    if (kind === "cafe") g.append(s("ellipse", { cx: cx - 14, cy: midY + 2, rx: 7, ry: 3, fill: "#ff7aa8" }), s("rect", { x: cx - 14.5, y: midY + 2, width: 1, height: 7, fill: "#64748b" }));
  }
  if (kind === "school") g.append(s("rect", { x: cx - 0.8, y: p.top[0][1] - 14, width: 1.6, height: 14, fill: "#64748b" }), s("path", { d: `M${cx + 0.8} ${p.top[0][1] - 14} l9 3 l-9 3z`, class: "c-flag" }));
  if (kind === "tower") g.append(s("rect", { x: cx - 0.6, y: p.top[0][1] - 10, width: 1.2, height: 10, fill: "#94a3b8" }), s("circle", { cx, cy: p.top[0][1] - 11, r: 1.8, class: "c-beacon" }));
  if (L > 1) g.append(s("text", { x: cx + p.hw - 2, y: p.top[1][1] - 4, class: "c-lvl" }, String(L)));
  return g;
}

/**
 * Город пользователя. user — карточка, isMe — владелец, constellation — данные созвездия для Nexus Core
 */
export function cityView(user, isMe, constellation) {
  const root = h("div.city");
  let data = null, mode = null, pick = null, selected = null, moving = null;
  let night = (() => { const hr = new Date().getHours(); return hr >= 19 || hr < 7; })();

  const load = async () => {
    try { data = await api.get(`/api/city/${encodeURIComponent(user.username)}`); paint(); }
    catch (e) { root.replaceChildren(h("div.card.empty", icon("map"), h("p", e.message))); }
  };

  const label = (b) => {
    const c = data.catalog?.find((x) => x.kind === b.kind);
    const names = { hall: "Ратуша", nexus: "Nexus Core — открыть созвездие" };
    return `${names[b.kind] || c?.name || b.kind}${b.level > 1 ? `, уровень ${b.level}` : ""}`;
  };

  function districtOf(x, y) { return data.districts.find((d) => x >= d.from && x <= d.to && y >= d.from && y <= d.to); }

  function map() {
    const N = data.grid;
    const tallest = Math.max(30, ...data.buildings.map((b) => ({ tower: 90 + b.level * 18, apartment: 44 + b.level * 9, nexus: 40, hall: 52 })[b.kind] || 34));
    // кадр: открытые районы и одна клетка соседнего, чтобы было видно, куда расти
    const open = data.districts.filter((d) => d.open);
    const lo = Math.max(0, Math.min(...open.map((d) => d.from)) - 1), hi = Math.min(N - 1, Math.max(...open.map((d) => d.to)) + 1);
    const left = (lo - hi) * TW / 2 - TW / 2, right = (hi - lo) * TW / 2 + TW / 2;
    const y0 = lo * TH - tallest - 12, y1 = (hi + 1) * TH + 12;
    const svg = s("svg", { viewBox: `${left - 8} ${y0} ${right - left + 16} ${y1 - y0}`, class: `city-map${night ? " night" : ""}${mode ? " editing" : ""}`, role: "img",
      "aria-label": `Город ${data.name || user.name}: население ${data.population.value}, уровень ${data.level.level}` });
    const defs = s("defs", {},
      s("radialGradient", { id: "nexusGrad" }, s("stop", { offset: "0", "stop-color": "#fff" }), s("stop", { offset: ".35", "stop-color": "#c4b5fd" }), s("stop", { offset: "1", "stop-color": "#7c3aed" })),
      s("radialGradient", { id: "haloGrad" }, s("stop", { offset: "0", "stop-color": "#a78bfa", "stop-opacity": ".55" }), s("stop", { offset: "1", "stop-color": "#7c3aed", "stop-opacity": "0" })));
    svg.append(defs);
    const ground = s("g", { class: "c-ground" });
    const occupied = new Map(data.buildings.map((b) => [`${b.x},${b.y}`, b]));
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = districtOf(x, y);
      const [cx, cy] = iso(x, y);
      const tile = s("polygon", { points: pts([[cx, cy], [cx + TW / 2, cy + TH / 2], [cx, cy + TH], [cx - TW / 2, cy + TH / 2]]),
        class: `ct d-${d.code}${d.open ? "" : " locked"}${(x + y) % 2 ? " alt" : ""}`, "data-x": x, "data-y": y });
      if (mode && isMe) {
        const free = !occupied.has(`${x},${y}`) || (moving && occupied.get(`${x},${y}`)?.id === moving.id);
        const order = ["center", "living", "park"];
        const kindDistrict = pick ? data.catalog.find((c) => c.kind === pick)?.district : moving ? (data.catalog.find((c) => c.kind === moving.kind)?.district || "center") : null;
        const ok = d.open && free && (!kindDistrict || order.indexOf(d.code) >= order.indexOf(kindDistrict));
        tile.classList.add(ok ? "can" : "cannot");
        if (ok) tile.addEventListener("click", () => place(x, y));
      }
      ground.append(tile);
    }
    svg.append(ground);
    // подписи закрытых районов
    for (const d of data.districts) {
      if (d.open) continue;
      const [lx, ly] = iso(d.from, d.from);
      svg.append(s("text", { x: lx, y: ly + TH / 2 + 4, class: "c-lock", "text-anchor": "middle" }, `🔒 ${d.name}: ур. ${d.level}, жителей ${d.population}`));
    }
    const items = s("g", { class: "c-items" });
    for (const b of [...data.buildings].sort((a, c) => (a.x + a.y) - (c.x + c.y) || a.x - c.x)) {
      const g = drawBuilding(b, night ? data.lights : 0.08, { interactive: true, label });
      if (selected?.id === b.id) g.classList.add("sel");
      g.addEventListener("click", (e) => { e.stopPropagation(); onBuilding(b); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBuilding(b); } });
      items.append(g);
    }
    // жители: по одному на 25 человек населения, не больше 30
    const people = Math.min(30, Math.floor(data.population.value / 25));
    const free = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = districtOf(x, y); if (d.open && !occupied.has(`${x},${y}`)) free.push([x, y]); }
    for (let i = 0; i < people && free.length; i++) {
      const [x, y] = free[Math.floor(rnd(user.id * 101 + i) * free.length)];
      const [cx, cy] = iso(x, y);
      const ox = (rnd(i * 7 + 3) - 0.5) * 20, oy = (rnd(i * 11 + 5) - 0.5) * 8;
      const hue = Math.floor(rnd(i * 19 + 1) * 360);
      items.append(s("g", { class: "c-person", style: `--dl:${(rnd(i) * 3).toFixed(2)}s` },
        s("ellipse", { cx: cx + ox, cy: cy + TH / 2 + oy, rx: 2.6, ry: 1, fill: "rgba(0,0,0,.18)" }),
        s("rect", { x: cx + ox - 1.6, y: cy + TH / 2 + oy - 7, width: 3.2, height: 6, rx: 1.4, fill: `hsl(${hue} 60% 55%)` }),
        s("circle", { cx: cx + ox, cy: cy + TH / 2 + oy - 8.6, r: 1.7, fill: "#f2c9a0" })));
    }
    svg.append(items);
    svg.addEventListener("click", () => { if (!mode && selected) { selected = null; paint(); } });
    return svg;
  }

  async function place(x, y) {
    try {
      if (moving) { data = await api.post(`/api/city/buildings/${moving.id}/move`, { x, y }); moving = null; mode = null; }
      else if (pick) { data = await api.post("/api/city/build", { kind: pick, x, y }); toast("Построено", { icon: "check", duration: 1400 }); document.dispatchEvent(new CustomEvent("wallet:changed")); }
      paint();
    } catch (e) { toastError(e); }
  }

  function onBuilding(b) {
    if (mode) return;
    if (b.kind === "nexus") return openConstellation(user, constellation || { style: "cosmos", items: [] }, isMe, root.querySelector(".k-nexus"));
    if (b.kind === "hall" && isMe) {
      return promptDialog({ title: "Название города", label: "Как зовут ваш город?", value: data.name || "", confirm: "Сохранить" }).then(async (name) => {
        if (name === null || name === undefined) return;
        try { data = await api.post("/api/city/name", { name }); paint(); } catch (e) { toastError(e); }
      });
    }
    selected = selected?.id === b.id ? null : b;
    paint();
  }

  function panel() {
    if (!selected || !isMe) return null;
    const b = data.buildings.find((x) => x.id === selected.id);
    if (!b) return null;
    const c = data.catalog.find((x) => x.kind === b.kind);
    if (!c) return null;
    const next = b.level < 5 ? Math.floor(c.price * 1.6 ** b.level) : null;
    return h("div.city-panel",
      h("div.grow", h("b", `${c.name} · уровень ${b.level}`),
        h("small", [c.capacity ? `${c.capacity * b.level} жителей` : null, c.beauty ? `красота +${c.beauty * b.level}` : null].filter(Boolean).join(" · ") || "Украшение")),
      next ? h("button.btn.primary.sm", { type: "button", disabled: data.kc < next, onclick: (e) => busy(e.currentTarget, async () => {
        try { data = await api.post(`/api/city/buildings/${b.id}/upgrade`); selected = data.buildings.find((x) => x.id === b.id); toast("Улучшено", { icon: "check", duration: 1400 }); document.dispatchEvent(new CustomEvent("wallet:changed")); paint(); } catch (err) { toastError(err); }
      }) }, `Улучшить · ${fmt(next)} KC`) : h("span.muted", "Максимум"),
      h("button.btn.ghost.sm", { type: "button", onclick: () => { moving = b; mode = "move"; pick = null; selected = null; paint(); } }, icon("move", "sm"), "Переместить"),
      h("button.btn.ghost.sm.icon-only", { type: "button", "aria-label": "Снести", title: "Снести (монеты не возвращаются)", onclick: async () => {
        if (!(await confirmDialog({ title: `Снести «${c.name}»?`, text: "Монеты за постройку не вернутся.", confirm: "Снести", danger: true }))) return;
        try { data = await api.del(`/api/city/buildings/${b.id}`); selected = null; paint(); } catch (err) { toastError(err); }
      } }, icon("trash", "sm")));
  }

  function palette() {
    if (!isMe || mode !== "build") return null;
    const opened = new Set(data.districts.filter((d) => d.open).map((d) => d.code));
    return h("div.city-palette",
      h("div.city-palette-head", h("b", "Что построить"), h("small", `У вас ${fmt(data.kc)} KC`),
        h("button.btn.ghost.sm", { type: "button", onclick: () => { mode = null; pick = null; paint(); } }, "Готово")),
      h("div.city-palette-list", ...data.catalog.map((c) => {
        const locked = !opened.has(c.district);
        const dn = data.districts.find((d) => d.code === c.district);
        return h(`button.city-item${pick === c.kind ? ".on" : ""}`, { type: "button", disabled: locked || data.kc < c.price,
          title: locked ? `Откроется в районе «${dn.name}»` : "", onclick: () => { pick = pick === c.kind ? null : c.kind; paint(); } },
        h("b", c.name), h("small", locked ? `🔒 ур. ${dn.level}` : `${fmt(c.price)} KC${c.capacity ? ` · +${c.capacity} жит.` : ""}`));
      })),
      h("small.city-hint", pick ? "Нажмите на подсвеченную клетку" : "Выберите здание, затем клетку на карте"));
  }

  function stats() {
    const L = data.level, P = data.population;
    const pct = L.max ? 100 : Math.round(((L.xp - L.from) / Math.max(1, L.to - L.from)) * 100);
    return h("div.city-stats",
      h("div.city-stat", h("small", "Уровень"), h("b", String(L.level)), h("div.wl-bar.sm", h("span", { style: { width: `${pct}%` } }))),
      h("div.city-stat", { title: `Хотят жить: ${P.want}. Друзья, подписчики, приглашённые и активные дни.` }, h("small", "Население"), h("b", fmt(P.value)),
        h("small.muted", P.want > P.capacity ? `мест ${fmt(P.capacity)} — стройте дома` : `мест ${fmt(P.capacity)}`)),
      h("div.city-stat", h("small", "Красота"), h("b", fmt(data.beauty))),
      h("div.city-stat", h("small", "Рейтинг"), h("b", fmt(data.rating))));
  }

  function actions() {
    if (isMe) {
      const t = data.treasury;
      return h("div.city-actions",
        h(`button.btn.${mode === "build" ? "primary" : "soft"}`, { type: "button", onclick: () => { mode = mode === "build" ? null : "build"; pick = null; moving = null; selected = null; paint(); } }, icon("plus", "sm"), mode === "build" ? "Стройка" : "Строить"),
        mode === "move" ? h("button.btn.ghost", { type: "button", onclick: () => { mode = null; moving = null; paint(); } }, "Отменить перенос") : null,
        h("div.spacer"),
        h("button.btn.outline", { type: "button", disabled: t.ready < 1, title: `${t.per_day} KC в день, копится до 3 дней`, onclick: (e) => busy(e.currentTarget, async () => {
          try { const r = await api.post("/api/city/collect"); data = r; toast(`+${r.got} KC из казны`, { icon: "coin" }); document.dispatchEvent(new CustomEvent("wallet:changed")); paint(); } catch (err) { toastError(err); }
        }) }, "🪙", t.ready ? ` Казна: ${t.ready} KC` : " Казна пуста"));
    }
    if (data.visited_today) return h("div.city-actions", h("span.muted", "Вы уже были здесь сегодня — следы видны хозяину неделю"));
    const visit = (action, text) => h("button.btn.soft", { type: "button", onclick: (e) => busy(e.currentTarget, async () => {
      try { const r = await api.post(`/api/city/${encodeURIComponent(user.username)}/visit`, { action }); data = r; toast(`${text}. +${r.got} KC`, { icon: "check" }); document.dispatchEvent(new CustomEvent("wallet:changed")); paint(); } catch (err) { toastError(err); }
    }) }, text);
    return h("div.city-actions", visit("postcard", "Оставить открытку"), visit("water", "Полить парк"), visit("fireworks", "Запустить салют"));
  }

  function guests() {
    if (!data.guests.length) return null;
    const verbs = { postcard: "оставил(а) открытку", water: "полил(а) парк", fireworks: "запустил(а) салют" };
    return h("div.city-guests", h("small", "Гости за неделю"),
      h("div.city-guest-list", ...data.guests.slice(0, 8).map((g) => h("a.city-guest", { href: `/u/${g.username}`, title: `${g.name} ${verbs[g.action] || ""}` },
        avatar({ name: g.name, avatar: g.avatar, username: g.username }, "sm", { presence: false })))));
  }

  function paint() {
    root.replaceChildren(
      h("section.card.city-card",
        h("div.city-head", h("h2", data.name || (isMe ? "Мой город" : `Город · ${user.name}`)), isMe ? null : null),
        stats(), actions(),
        h("div.city-frame", map(), panel(),
          h("button.city-daynight", { type: "button", "aria-label": night ? "Показать днём" : "Показать ночью", title: night ? "День" : "Ночь",
            onclick: () => { night = !night; paint(); } }, night ? "☀️" : "🌙")),
        palette(), guests()));
    root.querySelector(".fireworks")?.remove();
  }

  load();
  return root;
}
