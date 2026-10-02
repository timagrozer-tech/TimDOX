// 3D-аватар (в духе Memoji): персонаж собирается из простых форм three.js, живёт в профиле —
// дышит, моргает, следит за курсором, крутится пальцем, показывает эмоции от касания.
// three.js грузится только когда нужен 3D (≈400 КБ сжатыми).
const THREE_URL = "/static/vendor/three/three.module.js";
let THREE = null;
async function three() {
  if (!THREE) THREE = await import(THREE_URL);
  return THREE;
}

export const PALETTES = {
  skin: ["#ffe0cc", "#f6cfae", "#eab68d", "#d69a6f", "#b9784e", "#8f5a37", "#6b4128", "#4a2c1c", "#9ad18b", "#8fb8ff", "#c4a6ff", "#d7dbe3"],
  hairColor: ["#1f1a17", "#4b2e1f", "#7a4a2a", "#b5793f", "#e3c07a", "#f2e2b8", "#b8b8c0", "#d9465a", "#6d4bff", "#22b8cf", "#ff8a3d", "#ff9ec7", "#2ea043", "#ffffff"],
  eyeColor: ["#4b2e1f", "#2a63c9", "#2f8f5b", "#7b8a96", "#9b6a2f", "#7c3aed", "#d6202c", "#e8b62a", "#ff5fae", "#141414"],
  lipColor: ["#c2185b", "#e11d48", "#ff6b8a", "#9d4edd", "#7a2e2e", "#f4a261", "#1f1a17", "#e9a6a6"],
  accColor: ["#1f1a17", "#6d4bff", "#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#f472b6", "#ffffff", "#d4a017", "#64748b", "#c0c0c8", "#ff6b00", "#8b5cf6", "#14b8a6"],
  outfitColor: ["#6d4bff", "#111827", "#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#f472b6", "#f8fafc", "#7c2d12", "#64748b", "#facc15", "#84cc16", "#1e3a8a", "#d6b98c"],
  bg: [["#a78bfa", "#6d4bff"], ["#7dd3fc", "#2563eb"], ["#fda4af", "#e11d48"], ["#fde68a", "#f59e0b"], ["#86efac", "#10b981"],
    ["#f9a8d4", "#a855f7"], ["#cbd5e1", "#475569"], ["#1e1b4b", "#0b0820"], ["#fef3c7", "#fb7185"], ["#a7f3d0", "#0ea5e9"],
    ["#fde047", "#ea580c"], ["#e9d5ff", "#ec4899"], ["#99f6e4", "#0f766e"], ["#f5f5f4", "#a8a29e"]],
};
/** Какой палитрой окрашивается каждый цветовой параметр (значение — номер в палитре или свой цвет #rrggbb) */
export const COLOR_KEYS = {
  skin: "skin", hairColor: "hairColor", hairColor2: "hairColor", eyeColor: "eyeColor", eyeColor2: "eyeColor", lipColor: "lipColor",
  shadowColor: "accColor", hatColor: "accColor", glassesColor: "accColor", jewelColor: "accColor", paintColor: "accColor",
  outfitColor: "outfitColor", outfitColor2: "outfitColor", petColor: "accColor", bg: "bg",
};
export const BOOL_KEYS = ["cheeks", "freckles", "hairStreak", "heterochromia", "eyeGlow", "lipstick", "eyeshadow"];

// по одной строке на параметр — сервер (app/avatar3d.py) проверяет тот же список, тест сверяет их
export const OPTIONS = {
  headShape: [["round", "Круглая"], ["oval", "Овальная"], ["wide", "Широкая"], ["long", "Вытянутая"], ["chubby", "Щекастая"]],
  headSize: [["s", "Маленькая"], ["m", "Обычная"], ["l", "Большая"]],
  build: [["slim", "Стройное"], ["normal", "Обычное"], ["broad", "Крепкое"]],
  ears: [["normal", "Обычные"], ["small", "Маленькие"], ["big", "Большие"], ["elf", "🧝 Эльфийские"], ["none", "Без"]],
  nose: [["small", "Аккуратный"], ["round", "Кнопочка"], ["pointy", "Острый"], ["wide", "Широкий"], ["long", "Длинный"], ["pig", "🐷 Пятачок"], ["clown", "🔴 Клоунский"]],
  hair: [["none", "Без"], ["buzz", "Ёжик"], ["short", "Короткие"], ["side", "Набок"], ["quiff", "Кок"], ["undercut", "Андеркат"], ["long", "Длинные"], ["wavy", "Волнистые"], ["bob", "Каре"], ["bangs", "Чёлка"], ["emo", "Эмо"], ["curly", "Кудри"], ["afro", "Афро"], ["bun", "Пучок"], ["topknot", "Самурай"], ["spacebuns", "Два пучка"], ["ponytail", "Хвост"], ["pigtails", "Хвостики"], ["braids", "Косички"], ["dreads", "Дреды"], ["mullet", "Маллет"], ["mohawk", "Ирокез"], ["spiky", "Шипы"]],
  eyes: [["round", "Обычные"], ["almond", "Миндаль"], ["big", "Большие"], ["anime", "Аниме"], ["small", "Точки"], ["happy", "Счастливые"], ["sleepy", "Сонные"], ["wink", "Подмигивает"]],
  lashes: [["none", "Без"], ["short", "Короткие"], ["long", "Длинные"]],
  brows: [["soft", "Мягкие"], ["bold", "Густые"], ["thin", "Тонкие"], ["arched", "Домиком"], ["angry", "Хмурые"], ["unibrow", "Монобровь"], ["none", "Без"]],
  mouth: [["smile", "Улыбка"], ["smirk", "Ухмылка"], ["grin", "Во весь рот"], ["open", "Удивление"], ["calm", "Спокойствие"], ["tongue", "Дразнится"], ["fangs", "🧛 Клыки"], ["kiss", "😘 Поцелуй"], ["buck", "🐰 Зубки"]],
  facial: [["none", "Без"], ["stubble", "Щетина"], ["mustache", "Усы"], ["chevron", "Пышные усы"], ["handlebar", "Подкрученные"], ["goatee", "Эспаньолка"], ["sideburns", "Бакенбарды"], ["beard", "Борода"], ["longbeard", "Длинная борода"]],
  paint: [["none", "Без"], ["whiskers", "🐱 Усики"], ["warpaint", "Боевой раскрас"], ["star", "⭐ Звезда"], ["heart", "❤️ Сердечко"], ["tear", "💧 Слеза"], ["glitter", "✨ Блёстки"]],
  mole: [["none", "Без"], ["cheek", "На щеке"], ["lip", "Над губой"], ["eye", "У глаза"]],
  scar: [["none", "Без"], ["eye", "Через глаз"], ["cheek", "На щеке"]],
  piercing: [["none", "Без"], ["nose", "Колечко в носу"], ["septum", "Септум"], ["brow", "В брови"], ["lip", "В губе"]],
  hat: [["none", "Без"], ["cap", "🧢 Кепка"], ["capback", "Кепка назад"], ["beanie", "Шапка"], ["beret", "Берет"], ["bandana", "Бандана"], ["headband", "Повязка"], ["cowboy", "🤠 Ковбойская"], ["tophat", "🎩 Цилиндр"], ["wizard", "🧙 Колпак мага"], ["party", "🥳 Праздничный"], ["chef", "👨‍🍳 Поварской"], ["crown", "👑 Корона"], ["tiara", "Тиара"], ["halo", "😇 Нимб"], ["flowers", "🌸 Венок"], ["bow", "🎀 Бант"], ["catears", "🐱 Ушки"], ["bunnyears", "🐰 Заячьи ушки"], ["horns", "😈 Рожки"], ["viking", "Викинг"], ["antenna", "👽 Антенны"], ["astronaut", "🧑‍🚀 Шлем"]],
  glasses: [["none", "Без"], ["glasses", "Очки"], ["round", "Круглые"], ["nerd", "Квадратные"], ["sunglasses", "Тёмные очки"], ["shades", "Узкие очки"], ["aviator", "Авиаторы"], ["heart", "💖 Сердечки"], ["star", "⭐ Звёздочки"], ["monocle", "🧐 Монокль"], ["ski", "🎿 Маска"], ["vr", "🥽 VR-шлем"], ["eyepatch", "🏴‍☠️ Повязка"]],
  earwear: [["none", "Без"], ["studs", "Гвоздики"], ["hoops", "Кольца"], ["drops", "Подвески"], ["earbuds", "Наушники-капли"], ["headphones", "🎧 Наушники"]],
  neck: [["none", "Без"], ["chain", "Цепь"], ["pendant", "Кулон"], ["pearls", "Жемчуг"], ["choker", "Чокер"], ["scarf", "🧣 Шарф"], ["bowtie", "Бабочка"], ["tie", "👔 Галстук"], ["medal", "🥇 Медаль"]],
  outfit: [["hoodie", "Худи"], ["tee", "Футболка"], ["shirt", "Рубашка"], ["jacket", "Куртка"], ["biker", "Косуха"], ["sweater", "Свитер"], ["turtleneck", "Водолазка"], ["coat", "Пальто с мехом"], ["suit", "🤵 Костюм"], ["kimono", "Кимоно"], ["overalls", "Комбинезон"], ["jersey", "⚽ Форма"], ["armor", "🛡 Доспехи"], ["spacesuit", "🚀 Скафандр"], ["hero", "🦸 Плащ героя"]],
  pattern: [["none", "Однотонная"], ["stripes", "Полоски"], ["dots", "Горошек"], ["checks", "Клетка"], ["camo", "Камуфляж"], ["stars", "Звёзды"], ["hearts", "Сердечки"], ["zigzag", "Зигзаг"]],
  print: [["none", "Без"], ["star", "⭐"], ["heart", "❤️"], ["bolt", "⚡"], ["smile", "🙂"], ["fire", "🔥"], ["skull", "💀"], ["alien", "👽"], ["rocket", "🚀"], ["crown", "👑"], ["paw", "🐾"], ["music", "🎵"], ["krug", "KRUG"], ["number", "23"]],
  pet: [["none", "Без"], ["cat", "🐱 Котик"], ["ghost", "👻 Призрак"], ["star", "⭐ Звёздочка"], ["planet", "🪐 Планета"], ["heart", "💗 Сердце"], ["slime", "🟢 Слайм"], ["robot", "🤖 Дрон"], ["bird", "🐤 Птичка"]],
  fx: [["none", "Без"], ["sparkles", "✨ Искры"], ["hearts", "💕 Сердечки"], ["stars", "⭐ Звёзды"], ["bubbles", "🫧 Пузыри"], ["snow", "❄️ Снег"], ["notes", "🎵 Ноты"], ["petals", "🌸 Лепестки"], ["fire", "🔥 Огоньки"]],
  idle: [["calm", "😌 Спокойно"], ["bouncy", "🦘 Пружинит"], ["dance", "💃 Танцует"], ["float", "🎈 Парит"], ["sway", "🌊 Качается"], ["vibe", "🎧 Кивает в такт"]],
  bgStyle: [["gradient", "Градиент"], ["solid", "Однотонный"], ["stars", "Звёзды"], ["space", "Космос"], ["dots", "Горошек"], ["stripes", "Полосы"], ["rings", "Кольца"], ["sunburst", "Лучи"], ["hearts", "Сердечки"], ["grid", "Сетка"], ["confetti", "Конфетти"]],
  emotion: [["neutral", "😐 Спокойствие"], ["happy", "😄 Радость"], ["smirk", "😏 Ухмылка"], ["cool", "😎 Крутой"], ["surprised", "😮 Удивление"], ["love", "😍 Любовь"], ["laugh", "😂 Смех"], ["wink", "😉 Подмигивание"], ["angry", "😠 Злость"], ["sad", "😢 Грусть"], ["sleepy", "😴 Сонный"]],
};
/** Эмоция задаёт глаза, брови и рот; «Спокойствие» — то, что выбрано вручную */
const EMO = {
  neutral: null,
  happy: { eyes: "happy", mouth: "grin", brows: [.05, .05], tilt: [.12, .12] },
  smirk: { eyes: "round", mouth: "smirk", brows: [-.03, .1], tilt: [-.25, .3] },
  cool: { eyes: "half", mouth: "smirk", brows: [-.04, -.04], tilt: [-.08, -.08] },
  surprised: { eyes: "wide", mouth: "open", brows: [.13, .13], tilt: [.2, .2] },
  love: { eyes: "heart", mouth: "smile", brows: [.06, .06], tilt: [.15, .15], blush: true },
  laugh: { eyes: "happy", mouth: "laugh", brows: [.08, .08], tilt: [.2, .2] },
  wink: { eyes: "wink", mouth: "tongue", brows: [.02, .1], tilt: [.05, .25] },
  angry: { eyes: "narrow", mouth: "frown", brows: [-.06, -.06], tilt: [-.5, -.5] },
  sad: { eyes: "round", mouth: "frown", brows: [.04, .04], tilt: [.45, .45], tear: true },
  sleepy: { eyes: "sleepy", mouth: "calm", brows: [-.02, -.02], tilt: [0, 0] },
};
export const EMOTION_KEYS = Object.keys(EMO);
const OPEN_EYES = new Set(["round", "almond", "big", "anime", "small"]);

export const DEFAULT_SPEC = {
  headShape: "round", headSize: "m", build: "normal", ears: "normal", skin: 2, nose: "small",
  hair: "short", hairColor: 1, hairStreak: false, hairColor2: 8,
  eyes: "round", eyeColor: 0, heterochromia: false, eyeColor2: 1, eyeGlow: false, lashes: "none", eyeshadow: false, shadowColor: 1,
  brows: "soft", mouth: "smile", lipstick: false, lipColor: 0, facial: "none",
  cheeks: true, freckles: false, paint: "none", paintColor: 2, mole: "none", scar: "none", piercing: "none",
  hat: "none", hatColor: 1, glasses: "none", glassesColor: 0, earwear: "none", neck: "none", jewelColor: 8,
  outfit: "hoodie", outfitColor: 0, outfitColor2: 7, pattern: "none", print: "none",
  pet: "none", petColor: 3, fx: "none", idle: "calm", bg: 0, bgStyle: "gradient", emotion: "neutral",
};

