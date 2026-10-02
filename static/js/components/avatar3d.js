// 3D-аватар (в духе Memoji): персонаж собирается из простых форм three.js, живёт в профиле —
// дышит, моргает, следит за курсором, крутится пальцем, подпрыгивает от касания.
// three.js грузится только когда нужен 3D (≈400 КБ сжатыми).
const THREE_URL = "/static/vendor/three/three.module.js";
let THREE = null;
async function three() {
  if (!THREE) THREE = await import(THREE_URL);
  return THREE;
}

export const PALETTES = {
  skin: ["#ffe0cc", "#f6cfae", "#eab68d", "#d69a6f", "#b9784e", "#8f5a37", "#6b4128", "#4a2c1c"],
  hairColor: ["#1f1a17", "#4b2e1f", "#7a4a2a", "#b5793f", "#e3c07a", "#f2e2b8", "#b8b8c0", "#d9465a", "#6d4bff", "#22b8cf"],
  eyeColor: ["#4b2e1f", "#2a63c9", "#2f8f5b", "#7b8a96", "#9b6a2f", "#7c3aed"],
  accColor: ["#1f1a17", "#6d4bff", "#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#f472b6", "#ffffff", "#d4a017", "#64748b"],
  outfitColor: ["#6d4bff", "#111827", "#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#f472b6", "#f8fafc", "#7c2d12", "#64748b"],
  bg: [["#a78bfa", "#6d4bff"], ["#7dd3fc", "#2563eb"], ["#fda4af", "#e11d48"], ["#fde68a", "#f59e0b"], ["#86efac", "#10b981"],
    ["#f9a8d4", "#a855f7"], ["#cbd5e1", "#475569"], ["#1e1b4b", "#0b0820"]],
};

export const OPTIONS = {
  hair: [["none", "Без"], ["buzz", "Ёжик"], ["short", "Короткие"], ["long", "Длинные"], ["bob", "Каре"], ["curly", "Кудри"], ["bun", "Пучок"], ["mohawk", "Ирокез"], ["spiky", "Шипы"]],
  eyes: [["round", "Обычные"], ["happy", "Счастливые"], ["sleepy", "Сонные"], ["wink", "Подмигивает"]],
  brows: [["soft", "Мягкие"], ["bold", "Густые"], ["none", "Без"]],
  nose: [["small", "Аккуратный"], ["round", "Кнопочка"]],
  mouth: [["smile", "Улыбка"], ["grin", "Во весь рот"], ["open", "Удивление"], ["calm", "Спокойствие"], ["tongue", "Дразнится"]],
  facial: [["none", "Без"], ["stubble", "Щетина"], ["mustache", "Усы"], ["beard", "Борода"]],
  acc: [["none", "Без"], ["glasses", "Очки"], ["sunglasses", "Тёмные очки"], ["headphones", "Наушники"], ["cap", "Кепка"], ["beanie", "Шапка"], ["crown", "Корона"], ["halo", "Нимб"]],
  outfit: [["hoodie", "Худи"], ["tee", "Футболка"], ["jacket", "Куртка"], ["sweater", "Свитер"]],
};

export const DEFAULT_SPEC = { skin: 2, hair: "short", hairColor: 1, eyes: "round", eyeColor: 0, brows: "soft", nose: "small",
  mouth: "smile", facial: "none", acc: "none", accColor: 0, outfit: "hoodie", outfitColor: 0, bg: 0, cheeks: true, freckles: false };

export function randomSpec() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const s = {};
  for (const [k, list] of Object.entries(OPTIONS)) s[k] = pick(list)[0];
  for (const k of ["skin", "hairColor", "eyeColor", "accColor", "outfitColor", "bg"]) s[k] = Math.floor(Math.random() * PALETTES[k].length);
  s.cheeks = Math.random() < .6; s.freckles = Math.random() < .25;
  if (Math.random() < .55) s.facial = "none";
  if (Math.random() < .4) s.acc = "none";
  return s;
}

export function bgCss(spec) {
  const [a, b] = PALETTES.bg[spec.bg ?? 0];
  return `radial-gradient(circle at 30% 25%, ${a}, ${b} 75%)`;
}

