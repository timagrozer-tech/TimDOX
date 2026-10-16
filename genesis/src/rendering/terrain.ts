import { BIOMES, Biome, isWater } from "../world/biomes";
import { hash32 } from "../core/rng";
import type { StaticWorld } from "../workers/protocol";

/**
 * Неизменяемая подложка карты рисуется один раз в отдельный холст: плавные цвета (интерпол. между клетками),
 * органичная береговая линия по высоте, рельефная светотень с северо-запада, реки и «2.5D»-значки — горы,
 * холмы, леса, тайга, дюны, болота. Потом каждый кадр — одна быстрая операция drawImage.
 */
export interface TerrainLayers { base: HTMLCanvasElement | OffscreenCanvas; snow: HTMLCanvasElement | OffscreenCanvas; k: number }

const mkCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
};
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function cellScale(w: number): number { return w <= 180 ? 7 : w <= 240 ? 6 : 5; }

export function buildTerrain(world: StaticWorld): TerrainLayers {
  const { w, h, elevation: E, biome: B, seaLevel: sea } = world;
  const k = cellScale(w);
  const W = w * k, H = h * k;
  const canvas = mkCanvas(W, H);
  const g = canvas.getContext("2d") as Ctx;
  // цвета клеток
  const col = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const b = B[i]!, e = E[i]!;
    let [r, gg, bb] = BIOMES[b]!.color;
    if (isWater(b)) {
      const depth = Math.min(1, (sea - e) / Math.max(0.01, sea));
      if (b !== Biome.Lake) { const dd = Math.min(1, depth * 1.6); r = 66 - 36 * dd; gg = 122 - 58 * dd; bb = 158 - 56 * dd; }
    } else {
      const alt = (e - sea) / (1 - sea);
      const t = world.temperature[i]!, m = world.moisture[i]!;
      // лёгкий разброс оттенков: сухие места желтее, влажные — зеленее
      r += (0.5 - m) * 12 + alt * 6; gg += (m - 0.5) * 10 - alt * 6; bb += (0.5 - t) * 8 + alt * 4;
    }
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = bb;
  }
  const img = (g as CanvasRenderingContext2D).createImageData(W, H);
  const d = img.data;
  const at = (x: number, y: number) => Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x));
  for (let py = 0; py < H; py++) {
    const fy = (py + 0.5) / k - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let px = 0; px < W; px++) {
      const fx = (px + 0.5) / k - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const i00 = at(x0, y0), i10 = at(x0 + 1, y0), i01 = at(x0, y0 + 1), i11 = at(x0 + 1, y0 + 1);
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const e = E[i00]! * w00 + E[i10]! * w10 + E[i01]! * w01 + E[i11]! * w11;
      const lk = (B[i00] === Biome.Lake ? w00 : 0) + (B[i10] === Biome.Lake ? w10 : 0) + (B[i01] === Biome.Lake ? w01 : 0) + (B[i11] === Biome.Lake ? w11 : 0);
      const water = (e < sea && (isWater(B[i00]!) || isWater(B[i10]!) || isWater(B[i01]!) || isWater(B[i11]!))) || lk > 0.5;
      // смешиваем только «свои» клетки (суша с сушей, вода с водой) — берег остаётся чётким
      let sw = 0, r = 0, gg = 0, bb = 0;
      const add = (idx: number, wt: number) => { if (isWater(B[idx]!) === water && wt > 0) { sw += wt; r += col[idx * 3]! * wt; gg += col[idx * 3 + 1]! * wt; bb += col[idx * 3 + 2]! * wt; } };
      add(i00, w00); add(i10, w10); add(i01, w01); add(i11, w11);
      if (sw === 0) { const n = tx + ty < 1 ? i00 : i11; sw = 1; r = col[n * 3]!; gg = col[n * 3 + 1]!; bb = col[n * 3 + 2]!; }
      r /= sw; gg /= sw; bb /= sw;
      // светотень по уклону (свет с северо-запада)
      const ex = (E[at(x0 + 1, y0)]! - E[at(x0 - 1, y0)]!) * (1 - tx) + (E[at(x0 + 2, y0)]! - E[at(x0, y0)]!) * tx;
      const ey = (E[at(x0, y0 + 1)]! - E[at(x0, y0 - 1)]!) * (1 - ty) + (E[at(x0, y0 + 2)]! - E[at(x0, y0)]!) * ty;
      let shade = water ? 1 : Math.max(0.78, Math.min(1.18, 1 + (-ex - ey) * 2.4));
      // мелководье у берега светлее
      if (water && e > sea - 0.025) shade *= 1.12;
      const n = ((hash32(px, py) & 255) / 255 - 0.5) * (water ? 3 : 8);
      const o = (py * W + px) * 4;
      d[o] = r * shade + n; d[o + 1] = gg * shade + n; d[o + 2] = bb * shade + n; d[o + 3] = 255;
    }
  }
  (g as CanvasRenderingContext2D).putImageData(img, 0, 0);
  // пена у берега
  g.strokeStyle = "rgba(235,240,230,0.28)"; g.lineWidth = Math.max(1, k * 0.18);
  g.beginPath();
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!isWater(B[i]!) || B[i] === Biome.Lake) continue;
    if (!isWater(B[i - 1]!) || !isWater(B[i + 1]!) || !isWater(B[i - w]!) || !isWater(B[i + w]!)) {
      if (hash32(x, y, 7) % 3 === 0) { g.moveTo(x * k + k * 0.2, y * k + k * 0.5); g.lineTo(x * k + k * 0.8, y * k + k * 0.5); }
    }
  }
  g.stroke();
  drawRivers(g, world, k);
  drawDecor(g, world, k);
  // маска снега для зимы
  const snow = mkCanvas(w, h);
  const sg = snow.getContext("2d") as Ctx;
  const sd = (sg as CanvasRenderingContext2D).createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const t = world.temperature[i]!;
    const a = isWater(B[i]!) ? (t < 0.25 ? (0.25 - t) * 3 : 0) : Math.max(0, Math.min(1, (0.52 - t) * 3.2));
    sd.data[i * 4] = 240; sd.data[i * 4 + 1] = 246; sd.data[i * 4 + 2] = 255; sd.data[i * 4 + 3] = a * 210;
  }
  (sg as CanvasRenderingContext2D).putImageData(sd, 0, 0);
  return { base: canvas, snow, k };
}