/** Готовые образы: одно касание — и персонаж собран (дальше можно менять что угодно) */
export const PRESETS = [
  ["boss", "😎", "Босс", { hair: "none", brows: "bold", glasses: "shades", outfit: "coat", outfitColor: 1, emotion: "smirk", bg: 3, cheeks: false }],
  ["astro", "🧑‍🚀", "Космонавт", { hat: "astronaut", outfit: "spacesuit", outfitColor: 7, outfitColor2: 5, bg: 7, bgStyle: "space", pet: "planet", petColor: 3, fx: "stars", idle: "float" }],
  ["wizard", "🧙", "Маг", { hat: "wizard", hatColor: 12, facial: "longbeard", hairColor: 13, hair: "long", outfit: "hero", outfitColor: 12, outfitColor2: 0, fx: "sparkles", bg: 7, bgStyle: "stars" }],
  ["cat", "🐱", "Котик", { hat: "catears", hatColor: 6, paint: "whiskers", paintColor: 0, nose: "round", hair: "bob", hairColor: 11, eyes: "anime", lashes: "long", outfit: "hoodie", outfitColor: 6, pet: "cat", petColor: 7, bg: 11, bgStyle: "hearts", emotion: "happy" }],
  ["pirate", "🏴‍☠️", "Пират", { hat: "bandana", hatColor: 2, glasses: "eyepatch", facial: "beard", hairColor: 0, earwear: "hoops", jewelColor: 8, outfit: "shirt", outfitColor: 7, pattern: "stripes", outfitColor2: 1, scar: "cheek", bg: 1, bgStyle: "rings" }],
  ["rock", "🎸", "Рок-звезда", { hair: "mohawk", hairColor: 7, outfit: "biker", outfitColor: 1, glasses: "sunglasses", piercing: "brow", earwear: "studs", neck: "chain", jewelColor: 10, emotion: "cool", fx: "fire", idle: "vibe", bg: 2, bgStyle: "sunburst" }],
  ["princess", "👸", "Принцесса", { hair: "long", hairColor: 4, hat: "tiara", eyes: "big", lashes: "long", lipstick: true, lipColor: 2, neck: "pearls", outfit: "sweater", outfitColor: 6, pattern: "hearts", outfitColor2: 7, fx: "petals", bg: 11, bgStyle: "confetti" }],
  ["devil", "😈", "Чертёнок", { hat: "horns", hatColor: 2, skin: 2, hair: "spiky", hairColor: 0, mouth: "fangs", eyes: "almond", eyeGlow: true, eyeColor: 6, outfit: "hero", outfitColor: 1, outfitColor2: 2, bg: 2, fx: "fire" }],
  ["chef", "👨‍🍳", "Шеф", { hat: "chef", hatColor: 7, facial: "handlebar", outfit: "shirt", outfitColor: 7, neck: "scarf", outfitColor2: 2, emotion: "happy", bg: 3, bgStyle: "dots" }],
  ["cowboy", "🤠", "Ковбой", { hat: "cowboy", hatColor: 8, facial: "chevron", outfit: "jacket", outfitColor: 13, neck: "scarf", outfitColor2: 2, bg: 10, bgStyle: "sunburst" }],
  ["viking", "🪓", "Викинг", { hat: "viking", hatColor: 10, facial: "longbeard", hairColor: 10, hair: "braids", outfit: "armor", outfitColor: 9, paint: "warpaint", paintColor: 5, bg: 6, emotion: "angry" }],
  ["alien", "👽", "Пришелец", { skin: 8, hat: "antenna", hatColor: 4, eyes: "anime", eyeColor: 9, hair: "none", ears: "none", nose: "small", mouth: "calm", outfit: "spacesuit", outfitColor: 9, pet: "robot", petColor: 4, bg: 7, bgStyle: "space", idle: "float" }],
  ["gamer", "🎮", "Геймер", { hair: "short", hairColor: 9, earwear: "headphones", jewelColor: 1, glasses: "round", outfit: "hoodie", outfitColor: 1, print: "alien", fx: "notes", idle: "vibe", bg: 5, bgStyle: "grid" }],
  ["sport", "⚽", "Спортсмен", { hair: "buzz", hat: "headband", hatColor: 7, outfit: "jersey", outfitColor: 2, outfitColor2: 7, print: "number", neck: "medal", emotion: "happy", idle: "bouncy", bg: 4, bgStyle: "stripes" }],
  ["angel", "😇", "Ангел", { hat: "halo", hair: "curly", hairColor: 4, outfit: "tee", outfitColor: 7, fx: "sparkles", pet: "heart", petColor: 6, bg: 9, bgStyle: "stars", emotion: "happy", idle: "float" }],
  ["robot", "🤖", "Кибер", { skin: 11, hair: "none", glasses: "vr", glassesColor: 5, ears: "none", outfit: "armor", outfitColor: 10, pattern: "zigzag", outfitColor2: 5, pet: "robot", petColor: 5, bg: 1, bgStyle: "grid", idle: "vibe" }],
];

/** Старые аватары (один слот «acc») переводятся в новые слоты */
const LEGACY_HAT = new Set(["cap", "beanie", "crown", "halo"]);
const LEGACY_GLASSES = new Set(["glasses", "sunglasses", "shades"]);
export function normalizeSpec(raw) {
  const s = { ...DEFAULT_SPEC, ...(raw || {}) };
  if ("acc" in s) {
    const a = s.acc;
    const c = s.accColor ?? 0;
    if (LEGACY_HAT.has(a)) { s.hat = a; s.hatColor = c; }
    else if (LEGACY_GLASSES.has(a)) { s.glasses = a; s.glassesColor = c; }
    else if (a === "headphones") { s.earwear = "headphones"; s.jewelColor = c; }
  }
  delete s.acc; delete s.accColor;
  for (const [k, list] of Object.entries(OPTIONS)) if (!list.some(([v]) => v === s[k])) s[k] = DEFAULT_SPEC[k];
  return s;
}

export function colorOf(spec, key) {
  const v = spec[key] ?? DEFAULT_SPEC[key];
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) return v;
  const pal = PALETTES[COLOR_KEYS[key]];
  const c = pal[Number(v)] ?? pal[0];
  return Array.isArray(c) ? c[1] : c;
}
function bgPair(spec) {
  const v = spec.bg ?? 0;
  if (typeof v === "string" && v[0] === "#") return [mix(v, "#ffffff", .45), v];
  return PALETTES.bg[Number(v)] || PALETTES.bg[0];
}
function mix(a, b, k) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

export function randomSpec() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const s = {};
  for (const [k, list] of Object.entries(OPTIONS)) s[k] = pick(list)[0];
  for (const [k, pal] of Object.entries(COLOR_KEYS)) s[k] = Math.floor(Math.random() * PALETTES[pal].length);
  if (Math.random() < .75) s.skin = Math.floor(Math.random() * 8);       // чаще — обычные оттенки кожи
  for (const k of BOOL_KEYS) s[k] = Math.random() < .3;
  s.cheeks = Math.random() < .6;
  const rare = { facial: .55, paint: .8, mole: .8, scar: .85, piercing: .8, hat: .45, glasses: .55, earwear: .6, neck: .6, pattern: .6, print: .6, pet: .55, fx: .6, lashes: .5 };
  for (const [k, p] of Object.entries(rare)) if (Math.random() < p) s[k] = OPTIONS[k][0][0];
  if (Math.random() < .5) s.emotion = "neutral";
  if (Math.random() < .5) s.idle = "calm";
  if (Math.random() < .6) { s.headShape = "round"; s.headSize = "m"; s.build = "normal"; s.ears = "normal"; }
  if (["pig", "clown"].includes(s.nose) && Math.random() < .7) s.nose = "small";
  if (s.hat === "astronaut" && s.hair === "afro") s.hair = "short";
  return s;
}

// ---------------------------------------------------------------- фон (общий для живого 3D и снимка)
function rng(seed) { let x = seed || 1; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function heartPath(cx, x, y, r) {
  cx.beginPath(); cx.moveTo(x, y + r * .35);
  cx.bezierCurveTo(x, y, x - r, y, x - r, y + r * .35); cx.bezierCurveTo(x - r, y + r * .8, x, y + r, x, y + r * 1.25);
  cx.bezierCurveTo(x, y + r, x + r, y + r * .8, x + r, y + r * .35); cx.bezierCurveTo(x + r, y, x, y, x, y + r * .35); cx.fill();
}
export function drawBg(cx, size, spec) {
  const [a, b] = bgPair(spec);
  const st = spec.bgStyle || "gradient";
  const R = rng(7 + size);
  if (st === "solid") { cx.fillStyle = b; cx.fillRect(0, 0, size, size); return; }
  if (st === "space") {
    const g = cx.createRadialGradient(size * .5, size * .45, 0, size * .5, size * .5, size * .8);
    g.addColorStop(0, mix(b, "#000000", .35)); g.addColorStop(1, "#05040d");
    cx.fillStyle = g; cx.fillRect(0, 0, size, size);
    for (const [x, y, c] of [[.25, .3, a], [.75, .7, b]]) {
      const n = cx.createRadialGradient(x * size, y * size, 0, x * size, y * size, size * .4);
      n.addColorStop(0, c + "88"); n.addColorStop(1, c + "00"); cx.fillStyle = n; cx.fillRect(0, 0, size, size);
    }
    for (let i = 0; i < 90; i++) { cx.fillStyle = `rgba(255,255,255,${.4 + R() * .6})`; cx.beginPath(); cx.arc(R() * size, R() * size, R() * size * .006 + .5, 0, 7); cx.fill(); }
    return;
  }
  const g = cx.createRadialGradient(size * .3, size * .25, 0, size * .5, size * .5, size * .75);
  g.addColorStop(0, a); g.addColorStop(1, b);
  cx.fillStyle = g; cx.fillRect(0, 0, size, size);
  cx.fillStyle = "rgba(255,255,255,.18)"; cx.strokeStyle = "rgba(255,255,255,.18)";
  const u = size / 12;
  if (st === "stars") {
    for (let i = 0; i < 40; i++) { const x = R() * size, y = R() * size, r = (R() * .8 + .3) * u * .25;
      cx.fillStyle = `rgba(255,255,255,${.35 + R() * .5})`; cx.beginPath(); cx.moveTo(x, y - r * 2); cx.quadraticCurveTo(x, y, x + r * 2, y); cx.quadraticCurveTo(x, y, x, y + r * 2); cx.quadraticCurveTo(x, y, x - r * 2, y); cx.quadraticCurveTo(x, y, x, y - r * 2); cx.fill(); }
  } else if (st === "dots") {
    for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) { cx.beginPath(); cx.arc((x + (y % 2) * .5) * u, y * u, u * .18, 0, 7); cx.fill(); }
  } else if (st === "stripes") {
    cx.save(); cx.translate(size / 2, size / 2); cx.rotate(-Math.PI / 4);
    for (let i = -14; i < 14; i += 2) cx.fillRect(i * u, -size, u, size * 2);
    cx.restore();
  } else if (st === "rings") {
    cx.lineWidth = u * .35;
    for (let r = u; r < size; r += u * 1.1) { cx.beginPath(); cx.arc(size / 2, size * .42, r, 0, 7); cx.stroke(); }
  } else if (st === "sunburst") {
    cx.save(); cx.translate(size / 2, size * .42);
    for (let i = 0; i < 24; i += 2) { cx.beginPath(); cx.moveTo(0, 0); cx.arc(0, 0, size, i * Math.PI / 12, (i + 1) * Math.PI / 12); cx.fill(); }
    cx.restore();
  } else if (st === "hearts") {
    for (let i = 0; i < 26; i++) { cx.fillStyle = `rgba(255,255,255,${.15 + R() * .25})`; heartPath(cx, R() * size, R() * size, u * (.25 + R() * .35)); }
  } else if (st === "grid") {
    cx.lineWidth = Math.max(1, size / 260);
    for (let i = 0; i <= 12; i++) { cx.beginPath(); cx.moveTo(i * u, 0); cx.lineTo(i * u, size); cx.moveTo(0, i * u); cx.lineTo(size, i * u); cx.stroke(); }
  } else if (st === "confetti") {
    const cs = ["#ffffff", "#fde047", "#f472b6", "#22d3ee", "#a3e635", "#fb923c"];
    for (let i = 0; i < 70; i++) { cx.save(); cx.translate(R() * size, R() * size); cx.rotate(R() * 6); cx.fillStyle = cs[i % cs.length] + "cc"; cx.fillRect(-u * .15, -u * .06, u * .3, u * .12); cx.restore(); }
  }
}
const bgCache = new Map();
export function bgCss(spec) {
  const key = `${spec.bg}|${spec.bgStyle}`;
  if (!bgCache.has(key)) {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 512;
      drawBg(c.getContext("2d"), 512, spec);
      bgCache.set(key, `url(${c.toDataURL("image/jpeg", .9)}) center / cover`);
    } catch {
      const [a, b] = bgPair(spec);
      return `radial-gradient(circle at 30% 25%, ${a}, ${b} 75%)`;
    }
  }
  return bgCache.get(key);
}

