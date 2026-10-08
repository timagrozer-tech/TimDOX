// Коллекционные предметы: рамки и анимации аватара, эффекты страницы (частицы на canvas) и питомцы.
import { h } from "../dom.js";
import { motionEnabled } from "../fx.js";

export const RARITY_LABEL = { common: "Обычный", rare: "Редкий", epic: "Эпический", legendary: "Легендарный" };
export const SLOT_LABEL = { frame: "Рамки", animation: "Анимации", effect: "Эффекты", pet: "Питомцы" };
export const SLOT_ICON = { frame: "⭕", animation: "💫", effect: "✨", pet: "🐾" };
export const ANIM_ICON = { anim_pulse: "💓", anim_glow: "🌟", anim_orbit: "🪐", anim_float: "🎈", anim_aurora: "🌌", anim_vortex: "🌀" };

export const PETS = {
  pet_cat: { emoji: "🐱", name: "Мурзик", say: ["Мур-мур!", "Погладь ещё 😸", "Где мой корм?", "Мяу!"] },
  pet_dog: { emoji: "🐶", name: "Бублик", say: ["Гав!", "Пойдём гулять?", "Ты лучший!", "Апорт!"] },
  pet_fox: { emoji: "🦊", name: "Рыжик", say: ["Фыр!", "Что тут у нас?", "Я всё вижу 👀", "Хи-хи"] },
  pet_owl: { emoji: "🦉", name: "Мудрейшая", say: ["Угу.", "Знание — сила", "Не спится?", "Ух-ху!"] },
  pet_panda: { emoji: "🐼", name: "Бамбук", say: ["Бамбук есть?", "Обнимашки!", "Хрум-хрум", "Лень…"] },
  pet_dragon: { emoji: "🐉", name: "Искра", say: ["Рррр! 🔥", "Я легенда", "Охраняю профиль", "Пш-ш-ш!"] },
};

export const EFFECT_ICON = { fx_stars: "✨", fx_hearts: "💖", fx_snow: "❄️", fx_sakura: "🌸", fx_confetti: "🎉", fx_fireflies: "🟡" };

/** Добавляет к элементу аватара рамку и анимацию. Возвращает обёртку. */
export function decorate(avatarEl, equipped = {}) {
  if (equipped.frame) avatarEl.dataset.frame = equipped.frame;
  const wrap = h("span.cos-wrap", avatarEl);
  if (equipped.animation) {
    wrap.dataset.anim = equipped.animation;
    if (equipped.animation === "anim_orbit") wrap.append(h("i.sat.s1"), h("i.sat.s2"), h("i.sat.s3"));
    if (["anim_pulse", "anim_vortex", "anim_aurora"].includes(equipped.animation)) wrap.prepend(h("i.halo"));
  }
  if (equipped.aura) wrap.append(auraLayer(equipped.aura));
  return wrap;
}

// ---------------------------------------------------------------- ауры из магазина: частицы вокруг аватара
const AURA_SPEC = {
  aura_bubbles: { n: 10, ch: [""] },
  aura_snow: { n: 14, ch: ["❄", "❅", "•"] },
  aura_hearts: { n: 9, ch: ["❤", "💗", "💕"] },
  aura_notes: { n: 8, ch: ["♪", "♫", "♬", "♩"] },
  aura_sparkles: { n: 12, ch: ["✦", "✧", "⋆"] },
  aura_fire: { n: 11, ch: ["🔥"] },
  aura_planets: { n: 3, ch: ["", "", ""] },
  aura_lightning: { n: 6, ch: ["⚡"] },
  aura_crown: { n: 8, ch: ["✦"], top: "👑" },
  aura_galaxy: { n: 28, ch: [""] },
};
/** Детерминированный «случай»: одна и та же аура выглядит одинаково при каждом открытии */
function auraRnd(seed) { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }

export function auraLayer(id) {
  const spec = AURA_SPEC[id];
  if (!spec) return null;
  const layer = h("span.aura", { dataset: { aura: id }, "aria-hidden": "true" });
  for (let i = 0; i < spec.n; i++) {
    const r1 = auraRnd(i + 1), r2 = auraRnd(i + 17), r3 = auraRnd(i + 33);
    layer.append(h("i", { style: { "--i": i, "--n": spec.n, "--x": `${Math.round(r1 * 100)}%`, "--d": `${(r2 * 4).toFixed(2)}s`,
      "--t": `${(2.6 + r3 * 2.4).toFixed(2)}s`, "--s": (0.7 + r2 * 0.7).toFixed(2), "--a": `${Math.round((360 / spec.n) * i)}deg` } },
    spec.ch[i % spec.ch.length]));
  }
  if (spec.top) layer.append(h("b.aura-top", spec.top));
  return layer;
}

/** Питомец: сидит у аватара, реагирует на нажатие. */
export function pet(itemId, { small = false } = {}) {
  const p = PETS[itemId];
  if (!p) return null;
  const bubble = h("span.pet-bubble");
  const el = h(`button.pet${small ? ".small" : ""}`, { type: "button", "aria-label": `Питомец ${p.name}`, title: p.name, dataset: { pet: itemId } },
    h("span.pet-body", p.emoji), h("span.pet-shadow"), bubble);
  let timer = null;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    bubble.textContent = p.say[Math.floor(Math.random() * p.say.length)];
    el.classList.remove("hop");
    void el.offsetWidth;
    el.classList.add("hop", "talk");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("talk"), 1800);
  });
  return el;
}

// ---------------------------------------------------------------- Эффекты (частицы)
const CONFIG = {
  fx_stars: { n: 22, make: (w, h) => ({ x: rnd(w), y: rnd(h), vy: .35 + rnd(.5), vx: -.15 + rnd(.3), r: 1 + rnd(2), t: rnd(6) }) },
  fx_snow: { n: 34, make: (w, h) => ({ x: rnd(w), y: rnd(h), vy: .3 + rnd(.6), vx: 0, r: 1.2 + rnd(2.4), t: rnd(6) }) },
  fx_hearts: { n: 12, make: (w, h) => ({ x: rnd(w), y: h + rnd(h), vy: -(.35 + rnd(.5)), vx: 0, r: 10 + rnd(8), t: rnd(6) }) },
  fx_sakura: { n: 18, make: (w, h) => ({ x: rnd(w), y: rnd(h), vy: .4 + rnd(.5), vx: .2 + rnd(.4), r: 4 + rnd(3), t: rnd(6) }) },
  fx_confetti: { n: 30, make: (w, h) => ({ x: rnd(w), y: rnd(h), vy: .7 + rnd(.8), vx: -.3 + rnd(.6), r: 3 + rnd(3), t: rnd(6), c: pick(["#f43f5e", "#facc15", "#22d3ee", "#a78bfa", "#34d399", "#fb923c"]) }) },
  fx_fireflies: { n: 16, make: (w, h) => ({ x: rnd(w), y: rnd(h), vy: 0, vx: 0, r: 1.5 + rnd(1.5), t: rnd(6) }) },
};
const rnd = (n) => Math.random() * n;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** Накладывает на контейнер canvas с частицами. Сам останавливается, когда не виден. */
export function mountEffect(container, effectId) {
  const cfg = CONFIG[effectId];
  if (!cfg || !container) return null;
  const canvas = h("canvas.fx-canvas", { "aria-hidden": "true" });
  container.append(canvas);
  const ctx = canvas.getContext("2d");
  const small = matchMedia("(max-width: 719px)").matches;
  let w = 0, hgt = 0, parts = [], raf = 0, visible = true, last = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth; hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(cfg.n * (small ? .6 : 1));
    parts = Array.from({ length: n }, () => cfg.make(w, hgt));
  };
  const draw = (move) => {
    ctx.clearRect(0, 0, w, hgt);
    for (const p of parts) {
      if (move) {
        p.t += .03; p.x += p.vx + (effectId === "fx_snow" || effectId === "fx_sakura" ? Math.sin(p.t) * .3 : 0); p.y += p.vy;
        if (effectId === "fx_fireflies") { p.x += Math.cos(p.t * 1.3) * .4; p.y += Math.sin(p.t) * .3; }
        if (p.y > hgt + 20) { p.y = -10; p.x = rnd(w); }
        if (p.y < -30) { p.y = hgt + 10; p.x = rnd(w); }
        if (p.x > w + 20) p.x = -10;
        if (p.x < -20) p.x = w + 10;
      }
      paint(ctx, effectId, p);
    }
  };
  const stop = () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  const loop = (t) => {
    if (!canvas.isConnected) { stop(); return; }
    raf = requestAnimationFrame(loop);
    if (!visible || document.hidden || t - last < 33) return;
    last = t;
    draw(true);
  };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
  io.observe(canvas);
  requestAnimationFrame(() => {
    resize();
    if (motionEnabled()) raf = requestAnimationFrame(loop);
    else draw(false);
  });
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  return canvas;
}