function drawRivers(g: Ctx, world: StaticWorld, k: number): void {
  const { w, h, river: R, elevation: E, biome: B } = world;
  void E;
  g.lineCap = "round"; g.lineJoin = "round";
  // реки: от клетки к самому низкому соседу (по ходу течения), толщина — по силе потока
  const segs: [number, number, number, number, number][] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!R[i]) continue;
    // вниз по течению — соседняя река с бо́льшим потоком; у устья — вода
    let best = -1, bf = R[i]!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = (y + dy) * w + x + dx;
      if (R[j]! > bf) { bf = R[j]!; best = j; }
    }
    if (best < 0) {
      let be = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * w + x + dx;
        if ((dx || dy) && isWater(B[j]!) && E[j]! < be) { be = E[j]!; best = j; }
      }
    }
    if (best < 0) continue;
    const bx = best % w, by = (best / w) | 0;
    // лёгкий изгиб: смещаем середину
    segs.push([x, y, bx, by, R[i]!]);
  }
  for (const pass of [0, 1]) {
    for (const [x, y, bx, by, s] of segs) {
      const wd = (0.35 + s / 255 * 1.3) * k * 0.45;
      g.strokeStyle = pass ? "rgba(84,136,186,0.95)" : "rgba(40,70,100,0.35)";
      g.lineWidth = pass ? wd : wd + k * 0.18;
      const mx = (x + bx) / 2 + ((hash32(x, y) % 100) / 100 - 0.5) * 0.5, my = (y + by) / 2 + ((hash32(y, x) % 100) / 100 - 0.5) * 0.5;
      g.beginPath();
      g.moveTo((x + 0.5) * k, (y + 0.5) * k);
      g.quadraticCurveTo((mx + 0.5) * k, (my + 0.5) * k, (bx + 0.5) * k, (by + 0.5) * k);
      g.stroke();
    }
  }
}