// ---------------------------------------------------------------- текстуры одежды
function patternTexture(T, kind, c1, c2) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d");
  x.fillStyle = c1; x.fillRect(0, 0, 128, 128); x.fillStyle = c2; x.strokeStyle = c2;
  if (kind === "stripes") { x.fillRect(0, 0, 128, 40); x.fillRect(0, 64, 128, 40); }
  else if (kind === "dots") { for (const [a, b] of [[32, 32], [96, 96]]) { x.beginPath(); x.arc(a, b, 16, 0, 7); x.fill(); } }
  else if (kind === "checks") { x.globalAlpha = .55; x.fillRect(0, 0, 64, 128); x.fillRect(0, 0, 128, 64); x.globalAlpha = 1; x.fillRect(0, 0, 64, 64); }
  else if (kind === "camo") { const R = rng(3); for (let i = 0; i < 14; i++) { x.fillStyle = i % 2 ? c2 : mix(c1, "#000000", .35); x.beginPath(); x.ellipse(R() * 128, R() * 128, 14 + R() * 18, 9 + R() * 12, R() * 3, 0, 7); x.fill(); } }
  else if (kind === "stars") { x.font = "52px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("★", 32, 34); x.fillText("★", 96, 98); }
  else if (kind === "hearts") { heartPath(x, 32, 14, 18); heartPath(x, 96, 78, 18); }
  else if (kind === "zigzag") { x.lineWidth = 12; for (const y0 of [30, 94]) { x.beginPath(); for (let i = 0; i <= 8; i++) x.lineTo(i * 16, y0 + (i % 2 ? 16 : -16)); x.stroke(); } }
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace; t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(10, 3.2);
  return t;
}
const PRINT = { star: "⭐", heart: "❤️", bolt: "⚡", smile: "🙂", fire: "🔥", skull: "💀", alien: "👽", rocket: "🚀", crown: "👑", paw: "🐾", music: "🎵" };
function printTexture(T, kind, color) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d");
  x.textAlign = "center"; x.textBaseline = "middle";
  if (kind === "krug" || kind === "number") {
    x.fillStyle = color; x.font = `900 ${kind === "krug" ? 62 : 150}px Unbounded, Arial Black, sans-serif`;
    x.fillText(kind === "krug" ? "KRUG" : "23", 128, 136);
  } else { x.font = "180px 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif"; x.fillText(PRINT[kind] || "★", 128, 140); }
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- сборка персонажа
function build(T, rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const C = (k) => colorOf(spec, k);
  const g = new T.Group();
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const mat = (color, o = {}) => new T.MeshStandardMaterial({ color, roughness: o.r ?? .55, metalness: o.m ?? 0, emissive: o.e ?? 0x000000,
    emissiveIntensity: o.ei ?? 0, transparent: o.op != null, opacity: o.op ?? 1, side: o.side ?? T.FrontSide, map: o.map || null, depthWrite: o.dw ?? true });
  const mesh = (geo, m, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); return o; };
  const sphere = (r, seg = 32) => new T.SphereGeometry(r, seg, Math.max(8, seg * .75 | 0));
  const caps = (r, len, seg = 10) => new T.CapsuleGeometry(r, len, 4, seg);
  // выравнивает объект по нормали поверхности, сохраняя его собственный поворот
  const orient = (o, n) => { o.quaternion.premultiply(new T.Quaternion().setFromUnitVectors(V(0, 0, 1), n.clone().normalize())); return o; };
  const skin = mat(C("skin"), { r: .6 });
  const hairM = mat(C("hairColor"), { r: .75 });
  const hair2M = mat(C("hairColor2"), { r: .75 });
  const hatM = mat(C("hatColor"), { r: .5, m: .05 });
  const glassM = mat(C("glassesColor"), { r: .35, m: .3 });
  const jewel = mat(C("jewelColor"), { r: .22, m: .85 });
  const out2 = mat(C("outfitColor2"), { r: .75 });
  const dark = mat("#1b1420", { r: .4 });
  const white = mat("#ffffff", { r: .3 });
  const lens = (c = "#0b0b12", op = .85) => mat(c, { op, r: .08, m: .6 });

  // поверхность головы (эллипсоид .96 × 1.04 × .94) и тела (1.55 × .85 × .95, центр y = -1.95)
  const zHead = (x, y) => .94 * Math.sqrt(Math.max(0, 1 - (x / .96) ** 2 - (y / 1.04) ** 2));
  const nHead = (x, y, z) => V(x / .92, y / 1.08, z / .88).normalize();
  const onHead = (o, x, y, lift = .012) => { const z = zHead(x, y); o.position.set(...V(x, y, z).add(nHead(x, y, z).multiplyScalar(lift)).toArray()); return orient(o, nHead(x, y, z)); };
  const zBody = (y, x = 0) => .95 * Math.sqrt(Math.max(0, 1 - ((y + 1.95) / .85) ** 2 - (x / 1.55) ** 2));
  const nBody = (x, y, z) => V(x / 2.4, (y + 1.95) / .72, z / .9).normalize();
  const onBody = (o, x, y, lift = .01) => { const z = zBody(y, x); const n = nBody(x, y, z); o.position.copy(V(x, y, z).add(n.clone().multiplyScalar(lift))); return orient(o, n); };
  /** Лента по поверхности тела (галстук, лямки, лацканы) */
  const strip = (grp, pts, w, th, m, lift = .012) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const p1 = V(x1, y1, zBody(y1, x1)), p2 = V(x2, y2, zBody(y2, x2));
      const mid = p1.clone().add(p2).multiplyScalar(.5);
      const n = nBody(mid.x, mid.y, mid.z);
      const ya = p2.clone().sub(p1); const len = ya.length(); ya.normalize();
      const za = n.clone().sub(ya.clone().multiplyScalar(n.dot(ya))).normalize();
      const xa = ya.clone().cross(za);
      const o = mesh(new T.BoxGeometry(w, len * 1.08, th), m);
      o.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(xa, ya, za));
      o.position.copy(mid.add(n.multiplyScalar(lift + th / 2)));
      grp.add(o);
    }
  };
  /** Кусок поверхности тела — для принта, нагрудника, рубашки под пиджаком */
  const bodyPatch = (m, phiC, phiW, yC, hW, s = 1.008) => {
    const th = Math.acos(Math.max(-1, Math.min(1, (yC + 1.95) / .85)));
    const geo = new T.SphereGeometry(1, 24, 16, Math.PI / 2 + phiC - phiW, phiW * 2, th - hW, hW * 2);
    return mesh(geo, m, 0, -1.95, 0, 1.55 * s, .85 * s, .95 * s);
  };

  // ---------- тело
  const torso = new T.Group();
  const bodyW = { slim: .86, normal: 1, broad: 1.14 }[spec.build] || 1;
  torso.scale.set(bodyW, 1, spec.build === "broad" ? 1.05 : 1);
  torso.add(mesh(new T.CylinderGeometry(.3, .36, .5, 24), skin, 0, -1.08, 0));
  const patterned = spec.pattern !== "none" && !["armor", "spacesuit"].includes(spec.outfit);
  const outfitM = patterned ? mat("#ffffff", { r: .85, map: patternTexture(T, spec.pattern, C("outfitColor"), C("outfitColor2")) })
    : mat(C("outfitColor"), spec.outfit === "armor" ? { r: .35, m: .45 } : spec.outfit === "biker" ? { r: .35, m: .1 } : { r: .8 });
  const plain = mat(C("outfitColor"), { r: .8 });
  torso.add(mesh(sphere(1, 40), outfitM, 0, -1.95, 0, 1.55, .85, .95));
  const shade = (k) => mat(mix(C("outfitColor"), "#000000", k), { r: .7 });
  switch (spec.outfit) {
    case "hoodie":
      torso.add(mesh(new T.TorusGeometry(.42, .13, 16, 40), plain, 0, -1.28, .05, 1, .55, 1.1));
      for (const x of [-.16, .16]) strip(torso, [[x, -1.4], [x, -1.62], [x * 1.05, -1.78]], .035, .02, white);
      for (const x of [-.16, .16]) torso.add(onBody(mesh(sphere(.035, 10), white), x * 1.05, -1.8, .02));
      break;
    case "tee": case "jersey":
      torso.add(mesh(new T.TorusGeometry(.36, .045, 12, 40), spec.outfit === "jersey" ? out2 : mat(mix(C("outfitColor"), "#ffffff", .25), { r: .9 }), 0, -1.3, .12, 1, .5, 1));
      if (spec.outfit === "jersey") for (const s of [-1, 1]) strip(torso, [[s * 1.12, -1.55], [s * 1.28, -1.95], [s * 1.3, -2.25]], .14, .015, out2);
      break;
    case "shirt": {
      for (const s of [-1, 1]) { const col = mesh(new T.BoxGeometry(.32, .2, .04), out2); col.position.set(s * .2, -1.24, .52); col.rotation.set(-.6, s * .35, s * .55); torso.add(col); }
      for (let i = 0; i < 4; i++) torso.add(onBody(mesh(new T.CylinderGeometry(.035, .035, .02, 14), white).rotateX(Math.PI / 2), 0, -1.45 - i * .17, .015));
      strip(torso, [[0, -1.33], [0, -1.6], [0, -1.9], [0, -2.15]], .02, .01, shade(.25));
      break;
    }
    case "jacket":
      strip(torso, [[0, -1.33], [0, -1.6], [0, -1.9], [0, -2.2]], .05, .025, mat("#d1d5db", { r: .3, m: .7 }));
      for (const s of [-1, 1]) strip(torso, [[s * .32, -1.25], [s * .22, -1.5], [s * .1, -1.72]], .2, .035, shade(.3));
      break;
    case "biker":
      strip(torso, [[-.35, -1.33], [-.15, -1.6], [.05, -1.9], [.15, -2.2]], .04, .025, mat("#e5e7eb", { r: .25, m: .8 }));
      for (const s of [-1, 1]) strip(torso, [[s * .42, -1.25], [s * .3, -1.48], [s * .18, -1.62]], .26, .035, shade(.2));
      for (const s of [-1, 1]) torso.add(onBody(mesh(new T.CylinderGeometry(.04, .04, .02, 12), mat("#e5e7eb", { r: .25, m: .8 })).rotateX(Math.PI / 2), s * .6, -1.6, .02));
      break;
    case "sweater":
      torso.add(mesh(new T.TorusGeometry(.4, .09, 16, 40), out2, 0, -1.27, .04, 1, .45, 1.05));
      for (let i = -3; i <= 3; i++) torso.add(onBody(mesh(sphere(.05, 12), out2), i * .22, -1.85, .01));
      break;
    case "turtleneck":
      torso.add(mesh(new T.CylinderGeometry(.37, .42, .36, 32), plain, 0, -1.08, 0));
      for (let i = 0; i < 4; i++) torso.add(mesh(new T.TorusGeometry(.38 + i * .012, .025, 8, 40), shade(.15), 0, -.95 - i * .08, 0).rotateX(Math.PI / 2));
      break;
    case "coat": {
      const fur = mat("#e6d6bd", { r: 1 }), fur2 = mat("#cdb895", { r: 1 });
      torso.add(mesh(new T.TorusGeometry(.5, .2, 16, 40), fur2, 0, -1.27, .02, 1, .55, 1.1));
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2, k = (i * 7919) % 13 / 13, r = .55 + (i % 2) * .07;
        torso.add(mesh(sphere(.12 + k * .06, 14), i % 3 ? fur : fur2, Math.cos(a) * r, -1.25 - (i % 2) * .07 + Math.sin(a * 5) * .025, Math.sin(a) * r * 1.1 + .03, 1, .75, 1));
      }
      strip(torso, [[0, -1.5], [0, -1.8], [0, -2.15]], .022, .01, mat("#000000", { op: .3, r: .8 }));
      for (let i = 0; i < 3; i++) torso.add(onBody(mesh(new T.CylinderGeometry(.06, .06, .03, 20), mat("#d8b46a", { r: .25, m: .7 })).rotateX(Math.PI / 2), .13, -1.62 - i * .19, .015));
      break;
    }
    case "suit": {
      torso.add(bodyPatch(white, 0, .2, -1.55, .3));
      for (const s of [-1, 1]) strip(torso, [[s * .14, -1.27], [s * .2, -1.45], [s * .1, -1.85]], .14, .03, shade(.25));
      if (spec.neck !== "tie" && spec.neck !== "bowtie") strip(torso, [[0, -1.33], [0, -1.5], [0, -1.7], [0, -1.85]], .08, .02, out2);
      for (let i = 0; i < 2; i++) torso.add(onBody(mesh(new T.CylinderGeometry(.045, .045, .02, 14), dark).rotateX(Math.PI / 2), .02, -1.95 - i * .16, .02));
      break;
    }
    case "kimono":
      for (const s of [-1, 1]) strip(torso, [[s * .4, -1.22], [s * .25, -1.45], [-s * .05, -1.75], [-s * .2, -2.05]], .16, .02, out2);
      strip(torso, [[-1.45, -2.1], [-.7, -2.12], [0, -2.13], [.7, -2.12], [1.45, -2.1]], .22, .025, out2);
      break;
    case "overalls": {
      torso.add(bodyPatch(out2, 0, .26, -1.98, .2, 1.012));
      for (const s of [-1, 1]) {
        strip(torso, [[s * .45, -1.15], [s * .42, -1.45], [s * .35, -1.8]], .1, .02, out2);
        torso.add(onBody(mesh(new T.CylinderGeometry(.05, .05, .03, 14), mat("#e5c07b", { r: .3, m: .8 })).rotateX(Math.PI / 2), s * .35, -1.78, .035));
      }
      break;
    }
    case "armor": {
      const metal = mat(mix(C("outfitColor"), "#ffffff", .35), { r: .3, m: .55 });
      torso.add(bodyPatch(metal, 0, .4, -1.75, .35, 1.02));
      for (const s of [-1, 1]) torso.add(mesh(sphere(.34, 24), metal, s * 1.12, -1.36, 0, 1, .62, 1));
      for (let i = 0; i < 6; i++) torso.add(onBody(mesh(sphere(.03, 8), mat("#f5d07a", { r: .3, m: .9 })), (i % 3 - 1) * .45, -1.5 - Math.floor(i / 3) * .45, .035));
      break;
    }
    case "spacesuit": {
      torso.add(mesh(new T.TorusGeometry(.5, .12, 16, 40), mat("#9ca3af", { r: .3, m: .7 }), 0, -1.22, 0, 1, 1.05, 1).rotateX(Math.PI / 2));
      const box = onBody(mesh(new T.BoxGeometry(.6, .34, .1), mat("#e5e7eb", { r: .4 })), 0, -1.85, .05); torso.add(box);
      ["#ef4444", "#22c55e", "#3b82f6"].forEach((c, i) => torso.add(onBody(mesh(sphere(.045, 10), mat(c, { r: .3, e: c, ei: .5 })), -.15 + i * .15, -1.85, .12)));
      torso.add(onBody(mesh(new T.BoxGeometry(.3, .16, .02), mat(C("outfitColor2"), { r: .5 })), -.6, -1.6, .02));
      break;
    }
    case "hero": {
      const cape = mesh(new T.CylinderGeometry(1.2, 1.75, 1.9, 40, 1, true, Math.PI * .55, Math.PI * .9), mat(C("outfitColor2"), { r: .6, side: T.DoubleSide }), 0, -2.05, -.12);
      torso.add(cape);
      torso.add(mesh(new T.TorusGeometry(.42, .08, 12, 40), out2, 0, -1.25, 0, 1, 1.1, 1).rotateX(Math.PI / 2));
      for (const s of [-1, 1]) torso.add(onBody(mesh(new T.CylinderGeometry(.08, .08, .04, 18), mat("#f5c242", { r: .25, m: .9 })).rotateX(Math.PI / 2), s * .42, -1.32, .02));
      break;
    }
    default: break;
  }
  if (spec.print !== "none") {
    torso.add(bodyPatch(mat("#ffffff", { map: printTexture(T, spec.print, spec.outfit === "jersey" ? C("outfitColor2") : C("outfitColor") === "#f8fafc" ? "#111827" : "#ffffff"), op: 1, r: .7, dw: false }), spec.outfit === "suit" ? .32 : 0, .17, -1.82, .31, 1.016));
  }
  // шея: украшения и шарфы
  const neckG = new T.Group();
  // дуга ожерелья по груди: от боков шеи вниз к центру
  const necklace = (wd, dp, n = 11) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1) * 2 - 1; return [wd * t, -1.2 - dp * (1 - t * t)]; });
  switch (spec.neck) {
    case "chain": strip(neckG, necklace(.55, .42), .045, .03, jewel, .01); break;
    case "pendant": strip(neckG, necklace(.5, .4), .022, .018, jewel, .01); neckG.add(onBody(mesh(heartGeo(T), jewel, 0, 0, 0, 1.3, 1.3, 1), 0, -1.66, .02)); break;
    case "pearls": { const pm = mat("#fbf6ee", { r: .15, m: .3 }); for (const [x, y] of necklace(.55, .42, 17)) neckG.add(onBody(mesh(sphere(.048, 12), pm), x, y, .035)); break; }
    case "choker": neckG.add(mesh(new T.TorusGeometry(.33, .04, 10, 40), dark, 0, -1.0, 0).rotateX(Math.PI / 2)); neckG.add(mesh(sphere(.05, 12), jewel, 0, -1.03, .35)); break;
    case "scarf":
      neckG.add(mesh(new T.TorusGeometry(.46, .17, 16, 40), out2, 0, -1.2, 0, 1, 1.1, 1).rotateX(Math.PI / 2));
      strip(neckG, [[.3, -1.3], [.34, -1.6], [.36, -1.95]], .26, .06, out2, .02);
      break;
    case "bowtie":
      for (const s of [-1, 1]) { const w = mesh(new T.ConeGeometry(.13, .24, 4), out2, s * .13, 0, 0); w.rotation.z = s * Math.PI / 2; const bw = new T.Group(); bw.add(w); neckG.add(onBody(bw, 0, -1.32, .06)); }
      neckG.add(onBody(mesh(sphere(.06, 12), out2), 0, -1.32, .07));
      break;
    case "tie":
      neckG.add(onBody(mesh(sphere(.08, 12), out2, 0, 0, 0, 1, 1, .6), 0, -1.33, .03));
      strip(neckG, [[0, -1.38], [0, -1.6], [0, -1.85], [0, -2.05]], .13, .025, out2, .02);
      break;
    case "medal":
      strip(neckG, [[-.32, -1.22], [-.14, -1.5], [0, -1.68]], .07, .015, mat("#2563eb", { r: .6 }));
      strip(neckG, [[.32, -1.22], [.14, -1.5], [0, -1.68]], .07, .015, mat("#e11d48", { r: .6 }));
      neckG.add(onBody(mesh(new T.CylinderGeometry(.13, .13, .04, 28), mat("#f5c242", { r: .2, m: .9, e: 0x332200, ei: .4 })).rotateX(Math.PI / 2), 0, -1.78, .04));
      break;
    default: break;
  }
  torso.add(neckG);

  // ---------- голова: форма и размер — общий масштаб для всего, что на ней
  const head = new T.Group();
  const hs = new T.Group();
  head.add(hs);
  const shapeK = { round: [1, 1, 1], oval: [.93, 1.06, 1], wide: [1.08, .95, 1.02], long: [.9, 1.12, 1], chubby: [1.04, .98, 1.02] }[spec.headShape] || [1, 1, 1];
  const sizeK = { s: .9, m: 1, l: 1.12 }[spec.headSize] || 1;
  hs.scale.set(shapeK[0] * sizeK, shapeK[1] * sizeK, shapeK[2] * sizeK);
  hs.add(mesh(sphere(1, 48), skin, 0, 0, 0, .96, 1.04, .94));
  if (spec.headShape === "chubby") hs.add(mesh(sphere(.75, 32), skin, 0, -.42, .12, 1.15, .7, .9));
  // уши
  if (spec.ears !== "none") for (const s of [-1, 1]) {
    if (spec.ears === "elf") {
      hs.add(mesh(sphere(.2), skin, s * .93, -.05, -.02, .55, .9, .5));
      const c = mesh(new T.ConeGeometry(.15, .62, 16), skin, s * 1.12, .2, -.08, 1, 1, .45); c.rotation.z = -s * .75; hs.add(c);
    } else {
      const k = { small: .72, big: 1.45 }[spec.ears] || 1;
      hs.add(mesh(sphere(.22), skin, s * (.93 + (k - 1) * .1), -.05, -.02, .55 * k, .95 * k, .5 * k));
    }
  }

  // лицо (глаза, брови, рот) — отдельной группой: эмоции меняют его без пересборки персонажа
  const faceCtx = { skin, hairM, dark, white, mat, mesh, sphere, caps, C };
  let face = buildFace(T, spec, spec.emotion || "neutral", faceCtx);
  hs.add(face.group);
  // нос
  switch (spec.nose) {
    case "round": hs.add(mesh(sphere(.12), skin, 0, -.08, .97, 1, .9, .8)); break;
    case "pointy": { const n = mesh(new T.ConeGeometry(.09, .3, 20), skin, 0, -.08, 1.04); n.rotation.x = Math.PI / 2 - .15; hs.add(n); break; }
    case "wide": hs.add(mesh(sphere(.11), skin, 0, -.1, .96, 1.6, .85, .75)); break;
    case "long": { const n = mesh(caps(.075, .22), skin, 0, -.1, 1.0); n.rotation.x = Math.PI / 2 - .5; hs.add(n); break; }
    case "pig":
      hs.add(mesh(new T.CylinderGeometry(.14, .15, .1, 24), mat(mix(C("skin"), "#ff8fa3", .45), { r: .6 }), 0, -.1, 1.0).rotateX(Math.PI / 2));
      for (const s of [-1, 1]) hs.add(mesh(sphere(.03, 10), dark, s * .055, -.1, 1.05, 1, 1.3, .4));
      break;
    case "clown": hs.add(mesh(sphere(.15), mat("#ef2b2b", { r: .25 }), 0, -.08, 1.0)); break;
    default: hs.add(mesh(sphere(.085), skin, 0, -.08, .97, 1, .9, .8));
  }
  if (spec.cheeks) for (const s of [-1, 1]) hs.add(onHead(mesh(new T.CircleGeometry(.13, 24), mat("#ff7a8a", { op: .35, r: 1 })), s * .55, -.22, .01));
  if (spec.freckles) {
    const fm = mat("#8b5a3c", { op: .7, r: 1 });
    [[-.5, -.08], [-.42, -.14], [-.55, -.18], [-.36, -.06], [.5, -.08], [.42, -.14], [.55, -.18], [.36, -.06]].forEach(([x, y]) => hs.add(onHead(mesh(sphere(.016, 8), fm), x, y, 0)));
  }
  // раскраска лица
  const paintM = mat(C("paintColor"), { r: .8, op: .92 });
  switch (spec.paint) {
    case "whiskers":
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const w = onHead(mesh(caps(.012, .2, 6), paintM), s * .58, -.2 + (i - 1) * .07, .006); w.rotateZ(Math.PI / 2 + s * (i - 1) * .18); hs.add(w); }
      break;
    case "warpaint":
      for (const s of [-1, 1]) for (let i = 0; i < 2; i++) { const w = onHead(mesh(new T.BoxGeometry(.26, .045, .01), paintM), s * .42, -.07 - i * .08, .006); w.rotateZ(s * .15); hs.add(w); }
      break;
    case "star": hs.add(onHead(mesh(new T.ShapeGeometry(starShape(T, .1, .045)), paintM), .52, -.2, .008)); break;
    case "heart": hs.add(onHead(mesh(new T.ShapeGeometry(heartShape(T)), paintM, 0, 0, 0, .9, .9, 1), .52, -.18, .008)); break;
    case "tear": hs.add(onHead(mesh(new T.CircleGeometry(.04, 16), paintM, 0, 0, 0, .8, 1.3, 1), -.44, -.2, .006)); break;
    case "glitter": {
      const gm = mat("#fff2a8", { r: .2, m: .9, e: 0xffe066, ei: .8 });
      const R = rng(11);
      for (let i = 0; i < 16; i++) { const s = i % 2 ? 1 : -1; hs.add(onHead(mesh(new T.OctahedronGeometry(.018), gm), s * (.38 + R() * .28), .05 - R() * .22, .01)); }
      break;
    }
    default: break;
  }
  if (spec.mole !== "none") {
    const [x, y] = { cheek: [-.45, -.3], lip: [.2, -.3], eye: [.56, .02] }[spec.mole];
    hs.add(onHead(mesh(sphere(.022, 10), mat("#4a2c1c", { r: .7 })), x, y, 0));
  }
  if (spec.scar !== "none") {
    const sm = mat(mix(C("skin"), "#9b2c2c", .45), { r: .9 });
    const pts = spec.scar === "eye" ? [[-.38, .42], [-.36, .22], [-.34, .02], [-.32, -.14]] : [[.38, -.1], [.48, -.22], [.58, -.34]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const seg = onHead(mesh(caps(.012, Math.hypot(x2 - x1, y2 - y1), 6), sm), (x1 + x2) / 2, (y1 + y2) / 2, .02);
      seg.rotateZ(Math.atan2(x2 - x1, -(y2 - y1)) * -1); hs.add(seg);
      const tick = onHead(mesh(caps(.008, .07, 6), sm), (x1 + x2) / 2, (y1 + y2) / 2, .022); tick.rotateZ(Math.PI / 2 + .3); hs.add(tick);
    }
  }
  // пирсинг
  switch (spec.piercing) {
    case "nose": hs.add(onHead(mesh(new T.TorusGeometry(.04, .009, 8, 20), jewel), .085, -.12, .05)); break;
    case "septum": { const r = mesh(new T.TorusGeometry(.045, .01, 8, 24, Math.PI * 1.3), jewel, 0, -.19, 1.02); r.rotation.z = Math.PI * 1.15; hs.add(r); break; }
    case "brow": for (const dy of [0, .07]) hs.add(onHead(mesh(sphere(.022, 10), jewel), .47, .36 + dy, .02)); break;
    case "lip": hs.add(onHead(mesh(new T.TorusGeometry(.04, .01, 8, 20), jewel), .14, -.47, .03)); break;
    default: break;
  }

  // ---------- волосы
  const hair = new T.Group();
  // шапка волос: макушка целиком, а ниже — только бока и затылок, чтобы лоб и глаза оставались открытыми
  const cap = (r, theta, y = 0, z = 0, m = hairM) => {
    const top = Math.PI * .3;
    if (theta <= top) return mesh(new T.SphereGeometry(r, 48, 24, 0, Math.PI * 2, 0, theta), m, 0, y, z);
    const grp = new T.Group(); grp.position.set(0, y, z);
    grp.add(mesh(new T.SphereGeometry(r, 48, 16, 0, Math.PI * 2, 0, top), m));
    const w = Math.PI * .27;
    grp.add(mesh(new T.SphereGeometry(r, 48, 12, Math.PI / 2 + w, Math.PI * 2 - w * 2, top - .01, theta - top + .01), m));
    return grp;
  };
  const tail = (x, y, z, len, r, rx, rz, m = hairM) => { const t = mesh(caps(r, len, 14), m, x, y, z); t.rotation.set(rx, 0, rz); hair.add(t); return t; };
  const fringe = () => { const fr = mesh(sphere(.5), hairM, .1, .72, .45, 1.4, .45, .6); fr.rotation.z = -.25; hair.add(fr); };
  switch (spec.hair) {
    case "buzz": hair.add(cap(1.005, Math.PI * .42, .02, -.02)); break;
    case "short": hair.add(cap(1.06, Math.PI * .45, .02, -.05)); fringe(); break;
    case "side": {
      hair.add(cap(1.06, Math.PI * .46, .02, -.05));
      const sw = mesh(sphere(.55), hairM, -.25, .72, .42, 1.35, .5, .62); sw.rotation.z = .45; hair.add(sw);
      const sw2 = mesh(sphere(.4), hairM, .45, .62, .45, 1, .5, .55); sw2.rotation.z = .2; hair.add(sw2);
      break;
    }
    case "quiff": {
      hair.add(cap(1.04, Math.PI * .44, .02, -.05));
      const q = mesh(sphere(.5), hairM, 0, 1.0, .4, 1.25, .7, .85); q.rotation.x = -.5; hair.add(q);
      break;
    }
    case "undercut":
      hair.add(cap(1.004, Math.PI * .5, .01, -.02, mat(mix(C("hairColor"), C("skin"), .45), { r: .9 })));
      hair.add(cap(1.1, Math.PI * .3, .1, -.04));
      { const fr = mesh(sphere(.5), hairM, .05, .9, .38, 1.3, .5, .7); fr.rotation.set(-.3, 0, -.3); hair.add(fr); }
      break;
    case "long": case "wavy":
      hair.add(cap(1.07, Math.PI * .5, .02, -.04));
      hair.add(mesh(new T.CapsuleGeometry(.85, 1.1, 8, 24), hairM, 0, -.55, -.38, 1.1, 1, .6));
      if (spec.hair === "long") for (const s of [-1, 1]) hair.add(mesh(caps(.2, 1.2, 16), hairM, s * .92, -.55, .15));
      else for (const s of [-1, 1]) for (let i = 0; i < 7; i++) hair.add(mesh(sphere(.22, 16), hairM, s * (.92 + Math.sin(i * 1.4) * .08), .1 - i * .22, .12 + Math.cos(i * 1.4) * .05));
      fringe();
      break;
    case "bob":
      hair.add(cap(1.08, Math.PI * .5, .02, -.04));
      for (const s of [-1, 1]) hair.add(mesh(sphere(.42), hairM, s * .88, -.28, .02, .55, 1.15, .95));
      hair.add(mesh(sphere(.95), hairM, 0, -.2, -.25, 1.05, .95, .8));
      break;
    case "bangs":
      hair.add(cap(1.08, Math.PI * .5, .02, -.04));
      hair.add(mesh(new T.CylinderGeometry(.99, 1.0, .36, 40, 1, true, -Math.PI * .36, Math.PI * .72), mat(C("hairColor"), { r: .75, side: T.DoubleSide }), 0, .62, .04, 1.02, 1, 1.05));
      for (const s of [-1, 1]) hair.add(mesh(sphere(.42), hairM, s * .88, -.3, .02, .55, 1.2, .95));
      hair.add(mesh(sphere(.95), hairM, 0, -.25, -.25, 1.05, 1, .8));
      break;
    case "emo": {
      hair.add(cap(1.07, Math.PI * .48, .02, -.04));
      const sw = mesh(sphere(.5), hairM, .3, .4, .8, .85, 1.0, .35); sw.rotation.z = -.5; hair.add(sw);
      hair.add(mesh(sphere(.9), hairM, 0, -.15, -.3, 1.05, .9, .8));
      break;
    }
    case "curly":
      for (let i = 0; i < 46; i++) {
        const t = i / 46, phi = Math.acos(1 - t * 1.05), th = i * 2.4;
        const x = Math.sin(phi) * Math.cos(th), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(th);
        if (z > .55 && y < .55) continue;
        hair.add(mesh(sphere(.26, 16), hairM, x * 1.02, y * 1.02 + .02, z * 1.02 - .04));
      }
      break;
    case "afro":
      hair.add(mesh(sphere(1.2, 40), hairM, 0, .45, -.3));
      for (let i = 0; i < 90; i++) {
        const t = i / 90, phi = Math.acos(1 - t * 1.4), th = i * 2.4;
        const x = Math.sin(phi) * Math.cos(th), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(th);
        if (z > .3 && y < .45) continue;
        hair.add(mesh(sphere(.24, 12), hairM, x * 1.25, y * 1.25 + .45, z * 1.25 - .3));
      }
      break;
    case "bun": hair.add(cap(1.04, Math.PI * .46, .02, -.04)); hair.add(mesh(sphere(.38), hairM, 0, 1.05, -.35)); break;
    case "topknot":
      hair.add(cap(1.02, Math.PI * .46, .02, -.04));
      hair.add(mesh(sphere(.24), hairM, 0, 1.12, -.2)); hair.add(mesh(new T.TorusGeometry(.12, .04, 8, 20), mat("#e11d48", { r: .5 }), 0, 1.0, -.16).rotateX(Math.PI / 2 - .3));
      break;
    case "spacebuns":
      hair.add(cap(1.05, Math.PI * .47, .02, -.04));
      for (const s of [-1, 1]) hair.add(mesh(sphere(.34), hairM, s * .62, .95, -.1));
      break;
    case "ponytail":
      hair.add(cap(1.06, Math.PI * .5, .02, -.04)); fringe();
      hair.add(mesh(new T.TorusGeometry(.13, .05, 8, 20), mat(C("hairColor2"), { r: .5 }), 0, .55, -.92).rotateX(.5));
      tail(0, .0, -1.15, .9, .2, .45, 0);
      break;
    case "pigtails":
      hair.add(cap(1.06, Math.PI * .5, .02, -.04)); fringe();
      for (const s of [-1, 1]) { tail(s * 1.2, -.05, -.25, .75, .19, .2, s * .55); hair.add(mesh(sphere(.11, 12), mat(C("hairColor2"), { r: .5 }), s * .98, .25, -.25)); }
      break;
    case "braids":
      hair.add(cap(1.07, Math.PI * .5, .02, -.04)); fringe();
      for (const s of [-1, 1]) for (let i = 0; i < 10; i++) {
        const y = -.15 - i * .16, z = i < 4 ? .2 + i * .08 : zBody(y - .15, .7) * 1.0 + .12;
        hair.add(mesh(sphere(.13 - i * .004, 14), hairM, s * (.88 - Math.min(i, 5) * .03), y, Math.max(.2, z)));
      }
      break;
    case "dreads":
      hair.add(cap(1.05, Math.PI * .48, .02, -.04));
      for (let i = 0; i < 18; i++) {
        const a = Math.PI * (.08 + i / 17 * .84);   // по кругу сзади и по бокам
        const x = Math.cos(a) * .98, z = -Math.sin(a) * .85;
        const d = mesh(caps(.085, .9, 8), hairM, x * 1.02, -.35, z); d.rotation.set(-z * .25, 0, x * .25); hair.add(d);
      }
      break;
    case "mullet":
      hair.add(cap(1.06, Math.PI * .45, .02, -.05)); fringe();
      hair.add(mesh(new T.CapsuleGeometry(.6, .5, 8, 20), hairM, 0, -.45, -.62, 1.2, 1, .55));
      break;
    case "mohawk":
      hair.add(cap(1.005, Math.PI * .4, .01, -.02));
      for (let i = 0; i < 7; i++) { const a = -.9 + i * .3; const c = mesh(new T.ConeGeometry(.13, .55, 12), hairM, 0, Math.cos(a) * 1.05 + .15, Math.sin(a) * 1.05); c.rotation.x = a; hair.add(c); }
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
  if (spec.hairStreak && !["none", "buzz", "undercut"].includes(spec.hair)) {
    const st = mesh(caps(.075, .45, 10), hair2M, -.3, .7, .66); st.rotation.set(-.55, 0, .45); hair.add(st);
    const st2 = mesh(caps(.06, .35, 10), hair2M, -.12, .8, .62); st2.rotation.set(-.6, 0, .3); hair.add(st2);
  }
  // шляпы, которые закрывают макушку, прячут высокие причёски
  const bigHat = ["tophat", "cowboy", "wizard", "chef", "astronaut", "viking"].includes(spec.hat);
  if (!(bigHat && ["mohawk", "spiky", "quiff", "bun", "topknot", "spacebuns"].includes(spec.hair))) hs.add(hair);
  else { hair.children.filter((m) => m.position.y > .8).forEach((m) => hair.remove(m)); hs.add(hair); }

  // растительность на лице
  const stubM = mat(C("hairColor"), { op: .35, r: 1 });
  if (["beard", "stubble", "longbeard"].includes(spec.facial)) {
    hs.add(mesh(new T.SphereGeometry(1.025, 40, 20, Math.PI * .05, Math.PI * .9, Math.PI * .67, Math.PI * .27), spec.facial === "stubble" ? stubM : hairM, 0, -.04, 0, 1, 1.02, 1));
  }
  if (spec.facial === "longbeard") { const lb = mesh(new T.ConeGeometry(.42, 1.0, 24), hairM, 0, -1.15, .62, 1, 1, .55); lb.rotation.x = Math.PI + .25; hs.add(lb); }
  if (["mustache", "beard", "longbeard"].includes(spec.facial)) for (const s of [-1, 1]) { const m = mesh(caps(.05, .16, 12), hairM, s * .1, -.24, .95); m.rotation.z = Math.PI / 2 + s * .35; hs.add(m); }
  if (spec.facial === "chevron") hs.add(onHead(mesh(caps(.08, .28, 12), hairM).rotateZ(Math.PI / 2), 0, -.24, .03));
  if (spec.facial === "handlebar") for (const s of [-1, 1]) {
    const m = mesh(new T.TorusGeometry(.11, .035, 8, 20, Math.PI * 1.2), hairM, s * .15, -.21, .98); m.rotation.z = s > 0 ? -.5 : Math.PI + .5 - Math.PI * .2; hs.add(m);
  }
  if (spec.facial === "goatee") { hs.add(onHead(mesh(sphere(.15, 16), hairM, 0, 0, 0, 1, 1.3, .55), 0, -.68, .02)); hs.add(onHead(mesh(caps(.03, .14, 8), hairM).rotateZ(Math.PI / 2), 0, -.25, .02)); }
  if (spec.facial === "sideburns") for (const s of [-1, 1]) hs.add(onHead(mesh(caps(.07, .32, 10), hairM, 0, 0, 0, 1, 1, .6), s * .84, -.12, .0));

  // ---------- головные уборы
  const hat = new T.Group();
  const gold = mat("#f5c242", { r: .25, m: .9, e: 0x3a2a00, ei: .4 });
  switch (spec.hat) {
    case "cap": case "capback": {
      hat.add(mesh(new T.SphereGeometry(1.07, 48, 24, 0, Math.PI * 2, 0, Math.PI * .45), hatM, 0, .05, -.03));
      const brim = mesh(new T.CylinderGeometry(.62, .62, .05, 40, 1, false, -Math.PI / 2, Math.PI), hatM, 0, .42, .66, 1, 1, 1.15);
      brim.rotation.x = .08;
      if (spec.hat === "capback") { brim.position.z = -.66; brim.rotation.set(-.08, Math.PI, 0); }
      hat.add(brim); hat.add(mesh(sphere(.07, 12), hatM, 0, 1.11, -.03));
      break;
    }
    case "beanie":
      hat.add(mesh(new T.SphereGeometry(1.09, 48, 24, 0, Math.PI * 2, 0, Math.PI * .43), hatM, 0, .1, -.02));
      hat.add(mesh(new T.TorusGeometry(.92, .12, 16, 48), hatM, 0, .42, -.02).rotateX(Math.PI / 2));
      hat.add(mesh(sphere(.2), white, 0, 1.22, -.05));
      break;
    case "beret": { const b = mesh(sphere(1, 40), hatM, -.12, .82, -.05, 1.12, .32, 1.08); b.rotation.z = .22; hat.add(b); hat.add(mesh(new T.CylinderGeometry(.03, .03, .12, 8), hatM, -.2, 1.18, -.05)); break; }
    case "bandana":
      hat.add(mesh(new T.SphereGeometry(1.07, 48, 24, 0, Math.PI * 2, 0, Math.PI * .44), hatM, 0, .04, -.03));
      for (const s of [-1, 1]) hat.add(mesh(sphere(.13, 12), hatM, s * .12, .25, -1.03, 1, .8, .7));
      for (const s of [-1, 1]) { const t = mesh(caps(.06, .35, 8), hatM, s * .15, .0, -1.05); t.rotation.z = s * .3; hat.add(t); }
      for (let i = 0; i < 10; i++) { const a = i * 2.2, ph = .35 + (i % 3) * .25; hat.add(mesh(sphere(.035, 8), white, Math.sin(ph) * Math.cos(a) * 1.07, Math.cos(ph) * 1.07 + .04, Math.sin(ph) * Math.sin(a) * 1.07 - .03)); }
      break;
    case "headband": hat.add(mesh(new T.TorusGeometry(.92, .085, 12, 48), hatM, 0, .66, -.08, 1, .98, 1).rotateX(Math.PI / 2 + .3)); break;
    case "cowboy": {
      const brim = mesh(new T.CylinderGeometry(1.5, 1.5, .05, 48), hatM, 0, .7, -.05, 1, 1, .92); hat.add(brim);
      hat.add(mesh(new T.TorusGeometry(1.48, .07, 8, 48), hatM, 0, .76, -.05, 1, .92, 1).rotateX(Math.PI / 2));
      hat.add(mesh(new T.CylinderGeometry(.72, .82, .62, 40), hatM, 0, 1.02, -.05));
      hat.add(mesh(sphere(.72, 32), hatM, 0, 1.3, -.05, 1, .35, .9));
      hat.add(mesh(new T.CylinderGeometry(.83, .85, .12, 40), mat(mix(C("hatColor"), "#000000", .55), { r: .6 }), 0, .8, -.05));
      break;
    }
    case "tophat":
      hat.add(mesh(new T.CylinderGeometry(1.05, 1.05, .05, 48), hatM, 0, .8, -.05));
      hat.add(mesh(new T.CylinderGeometry(.66, .68, 1.0, 40), hatM, 0, 1.3, -.05));
      hat.add(mesh(new T.CylinderGeometry(.69, .69, .16, 40), mat(mix(C("hatColor"), "#e11d48", .55), { r: .5 }), 0, .92, -.05));
      break;
    case "wizard": {
      hat.add(mesh(new T.CylinderGeometry(1.35, 1.35, .05, 48), hatM, 0, .66, -.05));
      const cone = mesh(new T.ConeGeometry(.9, 1.9, 40), hatM, .1, 1.55, -.08); cone.rotation.z = -.12; hat.add(cone);
      for (let i = 0; i < 6; i++) hat.add(mesh(new T.ShapeGeometry(starShape(T, .08, .035)), mat("#ffe27a", { e: 0xffd34d, ei: .6, side: T.DoubleSide }), -.35 + (i % 3) * .3, .95 + Math.floor(i / 3) * .45 + (i % 2) * .1, .7 - Math.floor(i / 3) * .2));
      break;
    }
    case "party": {
      const c = mesh(new T.ConeGeometry(.42, .95, 32), hatM, .15, 1.38, 0); c.rotation.z = -.18; hat.add(c);
      for (let i = 0; i < 3; i++) hat.add(mesh(new T.TorusGeometry(.33 - i * .1, .025, 8, 32), white, .15 + i * .05, 1.12 + i * .22, 0).rotateX(Math.PI / 2));
      hat.add(mesh(sphere(.12, 16), mat("#fde047", { r: .5 }), .27, 1.88, 0));
      break;
    }
    case "chef":
      hat.add(mesh(new T.CylinderGeometry(.78, .74, .5, 40), white, 0, .9, -.05));
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; hat.add(mesh(sphere(.42, 20), white, Math.cos(a) * .45, 1.38, Math.sin(a) * .45 - .05)); }
      hat.add(mesh(sphere(.5, 20), white, 0, 1.5, -.05));
      break;
    case "crown":
      hat.add(mesh(new T.CylinderGeometry(.58, .62, .26, 40, 1, true), mat("#f5c242", { r: .25, m: .9, e: 0x3a2a00, ei: .4, side: T.DoubleSide }), 0, 1.0, -.05));
      for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; hat.add(mesh(new T.ConeGeometry(.09, .26, 10), gold, Math.cos(a) * .6, 1.24, Math.sin(a) * .6 - .05)); }
      for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + (i - 1) * .9; hat.add(mesh(sphere(.06), mat(["#e11d48", "#22d3ee", "#10b981"][i], { r: .1, m: .3 }), Math.cos(a) * .62, 1.0, Math.sin(a) * .62 - .05)); }
      break;
    case "tiara": {
      const t = mesh(new T.TorusGeometry(.85, .035, 8, 48, Math.PI), mat("#e5e7eb", { r: .2, m: .9 }), 0, .55, -.05); t.rotation.x = -1.15; hat.add(t);
      for (let i = 0; i < 5; i++) { const a = Math.PI * (.2 + i * .15); hat.add(mesh(new T.OctahedronGeometry(i === 2 ? .1 : .06), mat(i === 2 ? C("hatColor") : "#bfe9ff", { r: .1, m: .4, e: i === 2 ? C("hatColor") : "#000000", ei: .3 }), Math.cos(a) * .82, .78 + Math.sin(a) * .16 + (i === 2 ? .06 : 0), Math.sin(a) * .35 + .05)); }
      break;
    }
    case "halo": hat.add(mesh(new T.TorusGeometry(.62, .07, 16, 48), mat("#ffe27a", { r: .2, m: .5, e: 0xffd34d, ei: 1.2 }), 0, 1.45, -.1).rotateX(Math.PI / 2 - .25)); break;
    case "flowers": {
      hat.add(mesh(new T.TorusGeometry(.9, .04, 8, 48), mat("#3f8f3a", { r: .7 }), 0, .55, -.03).rotateX(Math.PI / 2 + .18));
      const cols = [C("hatColor"), "#ffffff", "#f9a8d4", "#fde047"];
      for (let i = 0; i < 11; i++) {
        const a = Math.PI * (-.15 + i / 10 * 1.3), x = Math.cos(a) * .9, z = Math.sin(a) * .9 - .03, y = .55 + Math.sin(a) * .16;
        const f = new T.Group(); f.position.set(x, y, z);
        for (let p = 0; p < 5; p++) { const pa = p / 5 * Math.PI * 2; f.add(mesh(sphere(.07, 10), mat(cols[i % cols.length], { r: .6 }), Math.cos(pa) * .08, .03, Math.sin(pa) * .08, 1, .5, 1)); }
        f.add(mesh(sphere(.05, 10), mat("#f59e0b", { r: .5 }), 0, .05, 0)); hat.add(f);
      }
      break;
    }
    case "bow":
      for (const s of [-1, 1]) { const w = mesh(sphere(.22, 20), hatM, .45 + s * .2, .95, .2, 1.1, .7, .45); w.rotation.z = s * .4 + .3; hat.add(w); }
      hat.add(mesh(sphere(.09, 14), hatM, .45, .95, .26));
      break;
    case "catears": case "bunnyears": {
      const inner = mat("#ffb3c7", { r: .7 });
      for (const s of [-1, 1]) {
        const g2 = new T.Group();
        if (spec.hat === "catears") { g2.add(mesh(new T.ConeGeometry(.3, .5, 4), hatM, 0, 0, 0, 1, 1, .45)); g2.add(mesh(new T.ConeGeometry(.18, .32, 4), inner, 0, -.04, .08, 1, 1, .3)); g2.position.set(s * .55, 1.05, -.05); g2.rotation.z = -s * .45; }
        else { g2.add(mesh(caps(.14, .75, 12), hatM, 0, 0, 0, 1, 1, .55)); g2.add(mesh(caps(.08, .6, 10), inner, 0, 0, .06, 1, 1, .3)); g2.position.set(s * .32, 1.55, -.1); g2.rotation.z = -s * .18; }
        hat.add(g2);
      }
      if (spec.hat === "bunnyears") hat.add(mesh(new T.TorusGeometry(.95, .05, 8, 48, Math.PI), hatM, 0, .35, -.1).rotateX(-.25));
      break;
    }
    case "horns": for (const s of [-1, 1]) { const h2 = mesh(new T.ConeGeometry(.13, .45, 16), mat("#d11a2a", { r: .3, m: .2 }), s * .48, 1.0, .15); h2.rotation.set(-.15, 0, -s * .45); hat.add(h2); } break;
    case "viking": {
      const metal = mat("#a1a1aa", { r: .3, m: .85 });
      hat.add(mesh(new T.SphereGeometry(1.08, 48, 24, 0, Math.PI * 2, 0, Math.PI * .45), metal, 0, .04, -.03));
      hat.add(mesh(new T.TorusGeometry(.95, .07, 10, 48), mat("#f5c242", { r: .3, m: .8 }), 0, .45, -.03).rotateX(Math.PI / 2));
      for (const s of [-1, 1]) { const h2 = mesh(new T.ConeGeometry(.15, .7, 16), mat("#f3ead8", { r: .5 }), s * 1.05, .9, -.05); h2.rotation.z = -s * .95; hat.add(h2); }
      break;
    }
    case "antenna":
      for (const s of [-1, 1]) {
        const st = mesh(new T.CylinderGeometry(.025, .025, .6, 8), hatM, s * .3, 1.25, 0); st.rotation.z = -s * .3; hat.add(st);
        hat.add(mesh(sphere(.1, 14), mat(C("hatColor"), { r: .2, e: C("hatColor"), ei: 1 }), s * .4, 1.55, 0));
      }
      break;
    case "astronaut":
      hat.add(mesh(sphere(1.5, 48), mat("#cfe8ff", { op: .16, r: .05, m: .2, dw: false }), 0, .02, .02));
      hat.add(mesh(new T.TorusGeometry(.95, .14, 16, 48), mat("#e5e7eb", { r: .35, m: .5 }), 0, -1.12, 0).rotateX(Math.PI / 2));
      hat.add(mesh(new T.CylinderGeometry(.12, .12, .05, 16), mat("#ef4444", { e: "#ef4444", ei: .6 }), .9, -1.0, .55).rotateX(Math.PI / 2));
      break;
    default: break;
  }
  hs.add(hat);

  // ---------- очки
  const gl = new T.Group();
  const temples = (m = glassM, y = .14) => { for (const s of [-1, 1]) { const tm = mesh(new T.BoxGeometry(.03, .035, .72), m, s * .92, y, .38); tm.rotation.y = -s * .3; gl.add(tm); } };
  switch (spec.glasses) {
    case "glasses": case "sunglasses": case "round": {
      const r = spec.glasses === "round" ? .22 : .2;
      for (const s of [-1, 1]) {
        gl.add(mesh(new T.TorusGeometry(r, spec.glasses === "round" ? .018 : .028, 12, 32), glassM, s * .34, .12, .97));
        if (spec.glasses === "sunglasses") gl.add(mesh(new T.CircleGeometry(r - .01, 32), lens(), s * .34, .12, .975));
      }
      gl.add(mesh(new T.CylinderGeometry(.02, .02, .2, 8), glassM, 0, .15, 1.0).rotateZ(Math.PI / 2)); temples();
      break;
    }
    case "nerd":
      for (const s of [-1, 1]) {
        for (const [w, h2, x, y] of [[.44, .06, 0, .17], [.44, .06, 0, -.17], [.06, .4, -.2, 0], [.06, .4, .2, 0]]) gl.add(mesh(new T.BoxGeometry(w, h2, .05), glassM, s * .34 + x, .12 + y, .97));
        gl.add(mesh(new T.PlaneGeometry(.36, .3), lens("#bfe3ff", .18), s * .34, .12, .965));
      }
      gl.add(mesh(new T.BoxGeometry(.2, .05, .05), glassM, 0, .2, 1.0)); temples();
      break;
    case "shades": {
      gl.add(mesh(new T.CylinderGeometry(1.09, 1.09, .2, 48, 1, true, -Math.PI * .27, Math.PI * .54), mat(C("glassesColor") === "#1f1a17" ? "#0d0d14" : C("glassesColor"), { r: .12, m: .7, side: T.DoubleSide }), 0, .14, 0, .97, 1, .99));
      gl.add(mesh(new T.CylinderGeometry(1.095, 1.095, .025, 48, 1, true, -Math.PI * .2, Math.PI * .22), mat("#ffffff", { op: .55, r: .1 }), 0, .19, 0, .97, 1, .99));
      temples(mat("#0d0d14", { r: .2, m: .6 }), .15);
      break;
    }
    case "aviator": {
      const goldF = mat("#d4a017", { r: .25, m: .9 });
      for (const s of [-1, 1]) {
        gl.add(mesh(new T.CircleGeometry(.21, 32), lens(mix(C("glassesColor"), "#3b2a1a", .5), .8), s * .35, .08, .975, 1, 1.15, 1));
        gl.add(mesh(new T.TorusGeometry(.21, .015, 8, 32), goldF, s * .35, .08, .975, 1, 1.15, 1));
      }
      gl.add(mesh(new T.CylinderGeometry(.013, .013, .3, 8), goldF, 0, .27, 1.0).rotateZ(Math.PI / 2)); temples(goldF);
      break;
    }
    case "heart": case "star":
      for (const s of [-1, 1]) {
        const shp = spec.glasses === "heart" ? new T.ShapeGeometry(heartShape(T)) : new T.ShapeGeometry(starShape(T, .25, .12));
        gl.add(mesh(shp, mat(C("glassesColor"), { op: .85, r: .15, m: .3, side: T.DoubleSide }), s * .35, spec.glasses === "heart" ? .03 : .12, 1.0, spec.glasses === "heart" ? 2.2 : 1, spec.glasses === "heart" ? 2.2 : 1, 1));
      }
      gl.add(mesh(new T.CylinderGeometry(.02, .02, .2, 8), glassM, 0, .15, 1.01).rotateZ(Math.PI / 2)); temples();
      break;
    case "monocle":
      gl.add(mesh(new T.TorusGeometry(.2, .022, 10, 32), mat("#d4a017", { r: .25, m: .9 }), .34, .12, .98));
      gl.add(mesh(new T.CircleGeometry(.19, 32), lens("#e0f2fe", .2), .34, .12, .975));
      gl.add(mesh(new T.CylinderGeometry(.008, .008, .8, 6), mat("#d4a017", { r: .25, m: .9 }), .5, -.35, .88).rotateZ(.25));
      break;
    case "ski":
      gl.add(mesh(new T.CylinderGeometry(1.1, 1.1, .4, 48, 1, true, -Math.PI * .3, Math.PI * .6), mat(mix(C("glassesColor"), "#ff8a00", .4), { op: .75, r: .05, m: .8, side: T.DoubleSide }), 0, .14, 0, .97, 1, .99));
      gl.add(mesh(new T.TorusGeometry(1.0, .08, 8, 48), glassM, 0, .14, 0, .97, 1, .99).rotateX(Math.PI / 2));
      break;
    case "vr":
      gl.add(onHead(mesh(new T.BoxGeometry(1.15, .46, .38), mat(C("glassesColor"), { r: .3, m: .3 })), 0, .13, .12));
      gl.add(onHead(mesh(new T.BoxGeometry(1.0, .3, .02), mat("#0b0b12", { r: .05, m: .8, e: "#22d3ee", ei: .25 })), 0, .13, .32));
      gl.add(mesh(new T.TorusGeometry(.98, .06, 8, 48), dark, 0, .14, -.02, .98, 1, .97).rotateX(Math.PI / 2));
      break;
    case "eyepatch":
      gl.add(onHead(mesh(new T.CircleGeometry(.17, 24), dark, 0, 0, 0, 1, .9, 1), -.34, .12, .05));
      { const st = mesh(new T.TorusGeometry(1.0, .02, 6, 48), dark, 0, .2, 0, .97, 1, .95); st.rotation.set(Math.PI / 2, -.35, 0); gl.add(st); }
      break;
    default: break;
  }
  hs.add(gl);

  // ---------- уши: серьги и наушники
  switch (spec.earwear) {
    case "studs": for (const s of [-1, 1]) hs.add(mesh(sphere(.04, 12), jewel, s * .99, -.2, .05)); break;
    case "hoops": for (const s of [-1, 1]) hs.add(mesh(new T.TorusGeometry(.11, .018, 8, 24), jewel, s * 1.0, -.33, .02).rotateY(Math.PI / 2)); break;
    case "drops": for (const s of [-1, 1]) { hs.add(mesh(new T.CylinderGeometry(.008, .008, .16, 6), jewel, s * .99, -.3, .04)); hs.add(mesh(new T.OctahedronGeometry(.06), mat(C("hatColor"), { r: .1, m: .4 }), s * .99, -.42, .04, 1, 1.4, 1)); } break;
    case "earbuds": for (const s of [-1, 1]) { hs.add(mesh(sphere(.07, 12), white, s * 1.0, -.08, .04)); hs.add(mesh(new T.CylinderGeometry(.02, .02, .22, 8), white, s * 1.0, -.22, .04)); } break;
    case "headphones": {
      const hm = mat(C("jewelColor"), { r: .4, m: .2 });
      const tall = ["curly", "bun", "afro", "spacebuns", "topknot", "quiff", "mohawk", "spiky"].includes(spec.hair);
      hs.add(mesh(new T.TorusGeometry(tall ? 1.32 : 1.17, .075, 12, 48, Math.PI), hm, 0, .05, 0));
      for (const s of [-1, 1]) {
        hs.add(mesh(new T.CylinderGeometry(.32, .32, .24, 32), hm, s * 1.12, -.05, 0).rotateZ(Math.PI / 2));
        hs.add(mesh(new T.TorusGeometry(.24, .07, 12, 32), dark, s * .99, -.05, 0).rotateY(Math.PI / 2));
      }
      break;
    }
    default: break;
  }

  head.position.y = .15;
  g.add(torso, head);

  // ---------- питомец и эффекты
  const pet = buildPet(T, spec.pet, C("petColor"), { mat, mesh, sphere, caps, dark, white });
  if (pet) { pet.position.set(1.32, .55, .55); g.add(pet); }
  const fx = buildFx(T, spec.fx, { mat, mesh, sphere });
  if (fx) g.add(fx.group);

  g.userData = { head, lids: face.lids, mouth: face.mouth, emotion: spec.emotion || "neutral", pet, fx, idle: spec.idle, spec };
  g.userData.setEmotion = (em) => {
    hs.remove(face.group);
    face.group.traverse((o) => { o.geometry?.dispose?.(); });
    face = buildFace(T, spec, em, faceCtx);
    hs.add(face.group);
    Object.assign(g.userData, { lids: face.lids, mouth: face.mouth, emotion: em });
  };
  return g;
}

