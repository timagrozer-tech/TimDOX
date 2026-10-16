/**
 * Процедурные значки поселений. Внешний вид зависит от размера и эпохи: шатры и костёр → деревня → посёлок
 * с частоколом → каменный город с башнями → большой город с храмом → мегаполис (в промышленную эпоху — трубы).
 * Рисуются один раз в маленькие холсты (атлас) и потом только копируются.
 */
type Ctx = CanvasRenderingContext2D;
const cache = new Map<string, HTMLCanvasElement>();

export function settlementSprite(tier: number, era: number, walls: number, px: number): HTMLCanvasElement {
  const style = era <= 1 ? 0 : era <= 4 ? 1 : 2;
  const size = Math.max(8, Math.min(96, Math.round(px)));
  const key = `${tier}:${style}:${walls > 0 ? 1 : 0}:${size}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.scale(size / 64, size / 64);
  drawSettlement(g, tier, style, walls > 0);
  cache.set(key, c);
  return c;
}

const ROOF = ["#8a5a32", "#b0533a", "#4f6278"], WALL = ["#c9b28a", "#e3d9c4", "#d7d9dc"], STONE = ["#9c8a6a", "#a8a39a", "#8e949b"];

function house(g: Ctx, x: number, y: number, w: number, h: number, style: number): void {
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x + 2, y + 2, w, h);
  g.fillStyle = WALL[style]!; g.fillRect(x, y, w, h);
  g.fillStyle = ROOF[style]!;
  g.beginPath(); g.moveTo(x - 2, y + 1); g.lineTo(x + w / 2, y - h * 0.75); g.lineTo(x + w + 2, y + 1); g.closePath(); g.fill();
  g.fillStyle = "rgba(60,40,20,0.7)"; g.fillRect(x + w * 0.4, y + h * 0.45, w * 0.22, h * 0.55);
}
function tower(g: Ctx, x: number, y: number, w: number, h: number, style: number): void {
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x + 2, y + 2, w, h);
  g.fillStyle = STONE[style]!; g.fillRect(x, y, w, h);
  g.fillStyle = ROOF[style]!; g.beginPath(); g.moveTo(x - 1, y); g.lineTo(x + w / 2, y - w * 1.1); g.lineTo(x + w + 1, y); g.closePath(); g.fill();
  g.fillStyle = "rgba(40,30,20,0.6)"; g.fillRect(x + w * 0.35, y + h * 0.25, w * 0.3, h * 0.2);
}
function wallRing(g: Ctx, style: number, r: number): void {
  g.strokeStyle = STONE[style]!; g.lineWidth = 4;
  g.beginPath(); g.ellipse(32, 40, r, r * 0.62, 0, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = "rgba(0,0,0,0.25)"; g.lineWidth = 1.5;
  g.beginPath(); g.ellipse(32, 42, r, r * 0.62, 0, 0, Math.PI); g.stroke();
}

function drawSettlement(g: Ctx, tier: number, style: number, walls: boolean): void {
  // тень-основание
  g.fillStyle = "rgba(30,25,15,0.25)"; g.beginPath(); g.ellipse(32, 44, 10 + tier * 4.5, 5 + tier * 2.2, 0, 0, Math.PI * 2); g.fill();
  if (tier === 0) {
    // шатры у костра
    for (const [x, y] of [[20, 40], [38, 36]] as const) {
      g.fillStyle = style === 0 ? "#9b7650" : "#b88b5a";
      g.beginPath(); g.moveTo(x - 9, y + 6); g.lineTo(x, y - 10); g.lineTo(x + 9, y + 6); g.closePath(); g.fill();
      g.fillStyle = "rgba(0,0,0,0.3)"; g.beginPath(); g.moveTo(x, y - 10); g.lineTo(x + 9, y + 6); g.lineTo(x + 2, y + 6); g.closePath(); g.fill();
    }
    g.fillStyle = "#ffb43a"; g.beginPath(); g.arc(32, 46, 3.5, 0, Math.PI * 2); g.fill();
    return;
  }
  if (walls && tier >= 2) wallRing(g, style, 12 + tier * 4);
  const spots: [number, number, number][] = [];
  const n = [0, 3, 5, 7, 10, 13][tier]!;
  for (let i = 0; i < n; i++) {
    const a = i * 2.4, rr = 4 + (i / n) * (6 + tier * 3.2);
    spots.push([32 + Math.cos(a) * rr * 1.5, 40 + Math.sin(a) * rr * 0.75, i]);
  }
  spots.sort((a, b) => a[1] - b[1]);
  for (const [x, y, i] of spots) {
    const s = 7 + (i % 3) * 1.5 + (tier >= 3 ? 1 : 0);
    house(g, x - s / 2, y - s / 2, s, s * 0.75, style);
  }
  if (tier >= 3) tower(g, 18, 18, 7, 18, style);
  if (tier >= 3) tower(g, 41, 16, 7, 20, style);
  if (tier >= 4) {
    // храм / собор с куполом
    g.fillStyle = WALL[style]!; g.fillRect(26, 14, 12, 14);
    g.fillStyle = style === 2 ? "#6b8fa8" : "#c8a450"; g.beginPath(); g.arc(32, 14, 6, Math.PI, 0); g.fill();
  }
  if (tier >= 5 && style === 2) {
    g.fillStyle = "#5a5f66"; g.fillRect(48, 10, 4, 18); g.fillRect(12, 14, 4, 14);
    g.fillStyle = "rgba(200,200,200,0.5)"; g.beginPath(); g.arc(50, 6, 4, 0, Math.PI * 2); g.arc(54, 2, 3, 0, Math.PI * 2); g.fill();
  }
}

/** Мягкий огонёк поселения (виден издалека, «загорается» во вступлении) */
let glowC: HTMLCanvasElement | null = null;
export function glowSprite(): HTMLCanvasElement {
  if (glowC) return glowC;
  glowC = document.createElement("canvas"); glowC.width = glowC.height = 64;
  const g = glowC.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,236,170,1)"); gr.addColorStop(0.18, "rgba(255,190,90,0.85)"); gr.addColorStop(0.5, "rgba(255,140,40,0.25)"); gr.addColorStop(1, "rgba(255,120,30,0)");
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
    for (let i = 0; i < 14; i++) {
      const x = 40 + Math.random() * 176, y = 40 + Math.random() * 48, r = 18 + Math.random() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    cloudC.push(c);
  }
  return cloudC;
}