function paint(ctx, id, p) {
  switch (id) {
    case "fx_stars": {
      const a = .45 + Math.sin(p.t * 2) * .35;
      ctx.fillStyle = `rgba(255, 244, 200, ${a.toFixed(2)})`;
      star(ctx, p.x, p.y, p.r * 2.2, p.r * .8);
      break;
    }
    case "fx_snow":
      ctx.fillStyle = "rgba(255, 255, 255, .85)";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      break;
    case "fx_hearts":
      ctx.globalAlpha = .75;
      ctx.font = `${p.r}px serif`;
      ctx.fillText("❤", p.x + Math.sin(p.t) * 6, p.y);
      ctx.globalAlpha = 1;
      break;
    case "fx_sakura":
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.t);
      ctx.fillStyle = "rgba(249, 168, 212, .9)";
      ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * .55, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      break;
    case "fx_confetti":
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.t * 2);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r, p.r, p.r * 2 * Math.abs(Math.cos(p.t)) + 1);
      ctx.restore();
      break;
    case "fx_fireflies": {
      const a = .35 + (Math.sin(p.t * 2.5) + 1) * .3;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
      g.addColorStop(0, `rgba(253, 224, 71, ${a.toFixed(2)})`);
      g.addColorStop(1, "rgba(253, 224, 71, 0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2); ctx.fill();
      break;
    }
    default:
  }
}

function star(ctx, x, y, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 ? r : R;
    const a = (Math.PI / 4) * i;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath(); ctx.fill();
}

/** Маленький значок предмета для витрины: рамка — мини-кольцо её цветов, остальное — эмодзи. */
export function itemBadge(it) {
  if (it.slot === "frame") return h("i.frame-dot", { dataset: { frame: it.id } });
  if (it.slot === "animation") return ANIM_ICON[it.id] || SLOT_ICON.animation;
  if (it.slot === "effect") return EFFECT_ICON[it.id] || SLOT_ICON.effect;
  if (it.slot === "pet") return PETS[it.id]?.emoji || SLOT_ICON.pet;
  return "🎁";
}

/** Мини-превью предмета для карточки коллекции */
export function itemPreview(item, me) {
  if (item.slot === "frame" || item.slot === "animation") {
    const av = h("span.avatar.lg", me.avatar ? h("img", { src: me.avatar, alt: "" }) : me.name[0]);
    return h("span.item-art", decorate(av, { [item.slot]: item.id }));
  }
  if (item.slot === "effect") {
    const art = h("span.item-art.effect-art", { dataset: { fx: item.id } });
    for (let i = 0; i < 5; i++) art.append(h("i", { style: { "--i": String(i) } }, EFFECT_ICON[item.id]));
    return art;
  }
  const p = PETS[item.id];
  return h("span.item-art.pet-art", h("span.pet-body", p?.emoji || "?"));
}