// ---------------------------------------------------------------- формы
function heartShape(T) {
  const sh = new T.Shape();
  sh.moveTo(0, -.09);
  sh.bezierCurveTo(-.02, -.06, -.13, -.02, -.12, .05);
  sh.bezierCurveTo(-.11, .11, -.03, .12, 0, .06);
  sh.bezierCurveTo(.03, .12, .11, .11, .12, .05);
  sh.bezierCurveTo(.13, -.02, .02, -.06, 0, -.09);
  return sh;
}
function heartGeo(T) {
  return new T.ExtrudeGeometry(heartShape(T), { depth: .05, bevelEnabled: true, bevelThickness: .015, bevelSize: .012, bevelSegments: 2 });
}
function starShape(T, R, r) {
  const sh = new T.Shape();
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; i ? sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  sh.closePath();
  return sh;
}

function buildPet(T, kind, color, { mat, mesh, sphere, caps, dark, white }) {
  if (!kind || kind === "none") return null;
  const g = new T.Group();
  const m = mat(color, { r: .5 });
  const eyes = (y, z, gap = .09, r = .04) => { for (const s of [-1, 1]) { g.add(mesh(sphere(r, 12), dark, s * gap, y, z)); g.add(mesh(sphere(r * .35, 8), white, s * gap + .012, y + .015, z + r * .8)); } };
  switch (kind) {
    case "cat":
      g.add(mesh(sphere(.3), m, 0, 0, 0, 1.05, .92, .95));
      for (const s of [-1, 1]) { const e = mesh(new T.ConeGeometry(.11, .2, 4), m, s * .17, .26, 0); e.rotation.z = -s * .35; g.add(e); }
      eyes(.03, .26); g.add(mesh(sphere(.03, 8), mat("#ff7aa2"), 0, -.05, .29));
      for (const s of [-1, 1]) for (const d of [-.03, .03]) { const w = mesh(new T.CylinderGeometry(.004, .004, .2, 4), dark, s * .2, -.06 + d, .24); w.rotation.z = Math.PI / 2 + s * d * 3; g.add(w); }
      break;
    case "ghost":
      g.add(mesh(sphere(.3), mat(color, { op: .88, r: .4 }), 0, .05, 0, 1, 1.05, 1));
      g.add(mesh(new T.CylinderGeometry(.3, .32, .3, 24, 1, true), mat(color, { op: .88, r: .4, side: T.DoubleSide }), 0, -.12, 0));
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.add(mesh(sphere(.08, 10), mat(color, { op: .88 }), Math.cos(a) * .25, -.28, Math.sin(a) * .25)); }
      eyes(.08, .27, .1, .05); g.add(mesh(sphere(.04, 10), dark, 0, -.04, .29, 1, 1.3, .5));
      break;
    case "star": g.add(mesh(new T.ExtrudeGeometry(starShape(T, .34, .16), { depth: .12, bevelEnabled: true, bevelSize: .03, bevelThickness: .03, bevelSegments: 2 }), mat(color, { r: .3, m: .3, e: color, ei: .35 }), 0, 0, -.06)); eyes(.02, .12, .08, .035); break;
    case "planet": g.add(mesh(sphere(.26), mat(color, { r: .5 }))); g.add(mesh(new T.TorusGeometry(.42, .03, 8, 48), mat("#fef3c7", { r: .4 }), 0, 0, 0, 1, 1, .35).rotateX(1.2).rotateY(.4)); eyes(.04, .24, .08, .035); break;
    case "heart": g.add(mesh(heartGeo(T), mat(color, { r: .3, e: color, ei: .25 }), 0, 0, -.1, 3, 3, 3)); eyes(.08, .1, .1, .04); break;
    case "slime": g.add(mesh(sphere(.32), mat(color, { op: .82, r: .1, m: .1 }), 0, -.05, 0, 1.1, .78, 1)); eyes(.05, .28, .1, .05); break;
    case "robot":
      g.add(mesh(new T.BoxGeometry(.48, .34, .36), mat(color, { r: .3, m: .6 })));
      g.add(mesh(new T.BoxGeometry(.38, .14, .02), mat("#0b0b12", { e: "#22d3ee", ei: .2 }), 0, .02, .19));
      for (const s of [-1, 1]) g.add(mesh(sphere(.035, 8), mat("#67e8f9", { e: "#22d3ee", ei: 1.5 }), s * .09, .02, .205));
      g.add(mesh(new T.CylinderGeometry(.015, .015, .16, 6), dark, 0, .25, 0));
      g.add(mesh(new T.BoxGeometry(.5, .015, .06), mat("#cbd5e1", { m: .6 }), 0, .33, 0));
      break;
    case "bird":
      g.add(mesh(sphere(.27), m, 0, 0, 0, 1, 1, 1));
      { const b = mesh(new T.ConeGeometry(.06, .16, 12), mat("#f59e0b"), 0, -.03, .3); b.rotation.x = Math.PI / 2; g.add(b); }
      for (const s of [-1, 1]) g.add(mesh(sphere(.13, 12), m, s * .26, -.02, -.02, .45, .9, 1).rotateZ(s * .5));
      eyes(.07, .23, .09, .035); g.add(mesh(caps(.03, .06, 6), m, 0, .3, 0));
      break;
    default: return null;
  }
  return g;
}

