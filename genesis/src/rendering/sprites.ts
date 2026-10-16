/**
 * Процедурные значки поселений в спокойном «миниатюрном» стиле: аккуратные домики с объёмными крышами,
 * стены, башни, купола. Вид зависит от размера, эпохи (дерево → камень → поздние эпохи) и номера поселения
 * (4 варианта раскладки), поэтому города не выглядят копиями друг друга. Рисуются один раз в маленькие холсты.
 */
type Ctx = CanvasRenderingContext2D;
const cache = new Map<string, HTMLCanvasElement>();

const PAL = [
  { wall: ["#d9c7a3", "#b9a47e"], roof: ["#8b6440", "#6e4c2f"], stone: "#a39478" },        // дерево, солома
  { wall: ["#efe6d4", "#cfc2a8"], roof: ["#b4573b", "#8c3f2a"], stone: "#b8b0a0" },        // камень, черепица
  { wall: ["#e9e6df", "#c3bfb6"], roof: ["#55667a", "#3e4c5c"], stone: "#9aa0a8" },        // поздние эпохи
];

export function settlementSprite(tier: number, era: number, walls: number, px: number, variant = 0): HTMLCanvasElement {
  const style = era <= 1 ? 0 : era <= 4 ? 1 : 2;
  const size = Math.max(12, Math.min(128, Math.round(px / 4) * 4));
  const key = `${tier}:${style}:${walls > 0 ? 1 : 0}:${variant & 3}:${size}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.scale(size / 64, size / 64);
  draw(g, tier, style, walls > 0, variant & 3);
  if (cache.size > 400) cache.clear();
  cache.set(key, c);
  return c;
}

function house(g: Ctx, x: number, y: number, w: number, style: number, tall = 1): void {
  const p = PAL[style]!, h = w * 0.62 * tall;
  // тень
  g.fillStyle = "rgba(25,18,10,0.28)";
  g.beginPath(); g.ellipse(x + w * 0.6, y + h + 0.6, w * 0.75, w * 0.22, 0, 0, Math.PI * 2); g.fill();
  // фасад и бок
  g.fillStyle = p.wall[0]!; g.fillRect(x, y, w * 0.62, h);
  g.fillStyle = p.wall[1]!; g.fillRect(x + w * 0.62, y, w * 0.38, h);
  // крыша: светлый и тёмный скаты
  g.fillStyle = p.roof[0]!;
  g.beginPath(); g.moveTo(x - w * 0.08, y + 0.3); g.lineTo(x + w * 0.31, y - w * 0.5); g.lineTo(x + w * 0.7, y - w * 0.5); g.lineTo(x + w * 0.66, y + 0.3); g.closePath(); g.fill();
  g.fillStyle = p.roof[1]!;
  g.beginPath(); g.moveTo(x + w * 0.66, y + 0.3); g.lineTo(x + w * 0.7, y - w * 0.5); g.lineTo(x + w * 1.06, y + 0.3); g.closePath(); g.fill();
  // окно
  g.fillStyle = style === 2 ? "rgba(255,226,150,0.9)" : "rgba(60,40,25,0.75)";
  g.fillRect(x + w * 0.22, y + h * 0.35, w * 0.16, h * 0.3);
}
function tower(g: Ctx, x: number, y: number, w: number, h: number, style: number): void {
  const p = PAL[style]!;
  g.fillStyle = "rgba(25,18,10,0.28)"; g.beginPath(); g.ellipse(x + w * 0.7, y + h, w * 0.9, w * 0.3, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = p.stone; g.fillRect(x, y, w, h);
  g.fillStyle = "rgba(0,0,0,0.18)"; g.fillRect(x + w * 0.6, y, w * 0.4, h);
  g.fillStyle = p.roof[1]!; g.beginPath(); g.moveTo(x - 1, y + 0.5); g.lineTo(x + w / 2, y - w * 1.25); g.lineTo(x + w + 1, y + 0.5); g.closePath(); g.fill();
  g.fillStyle = p.roof[0]!; g.beginPath(); g.moveTo(x - 1, y + 0.5); g.lineTo(x + w / 2, y - w * 1.25); g.lineTo(x + w / 2, y + 0.5); g.closePath(); g.fill();
}
function ring(g: Ctx, style: number, rx: number): void {
  const p = PAL[style]!, ry = rx * 0.5;
  g.lineWidth = 3.2; g.strokeStyle = "rgba(20,15,10,0.35)";
  g.beginPath(); g.ellipse(32, 44, rx, ry, 0, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2.4; g.strokeStyle = p.stone;
  g.beginPath(); g.ellipse(32, 43, rx, ry, 0, 0, Math.PI * 2); g.stroke();
}

const LAYOUTS = [
  [[0, 0], [-1, 0.6], [1, 0.5], [-0.4, -0.7], [0.7, -0.6], [-1.6, -0.2], [1.6, 0], [0, 1.2], [-0.9, 1.3], [1, 1.3], [-1.7, 0.9], [1.8, 0.9]],
  [[0.2, 0], [-0.9, 0.3], [1.1, 0.7], [-0.2, -0.8], [0.9, -0.5], [-1.5, -0.5], [1.7, -0.1], [-0.3, 1.1], [-1.3, 1], [0.9, 1.4], [-1.9, 0.4], [2, 0.6]],
  [[-0.1, 0.1], [-1.1, -0.1], [1, 0.2], [0.3, -0.9], [-0.7, -0.8], [1.5, -0.7], [-1.6, 0.6], [0.4, 1.1], [1.5, 1], [-0.6, 1.4], [2, 0.2], [-2, -0.4]],
  [[0, -0.2], [-1, 0.4], [0.9, 0.4], [-0.1, 1], [-0.8, -0.9], [0.8, -0.9], [-1.8, 0], [1.8, -0.1], [-1.2, 1.2], [1.2, 1.2], [0, -1.5], [-2, 0.9]],
] as const;

function draw(g: Ctx, tier: number, style: number, walls: boolean, v: number): void {
  if (tier === 0) {
    // шатры и костёр
    g.fillStyle = "rgba(25,18,10,0.25)"; g.beginPath(); g.ellipse(32, 46, 16, 5, 0, 0, Math.PI * 2); g.fill();
    for (const [x, y, s] of [[22, 42, 1], [40, 39, 0.85]] as const) {
      g.fillStyle = "#b08a5c"; g.beginPath(); g.moveTo(x - 9 * s, y + 5); g.lineTo(x, y - 9 * s); g.lineTo(x + 9 * s, y + 5); g.closePath(); g.fill();
      g.fillStyle = "#86653f"; g.beginPath(); g.moveTo(x, y - 9 * s); g.lineTo(x + 9 * s, y + 5); g.lineTo(x + 1, y + 5); g.closePath(); g.fill();
      g.fillStyle = "#3a2a1a"; g.fillRect(x - 1, y - 1, 2, 6);
    }
    const fire = g.createRadialGradient(31, 47, 0, 31, 47, 7);
    fire.addColorStop(0, "rgba(255,220,130,1)"); fire.addColorStop(0.5, "rgba(255,150,60,0.8)"); fire.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = fire; g.beginPath(); g.arc(31, 47, 7, 0, Math.PI * 2); g.fill();
    return;
  }
  const spread = 4 + tier * 2.4;
  const n = [0, 3, 5, 7, 9, 12][tier]!;
  if (walls && tier >= 2) ring(g, style, spread * 1.85 + 6);
  const pts = LAYOUTS[v]!.slice(0, n).map(([dx, dy], i) => [32 + dx * spread, 40 + dy * spread * 0.55, i] as const).sort((a, b) => a[1] - b[1]);
  // главное здание — в центре, остальные вокруг
  for (const [x, y, i] of pts) {
    if (tier >= 4 && i === 0) continue;
    const w = 8 + (i % 3) * 1.2 + (tier >= 3 ? 1 : 0);
    house(g, x - w / 2, y - w * 0.3, w, style, tier >= 4 && i % 4 === 1 ? 1.5 : 1);
  }
  if (tier >= 3) { tower(g, 32 - spread * 1.7, 28, 6, 15, style); tower(g, 32 + spread * 1.45, 26, 6, 17, style); }
  if (tier >= 4) {
    const p = PAL[style]!;
    // собор / дворец с куполом
    g.fillStyle = "rgba(25,18,10,0.3)"; g.beginPath(); g.ellipse(35, 44, 11, 3.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = p.wall[0]!; g.fillRect(25, 29, 10, 14); g.fillStyle = p.wall[1]!; g.fillRect(35, 29, 5, 14);
    const dome = g.createLinearGradient(26, 20, 38, 28);
    dome.addColorStop(0, style === 2 ? "#9bb8cc" : "#e8c66a"); dome.addColorStop(1, style === 2 ? "#4d6a80" : "#a07a2c");
    g.fillStyle = dome; g.beginPath(); g.arc(32.5, 29, 7.5, Math.PI, 0); g.fill();
    g.fillStyle = "#3a2a1a"; g.fillRect(32, 18, 1, 4);
  }
  if (tier >= 5 && style === 2) {
    g.fillStyle = "#5c6168"; g.fillRect(49, 18, 3.5, 20); g.fillRect(12, 22, 3, 16);
    g.fillStyle = "rgba(210,210,210,0.45)"; g.beginPath(); g.arc(51, 13, 4, 0, Math.PI * 2); g.arc(55, 8, 3.2, 0, Math.PI * 2); g.arc(14, 17, 3, 0, Math.PI * 2); g.fill();
  }
}

/** Мягкий огонёк поселения (виден издалека, «загорается» во вступлении) */
let glowC: HTMLCanvasElement | null = null;
export function glowSprite(): HTMLCanvasElement {
  if (glowC) return glowC;
  glowC = document.createElement("canvas"); glowC.width = glowC.height = 64;
  const g = glowC.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,240,190,1)"); gr.addColorStop(0.14, "rgba(255,200,110,0.9)"); gr.addColorStop(0.45, "rgba(255,150,60,0.22)"); gr.addColorStop(1, "rgba(255,120,30,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return glowC;
}

let cloudC: HTMLCanvasElement[] | null = null;
export function cloudSprites(): HTMLCanvasElement[] {
  if (cloudC) return cloudC;
  cloudC = [];
  for (let k = 0; k < 4; k++) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 128;
    const g = c.getContext("2d")!;
    for (let i = 0; i < 16; i++) {
      const x = 40 + Math.random() * 176, y = 44 + Math.random() * 40, r = 16 + Math.random() * 28;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,0.5)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    cloudC.push(c);
  }
  return cloudC;
}
