// Социальное дерево: кто кого пригласил — живой граф на canvas.
// Физика: отталкивание узлов, пружины-связи, затухание; масштаб колесом и щипком, перетаскивание холста и узлов,
// поиск с подлётом камеры, фильтры по галочкам и уровню. По связям бегут «импульсы» от пригласившего к приглашённому.
import { h, icon } from "../dom.js";
import { navigate } from "../router.js";

const TIER_COLOR = { base: "#6d5efc", silver: "#a8b3c7", gold: "#f5b301", legend: "#ff4fd8" };
const TIER_RANK = { base: 1, silver: 2, gold: 3, legend: 4 };

export function socialTree(data, { height = 520 } = {}) {
  const wrap = h("div.tree-wrap");
  const canvas = h("canvas.tree-canvas", { role: "img", "aria-label": `Социальное дерево: ${data.nodes.length} человек` });
  const tip = h("div.tree-tip", { hidden: true });
  const search = h("input.input.tree-search", { type: "search", placeholder: "Найти человека в дереве", "aria-label": "Поиск в дереве" });
  const tierSel = h("select.select.tree-filter", { "aria-label": "Фильтр по галочкам" },
    h("option", { value: "" }, "Все"), h("option", { value: "base" }, "С галочкой"), h("option", { value: "silver" }, "Серебро и выше"),
    h("option", { value: "gold" }, "Золото и выше"), h("option", { value: "legend" }, "Легенды"));
  const zoomIn = h("button.btn.soft.icon-only.sm", { type: "button", "aria-label": "Приблизить" }, "+");
  const zoomOut = h("button.btn.soft.icon-only.sm", { type: "button", "aria-label": "Отдалить" }, "−");
  const fit = h("button.btn.soft.icon-only.sm", { type: "button", "aria-label": "Показать всё", title: "Показать всё" }, icon("maximize", "sm"));
  wrap.append(h("div.tree-tools", search, tierSel, h("div.tree-zoom", zoomOut, zoomIn, fit)), h("div.tree-stage", { style: { height: `${height}px` } }, canvas, tip),
    h("div.tree-legend",
      ...Object.entries({ base: "базовая · 3", silver: "серебряная · 10", gold: "золотая · 50", legend: "легендарная · 100" })
        .map(([t, n]) => h("span", h("i", { style: { background: TIER_COLOR[t] } }), n))));

  if (!data.nodes.length) {
    wrap.querySelector(".tree-stage").replaceChildren(h("div.tree-empty", icon("users"), h("b", "Дерево пока пустое"), h("p", "Пригласите первых друзей — и здесь вырастут ветви.")));
    return wrap;
  }

  // ---------------------------------------------------------------- модель
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nodes = data.nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, r: 10 + Math.min(16, Math.sqrt(n.invited || 0) * 4) + (n.me ? 4 : 0), img: null }));
  const repel = nodes.length > 150 ? 2400 : 1600;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ a: byId.get(e.from), b: byId.get(e.to), t: Math.random() })).filter((e) => e.a && e.b);
  const children = new Map();
  for (const e of edges) { if (!children.has(e.a.id)) children.set(e.a.id, []); children.get(e.a.id).push(e.b); e.b.parent = e.a; }

  // стартовая раскладка — радиальное дерево: так физике не нужно распутывать клубок
  const roots = nodes.filter((n) => !n.parent);
  let angle = 0;
  const place = (n, depth, a0, a1) => {
    const a = (a0 + a1) / 2;
    n.x = Math.cos(a) * depth * 120 + (Math.random() - 0.5) * 6;
    n.y = Math.sin(a) * depth * 120 + (Math.random() - 0.5) * 6;
    const kids = children.get(n.id) || [];
    kids.forEach((k, i) => place(k, depth + 1, a0 + ((a1 - a0) * i) / kids.length, a0 + ((a1 - a0) * (i + 1)) / kids.length));
  };
  const weight = (n) => 1 + (children.get(n.id) || []).reduce((s, k) => s + weight(k), 0);
  const total = roots.reduce((s, r) => s + weight(r), 0);
  for (const r of roots) {
    const span = (Math.PI * 2 * weight(r)) / total;
    if (roots.length === 1) { r.x = 0; r.y = 0; (children.get(r.id) || []).forEach((k, i, arr) => place(k, 1, (Math.PI * 2 * i) / arr.length, (Math.PI * 2 * (i + 1)) / arr.length)); }
    else place(r, 1.2, angle, angle + span);
    angle += span;
  }

  for (const n of nodes) {
    if (!n.avatar) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = n.avatar.replace(/\.webp$/, "_t.webp");
    img.onload = () => { n.img = img; kick(0.02); };
    img.onerror = () => { if (img.src !== n.avatar) img.src = n.avatar; };
  }

  // ---------------------------------------------------------------- камера и физика
  const cam = { x: 0, y: 0, k: 1 };
  let target = null; // плавный подлёт камеры
  let alpha = reduce ? 0.02 : 1;
  let dpr = 1, W = 0, H = 0;
  let highlight = null, filterTier = "";
  let drag = null, pinch = null, moved = false, onscreen = true;
  new IntersectionObserver(([en]) => { onscreen = en.isIntersecting; if (onscreen) wake(); }).observe(canvas);
  const css = getComputedStyle(document.documentElement);
  const isDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

  function tick() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 160000) continue; // дальше 300 — отталкивание пренебрежимо
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (repel * alpha) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const want = (nodes.length > 150 ? 46 : 70) + e.a.r + e.b.r;
      const f = ((d - want) / d) * 0.08 * alpha;
      e.a.vx += dx * f; e.a.vy += dy * f; e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const p of nodes) {
      p.vx -= p.x * 0.002 * alpha; p.vy -= p.y * 0.002 * alpha; // лёгкое притяжение к центру
      if (p === drag?.node) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += p.vx; p.y += p.vy;
    }
    alpha *= 0.985;
  }

  function kick(a = 0.3) { alpha = Math.max(alpha, reduce ? Math.min(a, 0.05) : a); wake(); }

  // ---------------------------------------------------------------- отрисовка
  const visible = (n) => !filterTier || (TIER_RANK[n.tier] || 0) >= TIER_RANK[filterTier];
  let pulse = 0;
  function draw() {
    const ctx = canvas.getContext("2d");
    const dark = isDark();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam.k, cam.k);
    ctx.translate(-cam.x, -cam.y);
    const accent = css.getPropertyValue("--c1").trim() || "#6d5efc";
    // связи: мягкая линия + бегущий импульс от пригласившего к приглашённому
    for (const e of edges) {
      const on = visible(e.a) && visible(e.b);
      const hl = highlight && (e.a === highlight || e.b === highlight);
      ctx.strokeStyle = hl ? accent : dark ? `rgba(180,190,255,${on ? 0.22 : 0.06})` : `rgba(80,70,180,${on ? 0.18 : 0.05})`;
      ctx.lineWidth = (hl ? 2.2 : 1.2) / Math.sqrt(cam.k);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
      if (on && !reduce) {
        const t = (e.t + pulse) % 1;
        const px = e.a.x + (e.b.x - e.a.x) * t, py = e.a.y + (e.b.y - e.a.y) * t;
        ctx.fillStyle = TIER_COLOR[e.a.tier] || accent;
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
        ctx.beginPath(); ctx.arc(px, py, 2.4 / Math.sqrt(cam.k), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // узлы: аватар в круге, кольцо цвета галочки, свечение у золота и легенды
    for (const n of nodes) {
      const on = visible(n);
      ctx.globalAlpha = on ? 1 : 0.18;
      const ring = TIER_COLOR[n.tier] || (dark ? "#3a3f55" : "#d9dcf0");
      if (on && (n.tier === "gold" || n.tier === "legend" || n === highlight || n.me)) {
        ctx.shadowColor = n === highlight || n.me ? accent : ring;
        ctx.shadowBlur = (n.tier === "legend" ? 22 + Math.sin(pulse * Math.PI * 2) * 6 : 16) ;
      }
      ctx.fillStyle = ring;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.clip();
      if (n.img) ctx.drawImage(n.img, n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      else {
        ctx.fillStyle = `hsl(${(n.id * 47) % 360} 55% ${dark ? 38 : 55}%)`;
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        ctx.fillStyle = "#fff";
        ctx.font = `600 ${Math.round(n.r * 0.9)}px system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText((n.name || "?").trim()[0].toUpperCase(), n.x, n.y + 1);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    // подписи — отдельным проходом поверх кружков; при мелком масштабе только у «узловых» людей
    const many = nodes.length > 120;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const n of nodes) {
      const show = n.me || n === highlight || (visible(n) && (cam.k > (many ? 1.3 : 0.75) || (n.invited || 0) >= (many ? 6 : 3)));
      if (!show) continue;
      const fs = 12 / Math.max(cam.k, 0.6);
      ctx.font = `${n.me || n === highlight ? 700 : 600} ${fs}px system-ui, sans-serif`;
      const label = n.me ? "Вы" : n.name.split(" ")[0];
      const w = ctx.measureText(label).width + fs * 0.8;
      ctx.fillStyle = dark ? "rgba(12,14,28,.72)" : "rgba(255,255,255,.82)";
      ctx.beginPath(); ctx.roundRect(n.x - w / 2, n.y + n.r + 5, w, fs * 1.35, fs * 0.6); ctx.fill();
      ctx.fillStyle = dark ? "rgba(235,238,255,.95)" : "rgba(25,22,60,.9)";
      ctx.fillText(label, n.x, n.y + n.r + 5 + fs * 0.18);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- цикл: работает только пока есть движение
  let raf = 0, last = 0;
  function frame(ts) {
    raf = 0;
    if (!canvas.isConnected) return;
    const dt = Math.min(50, ts - (last || ts));
    last = ts;
    if (alpha > 0.004) tick();
    if (target) {
      cam.x += (target.x - cam.x) * 0.12; cam.y += (target.y - cam.y) * 0.12; cam.k += (target.k - cam.k) * 0.12;
      if (Math.abs(target.x - cam.x) < 0.5 && Math.abs(target.k - cam.k) < 0.002) target = null;
    }
    pulse = (pulse + dt / 2600) % 1;
    draw();
    if (alpha > 0.004 || target || drag || (!reduce && !document.hidden && onscreen)) wake();
  }
  function wake() { if (!raf) raf = requestAnimationFrame(frame); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    wake();
  }
  new ResizeObserver(resize).observe(canvas);

  function fitAll(animated = true) {
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60, minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
    const k = Math.max(0.25, Math.min(1.6, Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1))));
    const t = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
    if (animated) target = t; else Object.assign(cam, t);
    wake();
  }
  // прогреваем раскладку заранее, чтобы граф появился уже распутанным
  for (let i = 0; i < (nodes.length > 400 ? 60 : 160); i++) tick();
  requestAnimationFrame(() => { resize(); fitAll(false); });

  // ---------------------------------------------------------------- взаимодействие
  const toWorld = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    return { x: (cx - r.left - W / 2) / cam.k + cam.x, y: (cy - r.top - H / 2) / cam.k + cam.y };
  };
  const hit = (cx, cy) => {
    const p = toWorld(cx, cy);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < n.r + 6 && d < bd && visible(n)) { best = n; bd = d; }
    }
    return best;
  };
  const zoomAt = (cx, cy, factor) => {
    const before = toWorld(cx, cy);
    cam.k = Math.max(0.2, Math.min(4, cam.k * factor));
    const after = toWorld(cx, cy);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    target = null;
    wake();
  };
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  const pointers = new Map();
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.k };
      drag = null;
      return;
    }
    const node = hit(e.clientX, e.clientY);
    drag = { node, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    target = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) {
      const n = hit(e.clientX, e.clientY);
      canvas.style.cursor = n ? "pointer" : "grab";
      showTip(n, e);
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (d / pinch.d)) / cam.k);
      moved = true;
      return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) moved = true;
    if (drag.node) {
      const p = toWorld(e.clientX, e.clientY);
      drag.node.x = p.x; drag.node.y = p.y;
      kick(0.25);
    } else {
      cam.x = drag.cx - (e.clientX - drag.sx) / cam.k;
      cam.y = drag.cy - (e.clientY - drag.sy) / cam.k;
      canvas.style.cursor = "grabbing";
      wake();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !moved) {
      const n = drag.node;
      if (n) { highlight = n; showTip(n, e, true); centerOn(n, Math.max(cam.k, 1.2)); }
      else { highlight = null; tip.hidden = true; }
    }
    drag = null;
    wake();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (!pointers.size && !highlight) tip.hidden = true; });

  function centerOn(n, k = cam.k) { target = { x: n.x, y: n.y, k }; wake(); }

  function showTip(n, e, pinned = false) {
    if (!n) { if (!highlight) tip.hidden = true; return; }
    const r = canvas.getBoundingClientRect();
    const tierName = { base: "Базовая галочка", silver: "Серебряная галочка", gold: "Золотая галочка", legend: "Легендарная галочка" }[n.tier];
    tip.replaceChildren(
      h("b", n.me ? `${n.name} (вы)` : n.name),
      h("small", `@${n.username}`),
      h("small", n.invited ? `Пригласил(а): ${n.invited}` : "Пока никого не пригласил(а)"),
      tierName ? h("small.tree-tip-tier", { style: { color: TIER_COLOR[n.tier] } }, tierName) : null,
      pinned ? h("button.btn.primary.sm", { type: "button", onclick: () => navigate(`/u/${n.username}`) }, "Открыть профиль") : null);
    tip.hidden = false;
    tip.style.left = `${Math.min(r.width - 200, Math.max(8, e.clientX - r.left + 14))}px`;
    tip.style.top = `${Math.min(r.height - 120, Math.max(8, e.clientY - r.top + 14))}px`;
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { highlight = null; tip.hidden = true; wake(); return; }
    const n = nodes.find((x) => x.name.toLowerCase().includes(q) || x.username.toLowerCase().includes(q));
    if (n) { highlight = n; centerOn(n, 1.6); }
  });
  tierSel.addEventListener("change", () => { filterTier = tierSel.value; wake(); });
  zoomIn.addEventListener("click", () => { const r = canvas.getBoundingClientRect(); zoomAt(r.left + W / 2, r.top + H / 2, 1.3); });
  zoomOut.addEventListener("click", () => { const r = canvas.getBoundingClientRect(); zoomAt(r.left + W / 2, r.top + H / 2, 1 / 1.3); });
  fit.addEventListener("click", () => fitAll());
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (e) => {
    const r = canvas.getBoundingClientRect();
    if (e.key === "+" || e.key === "=") zoomAt(r.left + W / 2, r.top + H / 2, 1.2);
    else if (e.key === "-") zoomAt(r.left + W / 2, r.top + H / 2, 1 / 1.2);
    else if (e.key === "0") fitAll();
  });
  return wrap;
}