function buildFx(T, kind, { mat, mesh, sphere }) {
  if (!kind || kind === "none") return null;
  const group = new T.Group();
  const items = [];
  const R = rng(5);
  const N = kind === "snow" ? 26 : 16;
  for (let i = 0; i < N; i++) {
    let m;
    switch (kind) {
      case "sparkles": m = mesh(new T.OctahedronGeometry(.06), mat(i % 2 ? "#fff6c2" : "#ffffff", { e: "#ffe066", ei: 1.2 }), 0, 0, 0, .7, 1.4, .7); break;
      case "hearts": m = mesh(heartGeo(T), mat(i % 2 ? "#ff4d8d" : "#ff8fb8", { r: .3, e: "#ff2d6f", ei: .3 }), 0, 0, 0, 1, 1, 1); break;
      case "stars": m = mesh(new T.ExtrudeGeometry(starShape(T, .09, .04), { depth: .03, bevelEnabled: false }), mat("#ffd84d", { e: "#ffb800", ei: .6 })); break;
      case "bubbles": m = mesh(sphere(.06 + R() * .07, 16), mat("#cfefff", { op: .35, r: .02, m: .3, dw: false })); break;
      case "snow": m = mesh(sphere(.035 + R() * .03, 8), mat("#ffffff", { r: .9 })); break;
      case "notes": { m = new T.Group(); const nm = mat(i % 2 ? "#ffffff" : "#c4b5fd", { e: "#a78bfa", ei: .3 }); m.add(mesh(sphere(.05, 10), nm, 0, 0, 0, 1.2, .9, .6)); m.add(mesh(new T.CylinderGeometry(.01, .01, .18, 6), nm, .05, .09, 0)); break; }
      case "petals": m = mesh(sphere(.07, 12), mat(i % 2 ? "#ffc0d9" : "#ff9cc2", { r: .6, side: T.DoubleSide }), 0, 0, 0, 1, .25, .6); break;
      case "fire": m = mesh(new T.ConeGeometry(.05, .16, 10), mat(i % 2 ? "#ff8a00" : "#ffd000", { e: "#ff5a00", ei: 1.2 })); break;
      default: return null;
    }
    group.add(m);
    items.push({ m, a: R() * Math.PI * 2, r: 1.65 + R() * .45, y: -1.6 + R() * 3, sp: (.25 + R() * .35) * (R() < .5 ? -1 : 1), ph: R() * 6 });
  }
  const update = (t) => {
    for (const it of items) {
      const a = it.a + t * it.sp;
      let y = it.y;
      if (kind === "snow" || kind === "petals") y = 1.9 - ((t * .35 + it.ph) % 3.8);
      if (kind === "bubbles" || kind === "fire" || kind === "notes") y = -1.8 + ((t * .4 + it.ph) % 3.8);
      it.m.position.set(Math.cos(a) * it.r, y + Math.sin(t * 2 + it.ph) * .05, Math.sin(a) * it.r * .7);
      it.m.rotation.y = t + it.ph; if (kind === "petals" || kind === "snow") it.m.rotation.x = t * .8 + it.ph;
    }
  };
  update(0);
  return { group, update };
}