// ---------------------------------------------------------------- сборка персонажа
function build(T, spec) {
  const g = new T.Group();
  const mat = (color, o = {}) => new T.MeshStandardMaterial({ color, roughness: o.r ?? .55, metalness: o.m ?? 0, emissive: o.e ?? 0x000000,
    emissiveIntensity: o.ei ?? 0, transparent: o.op != null, opacity: o.op ?? 1, side: o.side ?? T.FrontSide });
  const mesh = (geo, m, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.castShadow = false; return o; };
  const sphere = (r, seg = 32) => new T.SphereGeometry(r, seg, seg);
  const skin = mat(PALETTES.skin[spec.skin], { r: .6 });
  const hairM = mat(PALETTES.hairColor[spec.hairColor], { r: .75 });
  const accM = mat(PALETTES.accColor[spec.accColor], { r: .4, m: spec.acc === "crown" || spec.acc === "halo" ? .8 : .1 });
  const outfitM = mat(PALETTES.outfitColor[spec.outfitColor], { r: .8 });
  const dark = mat("#1b1420", { r: .4 });
  const white = mat("#ffffff", { r: .2 });

  // голова и тело
  const head = new T.Group();
  head.add(mesh(sphere(1, 48), skin, 0, 0, 0, .96, 1.04, .94));
  head.add(mesh(sphere(.22), skin, -.93, -.05, -.02, .55, .95, .5));
  head.add(mesh(sphere(.22), skin, .93, -.05, -.02, .55, .95, .5));
  const body = new T.Group();
  body.add(mesh(new T.CylinderGeometry(.3, .36, .5, 24), skin, 0, -1.08, 0));
  body.add(mesh(sphere(1, 40), outfitM, 0, -1.95, 0, 1.55, .85, .95));
  if (spec.outfit === "hoodie") {
    body.add(mesh(new T.TorusGeometry(.42, .13, 16, 40), outfitM, 0, -1.28, .05, 1, .55, 1.1));
    body.add(mesh(new T.CylinderGeometry(.018, .018, .45, 8), white, -.16, -1.55, .72));
    body.add(mesh(new T.CylinderGeometry(.018, .018, .45, 8), white, .16, -1.55, .72));
  } else if (spec.outfit === "tee") {
    body.add(mesh(new T.TorusGeometry(.36, .04, 12, 40), mat(PALETTES.outfitColor[(spec.outfitColor + 1) % 10], { r: .9 }), 0, -1.3, .12, 1, .5, 1));
  } else if (spec.outfit === "jacket") {
    body.add(mesh(new T.BoxGeometry(.06, .9, .2), mat("#d1d5db", { r: .3, m: .6 }), 0, -1.75, .8));
    for (const x of [-.32, .32]) body.add(mesh(new T.BoxGeometry(.38, .55, .1), mat(PALETTES.outfitColor[(spec.outfitColor + 1) % 10], { r: .7 }), x, -1.42, .62).rotateZ(x > 0 ? -.5 : .5));
  } else if (spec.outfit === "sweater") {
    body.add(mesh(new T.TorusGeometry(.4, .09, 16, 40), mat(PALETTES.outfitColor[(spec.outfitColor + 3) % 10], { r: .9 }), 0, -1.27, .04, 1, .45, 1.05));
    for (let i = -2; i <= 2; i++) body.add(mesh(sphere(.06), white, i * .28, -1.85, .83 - Math.abs(i) * .06));
  }

  // глаза
  const eyes = new T.Group();
  const eyeColor = mat(PALETTES.eyeColor[spec.eyeColor], { r: .25 });
  const lids = [];
  for (const side of [-1, 1]) {
    const e = new T.Group();
    e.position.set(side * .34, .12, .8);
    const wink = spec.eyes === "wink" && side === 1;
    if (spec.eyes === "happy" || wink) {
      const arc = mesh(new T.TorusGeometry(.13, .035, 10, 24, Math.PI), dark, 0, -.02, .1);
      e.add(arc);
    } else {
      e.add(mesh(sphere(.17), white, 0, 0, 0, 1, 1.1, .55));
      e.add(mesh(sphere(.105), eyeColor, 0, -.01, .08, 1, 1.05, .5));
      e.add(mesh(sphere(.055), dark, 0, -.01, .125, 1, 1, .4));
      e.add(mesh(sphere(.025), white, .04, .045, .15));
      if (spec.eyes === "sleepy") e.add(mesh(new T.SphereGeometry(.185, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), skin, 0, -.02, .02, 1, .75, .62));
      lids.push(e);
    }
    eyes.add(e);
  }
  head.add(eyes);
  // брови
  if (spec.brows !== "none") {
    const t = spec.brows === "bold" ? .055 : .032;
    for (const side of [-1, 1]) {
      const b = mesh(new T.CapsuleGeometry(t, .2, 6, 12), hairM, side * .34, .4, .86);
      b.rotation.z = Math.PI / 2 + side * .12;
      head.add(b);
    }
  }
  // нос, щёки, веснушки
  head.add(mesh(sphere(spec.nose === "round" ? .12 : .085), skin, 0, -.08, .97, 1, .9, .8));
  if (spec.cheeks) for (const side of [-1, 1]) {
    const c = mesh(new T.CircleGeometry(.13, 24), mat("#ff7a8a", { op: .35, r: 1 }), side * .55, -.22, .83);
    c.lookAt(side * 1.6, -.5, 3);
    head.add(c);
  }
  if (spec.freckles) {
    const fm = mat("#8b5a3c", { op: .7, r: 1 });
    [[-.5, -.08], [-.42, -.14], [-.55, -.18], [.5, -.08], [.42, -.14], [.55, -.18]].forEach(([x, y]) => head.add(mesh(sphere(.016, 8), fm, x, y, .86)));
  }
  // рот
  const mouth = new T.Group();
  mouth.position.set(0, -.38, .9);
  if (spec.mouth === "smile") mouth.add(mesh(new T.TorusGeometry(.2, .035, 12, 32, Math.PI), dark, 0, .08, 0).rotateZ(Math.PI));
  else if (spec.mouth === "grin" || spec.mouth === "tongue" || spec.mouth === "open") {
    const shape = spec.mouth === "open" ? mesh(sphere(.14), dark, 0, 0, 0, .9, 1.1, .4) : mesh(new T.SphereGeometry(.24, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), dark, 0, .06, 0, 1, .8, .4);
    mouth.add(shape);
    if (spec.mouth === "grin") mouth.add(mesh(new T.BoxGeometry(.3, .07, .05), white, 0, .02, .07));
    if (spec.mouth === "tongue") mouth.add(mesh(sphere(.09), mat("#ff5a7a", { r: .4 }), .03, -.12, .06, 1, .8, .6));
  } else mouth.add(mesh(new T.CapsuleGeometry(.025, .18, 6, 12), dark, 0, 0, 0).rotateZ(Math.PI / 2));
  head.add(mouth);

  // волосы
  const hair = new T.Group();
  const cap = (r, theta, y = 0, z = 0) => mesh(new T.SphereGeometry(r, 48, 24, 0, Math.PI * 2, 0, theta), hairM, 0, y, z);
  switch (spec.hair) {
    case "buzz": hair.add(cap(1.005, Math.PI * .42, .02, -.02)); break;
    case "short": {
      hair.add(cap(1.06, Math.PI * .45, .02, -.05));
      const fr = mesh(sphere(.5), hairM, .1, .72, .45, 1.4, .45, .6); fr.rotation.z = -.25; hair.add(fr);
      break;
    }
    case "long":
      hair.add(cap(1.07, Math.PI * .5, .02, -.04));
      hair.add(mesh(new T.CapsuleGeometry(.85, 1.1, 8, 24), hairM, 0, -.55, -.38, 1.1, 1, .6));
      for (const side of [-1, 1]) hair.add(mesh(new T.CapsuleGeometry(.2, 1.2, 6, 16), hairM, side * .92, -.55, .15));
      break;
    case "bob":
      hair.add(cap(1.08, Math.PI * .5, .02, -.04));
      for (const side of [-1, 1]) hair.add(mesh(sphere(.42), hairM, side * .88, -.28, .02, .55, 1.15, .95));
      hair.add(mesh(sphere(.95), hairM, 0, -.2, -.25, 1.05, .95, .8));
      break;
    case "curly":
      for (let i = 0; i < 46; i++) {
        const t = i / 46, phi = Math.acos(1 - t * 1.05), th = i * 2.4;
        const x = Math.sin(phi) * Math.cos(th), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(th);
        if (z > .55 && y < .55) continue;
        hair.add(mesh(sphere(.26, 16), hairM, x * 1.02, y * 1.02 + .02, z * 1.02 - .04));
      }
      break;
    case "bun":
      hair.add(cap(1.04, Math.PI * .46, .02, -.04));
      hair.add(mesh(sphere(.38), hairM, 0, 1.05, -.35));
      break;
    case "mohawk":
      hair.add(cap(1.005, Math.PI * .4, .01, -.02));
      for (let i = 0; i < 7; i++) {
        const a = -.9 + i * .3;
        const c = mesh(new T.ConeGeometry(.13, .55, 12), hairM, 0, Math.cos(a) * 1.05 + .15, Math.sin(a) * 1.05);
        c.rotation.x = a; hair.add(c);
      }
      break;
    case "spiky":
      hair.add(cap(1.04, Math.PI * .42, .02, -.04));
      for (let i = 0; i < 14; i++) {
        const th = i * 2.4, phi = .25 + (i % 4) * .18;
        const c = mesh(new T.ConeGeometry(.16, .5, 10), hairM, Math.sin(phi) * Math.cos(th), Math.cos(phi) + .1, Math.sin(phi) * Math.sin(th) - .1);
        c.lookAt(c.position.x * 3, c.position.y * 3, c.position.z * 3); c.rotateX(Math.PI / 2); hair.add(c);
      }
      break;
    default: break;
  }
  head.add(hair);
  // растительность на лице
  if (spec.facial === "beard" || spec.facial === "stubble") {
    // борода — только ниже рта и по скулам, рот остаётся открытым
    const b = mesh(new T.SphereGeometry(1.025, 40, 20, Math.PI * .05, Math.PI * .9, Math.PI * .67, Math.PI * .27), spec.facial === "stubble" ? mat(PALETTES.hairColor[spec.hairColor], { op: .35, r: 1 }) : hairM, 0, -.04, 0, 1, 1.02, 1);
    head.add(b);
  }
  if (spec.facial === "mustache" || spec.facial === "beard") {
    for (const side of [-1, 1]) { const m = mesh(new T.CapsuleGeometry(.05, .16, 6, 12), hairM, side * .1, -.24, .95); m.rotation.z = Math.PI / 2 + side * .35; head.add(m); }
  }
  // аксессуары
  const acc = new T.Group();
  switch (spec.acc) {
    case "glasses": case "sunglasses": {
      for (const side of [-1, 1]) {
        acc.add(mesh(new T.TorusGeometry(.2, .028, 12, 32), accM, side * .34, .12, .97));
        if (spec.acc === "sunglasses") acc.add(mesh(new T.CircleGeometry(.19, 32), mat("#0b0b12", { op: .85, r: .1, m: .6 }), side * .34, .12, .975));
        const temple = mesh(new T.CylinderGeometry(.018, .018, .75, 8), accM, side * .78, .14, .6); temple.rotation.x = Math.PI / 2; temple.rotation.z = side * .25; acc.add(temple);
      }
      const bridge = mesh(new T.CylinderGeometry(.02, .02, .2, 8), accM, 0, .15, 1.0); bridge.rotation.z = Math.PI / 2; acc.add(bridge);
      break;
    }
    case "headphones":
      // дуга поверх любой причёски (кудри и пучок — выше), амбушюры — снаружи от ушей
      acc.add(mesh(new T.TorusGeometry(spec.hair === "curly" || spec.hair === "bun" ? 1.3 : 1.17, .075, 12, 48, Math.PI), accM, 0, .05, 0));
      for (const side of [-1, 1]) {
        const cup = mesh(new T.CylinderGeometry(.32, .32, .24, 32), accM, side * 1.12, -.05, 0); cup.rotation.z = Math.PI / 2; acc.add(cup);
        const pad = mesh(new T.TorusGeometry(.24, .07, 12, 32), mat("#1b1420", { r: .8 }), side * .99, -.05, 0); pad.rotation.y = Math.PI / 2; acc.add(pad);
      }
      break;
    case "cap": {
      acc.add(mesh(new T.SphereGeometry(1.07, 48, 24, 0, Math.PI * 2, 0, Math.PI * .45), accM, 0, .05, -.03));
      const brim = mesh(new T.CylinderGeometry(.62, .62, .05, 40, 1, false, -Math.PI / 2, Math.PI), accM, 0, .42, .66, 1, 1, 1.15);
      brim.rotation.x = .08; acc.add(brim);
      break;
    }
    case "beanie":
      acc.add(mesh(new T.SphereGeometry(1.09, 48, 24, 0, Math.PI * 2, 0, Math.PI * .43), accM, 0, .1, -.02));
      acc.add(mesh(new T.TorusGeometry(.92, .12, 16, 48), accM, 0, .42, -.02).rotateX(Math.PI / 2));
      acc.add(mesh(sphere(.2), mat("#ffffff", { r: .9 }), 0, 1.22, -.05));
      break;
    case "crown": {
      const gold = mat("#f5c242", { r: .25, m: .9, e: 0x3a2a00, ei: .4 });
      acc.add(mesh(new T.CylinderGeometry(.58, .62, .26, 40, 1, true), gold, 0, 1.0, -.05));
      for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; acc.add(mesh(new T.ConeGeometry(.09, .26, 10), gold, Math.cos(a) * .6, 1.24, Math.sin(a) * .6 - .05)); }
      for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + (i - 1) * .9; acc.add(mesh(sphere(.06), mat(["#e11d48", "#22d3ee", "#10b981"][i], { r: .1, m: .3 }), Math.cos(a) * .62, 1.0, Math.sin(a) * .62 - .05)); }
      break;
    }
    case "halo":
      acc.add(mesh(new T.TorusGeometry(.62, .07, 16, 48), mat("#ffe27a", { r: .2, m: .5, e: 0xffd34d, ei: 1.2 }), 0, 1.45, -.1).rotateX(Math.PI / 2 - .25));
      break;
    default: break;
  }
  head.add(acc);
  head.position.y = .15;
  g.add(body, head);
  g.userData = { head, eyes, lids, mouth };
  return g;
}