function drawDecor(g: Ctx, world: StaticWorld, k: number): void {
  const { w, h, biome: B, temperature: T } = world;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, b = B[i]!, r = hash32(x, y, 3);
    const cx = (x + 0.5) * k + ((r & 15) / 15 - 0.5) * k * 0.4, cy = (y + 0.5) * k + (((r >> 4) & 15) / 15 - 0.5) * k * 0.4;
    switch (b) {
      case Biome.Mountain: case Biome.Peak: {
        if ((r >> 8) % 10 < 3 && b === Biome.Mountain) break;
        const sz = k * (b === Biome.Peak ? 1.25 : 0.95) * (0.85 + ((r >> 12) & 7) / 20);
        mountain(g, cx, cy + k * 0.3, sz, b === Biome.Peak || T[i]! < 0.35);
        break;
      }
      case Biome.Hills:
        if ((r >> 8) % 3 === 0) hill(g, cx, cy + k * 0.2, k * 0.75);
        break;
      case Biome.Forest: case Biome.Rainforest: {
        const n = b === Biome.Rainforest ? 3 : 2;
        for (let t = 0; t < n; t++) {
          const rr = hash32(x, y, 10 + t);
          tree(g, (x + 0.15 + (rr & 255) / 255 * 0.7) * k, (y + 0.2 + ((rr >> 8) & 255) / 255 * 0.65) * k, k * (b === Biome.Rainforest ? 0.34 : 0.28), b === Biome.Rainforest ? "#2c6a38" : "#3d7a3a");
        }
        break;
      }
      case Biome.Taiga:
        for (let t = 0; t < 2; t++) { const rr = hash32(x, y, 20 + t); conifer(g, (x + 0.2 + (rr & 255) / 255 * 0.6) * k, (y + 0.3 + ((rr >> 8) & 255) / 255 * 0.55) * k, k * 0.42); }
        break;
      case Biome.Desert:
        if ((r >> 8) % 3 === 0) { g.strokeStyle = "rgba(170,130,70,0.45)"; g.lineWidth = Math.max(0.8, k * 0.1); g.beginPath(); g.arc(cx, cy + k * 0.3, k * 0.35, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
        break;
      case Biome.Marsh:
        if ((r >> 8) % 2 === 0) { g.strokeStyle = "rgba(60,90,70,0.6)"; g.lineWidth = Math.max(0.7, k * 0.08); g.beginPath(); for (let t = -1; t <= 1; t++) { g.moveTo(cx + t * k * 0.15, cy + k * 0.15); g.lineTo(cx + t * k * 0.2, cy - k * 0.15); } g.stroke(); }
        break;
      case Biome.Savanna:
        if ((r >> 8) % 7 === 0) tree(g, cx, cy, k * 0.22, "#6f7f3a");
        break;
      default: break;
    }
  }
}

function mountain(g: Ctx, x: number, y: number, s: number, snow: boolean): void {
  const hgt = s * 0.95;
  g.beginPath(); g.moveTo(x - s * 0.62, y); g.lineTo(x, y - hgt); g.lineTo(x + s * 0.62, y); g.closePath();
  g.fillStyle = "rgba(0,0,0,0.18)"; g.fill();                     // тень
  g.beginPath(); g.moveTo(x - s * 0.55, y); g.lineTo(x, y - hgt); g.lineTo(x, y); g.closePath(); g.fillStyle = "#a59886"; g.fill();
  g.beginPath(); g.moveTo(x, y - hgt); g.lineTo(x + s * 0.55, y); g.lineTo(x, y); g.closePath(); g.fillStyle = "#6f6455"; g.fill();
  if (snow) {
    g.beginPath(); g.moveTo(x - s * 0.2, y - hgt * 0.64); g.lineTo(x, y - hgt); g.lineTo(x + s * 0.2, y - hgt * 0.64); g.lineTo(x + s * 0.06, y - hgt * 0.7); g.lineTo(x - s * 0.06, y - hgt * 0.6); g.closePath();
    g.fillStyle = "#f4f6fa"; g.fill();
  }
}
function hill(g: Ctx, x: number, y: number, s: number): void {
  g.beginPath(); g.ellipse(x, y, s * 0.55, s * 0.32, 0, Math.PI, 0); g.fillStyle = "rgba(120,128,80,0.85)"; g.fill();
  g.beginPath(); g.ellipse(x - s * 0.12, y - s * 0.05, s * 0.3, s * 0.18, 0, Math.PI, 0); g.fillStyle = "rgba(170,175,110,0.6)"; g.fill();
}
function tree(g: Ctx, x: number, y: number, r: number, color: string): void {
  g.fillStyle = "rgba(0,0,0,0.2)"; g.beginPath(); g.ellipse(x + r * 0.3, y + r * 0.8, r * 0.9, r * 0.4, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(255,255,220,0.18)"; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2); g.fill();
}
function conifer(g: Ctx, x: number, y: number, s: number): void {
  g.fillStyle = "#2f5a45"; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.38, y); g.lineTo(x - s * 0.38, y); g.closePath(); g.fill();
  g.fillStyle = "#3f7055"; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x - s * 0.38, y); g.lineTo(x, y); g.closePath(); g.fill();
}