// ---------------------------------------------------------------- лицо и эмоции
function buildFace(T, spec, emotion, { skin, hairM, dark, white, mat, mesh, sphere, caps, C }) {
  const e = EMO[emotion] || null;
  let eyesMode = e ? e.eyes : spec.eyes;
  if (e && e.eyes === "round" && OPEN_EYES.has(spec.eyes)) eyesMode = spec.eyes;
  const mouthMode = e ? e.mouth : spec.mouth;
  const group = new T.Group();
  const lids = [];
  const irisM = (k) => mat(C(k), spec.eyeGlow ? { r: .2, e: C(k), ei: 1.1 } : { r: .25 });
  const hidden = new Set(["shades", "vr"].includes(spec.glasses) ? [-1, 1] : spec.glasses === "eyepatch" ? [-1] : []);
  // глаза
  for (const side of [-1, 1]) {
    if (hidden.has(side)) continue;
    const eg = new T.Group();
    eg.position.set(side * .34, .12, .8);
    const iris = irisM(spec.heterochromia && side === 1 ? "eyeColor2" : "eyeColor");
    const closed = eyesMode === "happy" || (eyesMode === "wink" && side === 1);
    if (spec.eyeshadow && eyesMode !== "heart") group.add(mesh(sphere(.2, 24), mat(C("shadowColor"), { op: .7, r: .8 }), side * .34, .17, .77, 1.15, .85, .42));
    if (closed) {
      eg.add(mesh(new T.TorusGeometry(.13, .035, 10, 24, Math.PI), dark, 0, -.02, .1));
    } else if (eyesMode === "heart") {
      eg.add(mesh(heartGeo(T), mat("#ff2d55", { r: .3, e: 0x550011, ei: .4 }), 0, 0, .07, 1.25, 1.25, 1));
      lids.push(eg);
    } else if (eyesMode === "small") {
      eg.add(mesh(sphere(.075), dark, 0, 0, .06, 1, 1.15, .5));
      eg.add(mesh(sphere(.022), white, .025, .03, .1));
      lids.push(eg);
    } else {
      const shape = { almond: [1.1, .78], big: [1.2, 1.25], anime: [1.15, 1.42] }[eyesMode] || [1, 1];
      const k = eyesMode === "wide" ? 1.22 : eyesMode === "narrow" ? .85 : 1;
      const [kx, ky] = [shape[0] * k, shape[1] * k];
      if (eyesMode === "almond") eg.rotation.z = side * .14;
      eg.add(mesh(sphere(.17), white, 0, 0, 0, kx, 1.1 * ky, .55));
      const ik = eyesMode === "anime" ? 1.3 : eyesMode === "big" ? 1.15 : 1;
      eg.add(mesh(sphere(.105), iris, 0, -.01 - (eyesMode === "anime" ? .02 : 0), .08, kx * ik * .95, 1.05 * ky * ik * .9, .5));
      eg.add(mesh(sphere(.055), dark, 0, -.01, .125, eyesMode === "wide" ? .8 : ik, (eyesMode === "wide" ? .8 : ik) * (eyesMode === "anime" ? 1.2 : 1), .4));
      eg.add(mesh(sphere(.025), white, .04 * kx, .045 * ky, .15));
      if (eyesMode === "anime" || eyesMode === "big") eg.add(mesh(sphere(.014), white, -.035 * kx, -.05 * ky, .15));
      if (eyesMode === "sleepy" || eyesMode === "half" || eyesMode === "narrow") {
        const lid = mesh(new T.SphereGeometry(.185 * k, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), skin, 0, eyesMode === "narrow" ? -.05 : -.02, .02, 1, eyesMode === "half" ? .55 : .75, .62);
        if (eyesMode === "narrow") lid.rotation.z = side * -.35;
        eg.add(lid);
      }
      if (spec.lashes !== "none") {
        const L = spec.lashes === "long" ? .1 : .06;
        for (const a of [.45, .85, 1.2]) {
          const x = side * Math.cos(a) * .17 * kx, y = Math.sin(a) * .187 * ky;
          const l = mesh(caps(.011, L, 4), dark, x + side * Math.cos(a) * L * .45, y + Math.sin(a) * L * .45, .05);
          l.rotation.z = Math.atan2(Math.sin(a), side * Math.cos(a)) - Math.PI / 2; eg.add(l);
        }
      }
      lids.push(eg);
    }
    group.add(eg);
  }
  // брови: высота и наклон для каждой стороны (эмоции двигают их)
  if (spec.brows !== "none") {
    const t = { bold: .055, thin: .02 }[spec.brows] || .032;
    const baseTilt = { arched: .32, angry: -.3 }[spec.brows] ?? .12;
    const baseLift = spec.brows === "arched" ? .03 : 0;
    if (spec.brows === "unibrow") {
      const lift = e ? (e.brows[0] + e.brows[1]) / 2 : 0;
      const b = mesh(caps(.05, .62, 12), hairM, 0, .4 + lift, .88); b.rotation.z = Math.PI / 2; group.add(b);
    } else [-1, 1].forEach((side, i) => {
      const lift = (e ? e.brows[i] : 0) + baseLift;
      const tilt = e ? e.tilt[i] + (spec.brows === "angry" ? -.2 : spec.brows === "arched" ? .1 : 0) : baseTilt;
      const b = mesh(caps(t, .2, 12), hairM, side * .34, .4 + lift, .86);
      b.rotation.z = Math.PI / 2 + side * tilt;
      group.add(b);
    });
  }
  // рот
  const lipM = spec.lipstick ? mat(C("lipColor"), { r: .3, m: .05 }) : dark;
  const lt = spec.lipstick ? .05 : .035;
  const mouth = new T.Group();
  mouth.position.set(0, -.38, .9);
  if (mouthMode === "smile" || mouthMode === "fangs") {
    mouth.add(mesh(new T.TorusGeometry(.2, lt, 12, 32, Math.PI), lipM, 0, .08, 0).rotateZ(Math.PI));
    if (mouthMode === "fangs") for (const s of [-1, 1]) mouth.add(mesh(new T.ConeGeometry(.03, .09, 8), white, s * .1, -.08, .03).rotateZ(Math.PI));
  } else if (mouthMode === "frown") mouth.add(mesh(new T.TorusGeometry(.17, lt, 12, 32, Math.PI), lipM, 0, -.1, 0));
  else if (mouthMode === "smirk") {
    const a = mesh(new T.TorusGeometry(.17, lt, 12, 32, Math.PI * .62), lipM, .06, .06, 0);
    a.rotation.z = Math.PI * 1.22;
    mouth.add(a);
  } else if (mouthMode === "kiss") {
    mouth.add(mesh(new T.TorusGeometry(.06, .035, 10, 24), spec.lipstick ? lipM : mat("#e8607a", { r: .4 }), 0, 0, .02, 1, 1.2, 1));
  } else if (["grin", "tongue", "open", "laugh", "buck"].includes(mouthMode)) {
    const shape = mouthMode === "open" ? mesh(sphere(.14), dark, 0, 0, 0, .9, 1.1, .4)
      : mesh(new T.SphereGeometry(mouthMode === "laugh" ? .3 : .24, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), dark, 0, .06, 0, 1, mouthMode === "laugh" ? 1.15 : .8, .4);
    mouth.add(shape);
    if (mouthMode === "grin" || mouthMode === "laugh") mouth.add(mesh(new T.BoxGeometry(mouthMode === "laugh" ? .38 : .3, .07, .05), white, 0, .02, .07));
    if (mouthMode === "buck") for (const s of [-1, 1]) mouth.add(mesh(new T.BoxGeometry(.07, .1, .04), white, s * .04, -.01, .08));
    if (mouthMode === "tongue" || mouthMode === "laugh") mouth.add(mesh(sphere(.09), mat("#ff5a7a", { r: .4 }), .03, mouthMode === "laugh" ? -.16 : -.12, .06, 1, .8, .6));
    if (spec.lipstick) mouth.add(mesh(new T.TorusGeometry(mouthMode === "laugh" ? .29 : .23, .025, 8, 32, Math.PI), lipM, 0, .06, .02).rotateZ(Math.PI));
  } else mouth.add(mesh(caps(spec.lipstick ? .04 : .025, .18, 12), lipM, 0, 0, 0).rotateZ(Math.PI / 2));
  group.add(mouth);
  if (e?.tear) group.add(mesh(sphere(.06), mat("#7dd3fc", { r: .1, op: .85 }), -.42, -.12, .9, .8, 1.25, .6));
  if (e?.blush) for (const side of [-1, 1]) {
    const c = mesh(new T.CircleGeometry(.16, 24), mat("#ff4d6d", { op: .45, r: 1 }), side * .55, -.2, .84);
    c.lookAt(side * 1.6, -.5, 3); group.add(c);
  }
  return { group, lids, mouth };
}