// ---------------------------------------------------------------- сцена
/**
 * Вставляет живой 3D-аватар в container (он должен иметь размер).
 * Возвращает { update(spec), snapshot(size) → Promise<Blob>, destroy() }.
 */
export async function mount3D(container, spec, { interactive = true, snapshotable = false, zoom = 1 } = {}) {
  const T = await three();
  const canvas = document.createElement("canvas");
  canvas.className = "av3d-canvas";
  container.append(canvas);
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: snapshotable });
  } catch {
    canvas.remove();
    return null;   // нет WebGL — остаётся обычная картинка
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(28, 1, .1, 50);
  camera.position.set(0, .05, 8.6 / zoom);
  camera.lookAt(0, -.12, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a7dbd, 1.6));
  const key = new T.DirectionalLight(0xffffff, 2.1); key.position.set(2.5, 3, 4); scene.add(key);
  const rim = new T.DirectionalLight(0xb9a8ff, 1.6); rim.position.set(-3, 2, -3); scene.add(rim);
  const fill = new T.DirectionalLight(0xffe2cc, .6); fill.position.set(-2, -1, 3); scene.add(fill);

  let cur = { ...DEFAULT_SPEC, ...spec };
  let char = build(T, cur);
  scene.add(char);

  const resize = () => {
    const w = container.clientWidth || 120, hh = container.clientHeight || w;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(container);

  // жизнь: дыхание, моргание, взгляд за курсором, вращение пальцем, прыжок от касания
  const reduced = () => document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  let look = { x: 0, y: 0 }, spin = 0, spinV = 0, drag = null, jump = 0, nextBlink = performance.now() + 2500, blinkT = -1;
  const onMove = (e) => {
    const r = container.getBoundingClientRect();
    look.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
    look.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
  };
  if (interactive) {
    window.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, s: spin, t: performance.now(), moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; spin = drag.s + dx * .012; });
    canvas.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) { jump = 1; e.stopPropagation(); }
      drag = null;
    });
    canvas.style.touchAction = "pan-y";
  }
  let raf = 0, visible = true, t0 = performance.now();
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); });
  io.observe(container);
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const t = (now - t0) / 1000;
    const { head, lids, mouth } = char.userData;
    const still = reduced();
    if (!drag) { spinV += (-spin) * .06; spinV *= .82; spin += spinV; }
    char.rotation.y = spin + (still ? 0 : Math.sin(t * .6) * .06);
    head.rotation.y = still ? 0 : look.x * .45;
    head.rotation.x = still ? 0 : look.y * .25 + Math.sin(t * 1.3) * .02;
    head.rotation.z = still ? 0 : Math.sin(t * .8) * .03;
    char.position.y = still ? 0 : Math.sin(t * 2) * .025;
    if (jump > 0) { jump = Math.max(0, jump - .035); const k = Math.sin((1 - jump) * Math.PI); char.position.y += k * .35; char.scale.set(1 + k * .04, 1 - k * .03, 1); mouth.scale.set(1 + k * .3, 1 + k * .6, 1); }
    else { char.scale.set(1, 1, 1); mouth.scale.set(1, 1, 1); }
    if (now > nextBlink && blinkT < 0) blinkT = 0;
    if (blinkT >= 0) {
      blinkT += 1 / 9;
      const k = blinkT < .5 ? 1 - blinkT * 2 * .9 : .1 + (blinkT - .5) * 2 * .9;
      lids.forEach((e) => { e.scale.y = Math.max(.1, Math.min(1, k)); });
      if (blinkT >= 1) { blinkT = -1; lids.forEach((e) => { e.scale.y = 1; }); nextBlink = now + 2200 + Math.random() * 3200; }
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  const onVis = () => { if (!document.hidden && !raf) raf = requestAnimationFrame(frame); };
  document.addEventListener("visibilitychange", onVis);

  return {
    update(next) {
      cur = { ...DEFAULT_SPEC, ...next };
      scene.remove(char);
      char.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      char = build(T, cur);
      scene.add(char);
      jump = .6;
    },
    /** Снимок для ленты и чатов: квадрат с фоном */
    async snapshot(size = 512) {
      const keep = { y: char.rotation.y, hy: char.userData.head.rotation.y, hx: char.userData.head.rotation.x, py: char.position.y };
      char.rotation.y = 0; char.userData.head.rotation.set(0, 0, 0); char.position.y = 0; char.scale.set(1, 1, 1);
      char.userData.lids.forEach((e) => { e.scale.y = 1; });
      const w0 = canvas.width, h0 = canvas.height;
      renderer.setPixelRatio(1); renderer.setSize(size, size, false);
      camera.aspect = 1; camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const out = document.createElement("canvas"); out.width = out.height = size;
      const cx = out.getContext("2d");
      const [a, b] = PALETTES.bg[cur.bg ?? 0];
      const grd = cx.createRadialGradient(size * .3, size * .25, 0, size * .5, size * .5, size * .75);
      grd.addColorStop(0, a); grd.addColorStop(1, b);
      cx.fillStyle = grd; cx.fillRect(0, 0, size, size);
      cx.drawImage(canvas, 0, 0, size, size);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.setSize(w0 / Math.min(devicePixelRatio || 1, 2), h0 / Math.min(devicePixelRatio || 1, 2), false);
      resize();
      Object.assign(char.rotation, { y: keep.y }); char.userData.head.rotation.y = keep.hy; char.userData.head.rotation.x = keep.hx; char.position.y = keep.py;
      return new Promise((res) => out.toBlob(res, "image/png"));
    },
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      renderer.dispose(); canvas.remove();
    },
  };
}