// ---------------------------------------------------------------- сцена
/**
 * Вставляет живой 3D-аватар в container (он должен иметь размер).
 * Возвращает { update(spec), emote(name), snapshot(size) → Promise<Blob>, destroy() }.
 */
export async function mount3D(container, spec, { interactive = true, snapshotable = false, zoom = 1, tapEmote = false } = {}) {
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
  const camera = new T.PerspectiveCamera(28, 1, .1, 60);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a7dbd, 1.6));
  const key = new T.DirectionalLight(0xffffff, 2.1); key.position.set(2.5, 3, 4); scene.add(key);
  const rim = new T.DirectionalLight(0xb9a8ff, 1.6); rim.position.set(-3, 2, -3); scene.add(rim);
  const fill = new T.DirectionalLight(0xffe2cc, .6); fill.position.set(-2, -1, 3); scene.add(fill);

  let cur = normalizeSpec(spec);
  let char = build(T, cur);
  scene.add(char);
  // кадр подстраивается под высокие шляпы и уши, чтобы их не обрезало
  const fit = () => {
    const tan = Math.tan(T.MathUtils.degToRad(14));
    const d0 = 8.6 / zoom, bottom = -.12 - d0 * tan, top0 = -.12 + d0 * tan;
    char.updateMatrixWorld(true);
    const top = new T.Box3().setFromObject(char.userData.head).max.y + .3;
    if (top <= top0) { camera.position.set(0, .05, d0); camera.lookAt(0, -.12, 0); return; }
    const cy = (top + bottom) / 2, d = (top - bottom) / 2 / tan;
    camera.position.set(0, cy, d); camera.lookAt(0, cy, 0);
  };
  fit();

  const resize = () => {
    const w = container.clientWidth || 120, hh = container.clientHeight || w;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(container);

  // жизнь: дыхание, моргание, взгляд за курсором, вращение пальцем, эмоции от касания
  const reduced = () => document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  let look = { x: 0, y: 0 }, spin = 0, spinV = 0, drag = null, jump = 0, nextBlink = performance.now() + 2500, blinkT = -1;
  const onMove = (e) => {
    const r = container.getBoundingClientRect();
    look.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
    look.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
  };
  // на телефоне курсора нет — персонаж следит за наклоном устройства
  let lastPointer = 0;
  const onTilt = (e) => {
    if (performance.now() - lastPointer < 1500 || e.gamma == null) return;
    look.x = Math.max(-1, Math.min(1, e.gamma / 30));
    look.y = Math.max(-1, Math.min(1, (e.beta - 50) / 35));
  };
  const onPtr = (e) => { if (e.pointerType === "mouse") lastPointer = performance.now(); onMove(e); };
  let emoteTimer = 0;
  const emote = (name, ms = 1800) => {
    const { setEmotion } = char.userData;
    if (!setEmotion) return;
    clearTimeout(emoteTimer);
    setEmotion(name);
    jump = .7;
    emoteTimer = setTimeout(() => { char.userData.setEmotion?.(cur.emotion || "neutral"); }, ms);
  };
  if (interactive) {
    window.addEventListener("pointermove", onPtr, { passive: true });
    if (matchMedia("(pointer: coarse)").matches) window.addEventListener("deviceorientation", onTilt, { passive: true });
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, s: spin, t: performance.now(), moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; spin = drag.s + dx * .012; });
    canvas.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) {
        e.stopPropagation();
        if (tapEmote) {
          const pool = EMOTION_KEYS.filter((k) => k !== "neutral" && k !== (char.userData.emotion || "neutral"));
          emote(pool[Math.floor(Math.random() * pool.length)]);
        } else jump = 1;
      }
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
    const { head, lids, mouth, pet, fx, idle } = char.userData;
    const still = reduced();
    if (!drag) { spinV += (-spin) * .06; spinV *= .82; spin += spinV; }
    char.rotation.set(0, spin + (still ? 0 : Math.sin(t * .6) * .06), 0);
    head.rotation.y = still ? 0 : look.x * .45;
    head.rotation.x = still ? 0 : look.y * .25 + Math.sin(t * 1.3) * .02;
    head.rotation.z = still ? 0 : Math.sin(t * .8) * .03;
    char.position.y = still ? 0 : Math.sin(t * 2) * .025;
    if (!still) switch (idle) {
      case "bouncy": char.position.y = Math.abs(Math.sin(t * 3)) * .14; break;
      case "dance": char.rotation.z = Math.sin(t * 3) * .07; char.position.y = Math.abs(Math.sin(t * 6)) * .06; head.rotation.z += Math.sin(t * 3 + 1) * .1; break;
      case "float": char.position.y = Math.sin(t * 1.2) * .14; char.rotation.z = Math.sin(t * .9) * .04; break;
      case "sway": char.rotation.z = Math.sin(t * 1.4) * .06; break;
      case "vibe": head.rotation.x += Math.max(0, Math.sin(t * 7)) * .08; break;
      default: break;
    }
    if (pet) { pet.position.y = .55 + (still ? 0 : Math.sin(t * 2.2) * .09); pet.rotation.y = still ? -.3 : -.3 + Math.sin(t * 1.1) * .35; }
    if (fx && !still) fx.update(t);
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

  const disposeChar = () => char.traverse((o) => { o.geometry?.dispose?.(); if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); } });
  return {
    emote,
    update(next) {
      cur = normalizeSpec(next);
      scene.remove(char);
      disposeChar();
      char = build(T, cur);
      scene.add(char);
      fit(); resize();
      jump = .6;
      if (!raf && visible) raf = requestAnimationFrame(frame);
    },
    /** Снимок для ленты и чатов: квадрат с фоном */
    async snapshot(size = 512) {
      const ud = char.userData;
      const keep = { y: char.rotation.y, z: char.rotation.z, hy: ud.head.rotation.y, hx: ud.head.rotation.x, hz: ud.head.rotation.z, py: char.position.y };
      char.rotation.set(0, 0, 0); ud.head.rotation.set(0, 0, 0); char.position.y = 0; char.scale.set(1, 1, 1);
      ud.lids.forEach((e) => { e.scale.y = 1; });
      const w0 = canvas.width, h0 = canvas.height;
      renderer.setPixelRatio(1); renderer.setSize(size, size, false);
      camera.aspect = 1; camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const out = document.createElement("canvas"); out.width = out.height = size;
      const cx = out.getContext("2d");
      drawBg(cx, size, cur);
      cx.drawImage(canvas, 0, 0, size, size);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.setSize(w0 / Math.min(devicePixelRatio || 1, 2), h0 / Math.min(devicePixelRatio || 1, 2), false);
      resize();
      char.rotation.set(0, keep.y, keep.z); ud.head.rotation.set(keep.hx, keep.hy, keep.hz); char.position.y = keep.py;
      return new Promise((res) => out.toBlob(res, "image/png"));
    },
    /**
     * Стикеры: голова и плечи на прозрачном фоне, по одному на эмоцию, с лёгким наклоном головы.
     * Возвращает [[эмоция, Blob PNG], …].
     */
    async stickers(size = 512, list = EMOTION_KEYS) {
      const POSE = { neutral: [0, 0, 0], happy: [-.06, .1, .08], smirk: [.02, -.18, -.1], cool: [-.08, .22, .06], surprised: [-.12, 0, 0],
        love: [.04, .12, .14], laugh: [-.16, -.08, -.1], wink: [0, .2, .12], angry: [.12, -.1, 0], sad: [.16, .1, -.12], sleepy: [.12, .15, .2] };
      const cam = camera.clone();
      const out = [];
      const w0 = canvas.width, h0 = canvas.height;
      cancelAnimationFrame(raf); raf = 0;
      clearTimeout(emoteTimer);
      renderer.setPixelRatio(1); renderer.setSize(size, size, false);
      const copy = document.createElement("canvas"); copy.width = copy.height = size;
      const cx = copy.getContext("2d");
      const silC = document.createElement("canvas"); silC.width = silC.height = size;
      const sil = silC.getContext("2d");
      try {
        for (const em of list) {
          char.userData.setEmotion(em);
          const ud = char.userData;
          if (ud.fx) ud.fx.group.visible = false;
          if (ud.pet) ud.pet.visible = false;
          char.rotation.set(0, 0, 0); char.position.set(0, 0, 0); char.scale.set(1, 1, 1);
          ud.head.rotation.set(0, 0, 0); ud.lids.forEach((e) => { e.scale.y = 1; }); ud.mouth.scale.set(1, 1, 1);
          char.updateMatrixWorld(true);
          // кадр: вся голова со шляпой и верх плеч
          const box = new T.Box3().setFromObject(ud.head);
          const top = box.max.y + .12, bottom = -1.55;
          const half = Math.max((top - bottom) / 2, (box.max.x - box.min.x) / 2 + .1);
          const cy = (top + bottom) / 2;
          cam.aspect = 1; cam.position.set(0, cy, half / Math.tan(T.MathUtils.degToRad(14)) + 1.2); cam.lookAt(0, cy, 0); cam.updateProjectionMatrix();
          const [px, py, pz] = POSE[em] || POSE.neutral;
          ud.head.rotation.set(px, py, pz);
          renderer.render(scene, cam);
          // как настоящий стикер: белая обводка по силуэту и мягко растворяющийся низ
          cx.clearRect(0, 0, size, size);
          sil.clearRect(0, 0, size, size); sil.globalCompositeOperation = "source-over";
          sil.drawImage(canvas, 0, 0, size, size);
          sil.globalCompositeOperation = "source-in"; sil.fillStyle = "#ffffff"; sil.fillRect(0, 0, size, size);
          const r = Math.max(2, Math.round(size / 85));
          for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; cx.drawImage(silC, Math.cos(a) * r, Math.sin(a) * r); }
          cx.drawImage(canvas, 0, 0, size, size);
          cx.globalCompositeOperation = "destination-in";
          const fade = cx.createLinearGradient(0, size * .78, 0, size);
          fade.addColorStop(0, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
          cx.fillStyle = fade; cx.fillRect(0, 0, size, size);
          cx.globalCompositeOperation = "source-over";
          out.push([em, await new Promise((res) => copy.toBlob(res, "image/png"))]);
        }
      } finally {
        char.userData.setEmotion(cur.emotion || "neutral");
        if (char.userData.fx) char.userData.fx.group.visible = true;
        if (char.userData.pet) char.userData.pet.visible = true;
        char.userData.head.rotation.set(0, 0, 0);
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        renderer.setSize(w0 / Math.min(devicePixelRatio || 1, 2), h0 / Math.min(devicePixelRatio || 1, 2), false);
        resize();
        if (visible) raf = requestAnimationFrame(frame);
      }
      return out;
    },
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPtr);
      window.removeEventListener("deviceorientation", onTilt);
      clearTimeout(emoteTimer);
      disposeChar();
      renderer.dispose(); canvas.remove();
    },
  };
}
