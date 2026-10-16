import { BIOMES, Biome, isWater } from "../world/biomes";
import { hash32 } from "../core/rng";
import type { StaticWorld } from "../workers/protocol";

/**
 * Подложка карты. Один «художник» рисует и общую карту (для мелкого масштаба), и плитки высокой чёткости
 * для крупного: плавные переходы цветов (сглаженная интерполяция), берег по изолинии высоты, бирюзовое
 * мелководье, мягкая светотень, «живописная» фактура, реки и объёмные значки — горы, холмы, леса.
 * Плитки рисуются только для видимой части и кэшируются — при приближении карта остаётся чёткой.
 */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const mkCanvas = (w: number, h: number): AnyCanvas => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
};
export function cellScale(w: number): number { return w <= 180 ? 7 : w <= 240 ? 6 : 5; }

const smooth = (t: number) => t * t * (3 - 2 * t);
// мягкий шум значений в координатах мира — одинаковый для общей карты и плиток (без швов)
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), tx = smooth(x - xi), ty = smooth(y - yi);
  const h = (a: number, b: number) => (hash32(a, b, seed) & 1023) / 1023;
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

export class TerrainPainter {
  readonly k: number;
  readonly base: AnyCanvas;
  readonly snow: AnyCanvas;
  private col: Float32Array;
  private shade: Float32Array;
  private shallow: Float32Array;   // 0 — у самого берега … 1 — открытое море
  private tiles = new Map<string, { c: AnyCanvas; used: number }>();
  static readonly TILE = 16;        // клеток в стороне плитки

  constructor(private world: StaticWorld) {
    const { w, h, elevation: E, biome: B, seaLevel: sea } = world;
    const N = w * h;
    this.k = cellScale(w);
    // расстояние от воды до суши (для мелководья)
    const dist = new Float32Array(N).fill(99);
    const q: number[] = [];
    for (let i = 0; i < N; i++) if (!isWater(B[i]!)) { dist[i] = 0; q.push(i); }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi]!, x = i % w, y = (i / w) | 0;
      if (dist[i]! >= 7) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (dist[j]! > dist[i]! + 1) { dist[j] = dist[i]! + 1; q.push(j); }
      }
    }
    this.shallow = new Float32Array(N);
    this.col = new Float32Array(N * 3);
    this.shade = new Float32Array(N);
    const at = (x: number, y: number) => E[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))]!;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, b = B[i]!, e = E[i]!;
      let [r, g, bl] = BIOMES[b]!.color;
      if (isWater(b)) {
        const s = Math.min(1, (dist[i]! - 1) / 5);
        this.shallow[i] = s;
        const deep = Math.min(1, Math.max(0, (sea - e) / Math.max(0.01, sea)) * 1.4);
        // мелководье бирюзовое, глубина — тёмно-синяя
        const t = Math.max(s, deep * 0.8);
        r = 88 + (22 - 88) * t; g = 158 + (58 - 158) * t; bl = 168 + (98 - 168) * t;
        if (b === Biome.Lake) { r = 78; g = 140; bl = 160; }
      } else {
        const alt = (e - sea) / (1 - sea);
        const m = world.moisture[i]!, tt = world.temperature[i]!;
        r += (0.5 - m) * 10 + alt * 8; g += (m - 0.5) * 8 - alt * 4; bl += (0.5 - tt) * 6 + alt * 6;
      }
      this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = bl;
      const nx = at(x - 1, y) - at(x + 1, y), ny = at(x, y - 1) - at(x, y + 1);
      this.shade[i] = isWater(b) ? 1 : Math.max(0.8, Math.min(1.16, 1 + (nx + ny) * 2.6));
    }
    this.base = mkCanvas(w * this.k, h * this.k);
    this.paintInto(this.base, 0, 0, w, h, this.k);
    // маска снега для зимы
    this.snow = mkCanvas(w, h);
    const sg = this.snow.getContext("2d") as Ctx;
    const sd = (sg as CanvasRenderingContext2D).createImageData(w, h);
    for (let i = 0; i < N; i++) {
      const t = world.temperature[i]!;
      const a = isWater(B[i]!) ? (t < 0.25 ? (0.25 - t) * 3 : 0) : Math.max(0, Math.min(1, (0.52 - t) * 3.2));
      sd.data[i * 4] = 240; sd.data[i * 4 + 1] = 246; sd.data[i * 4 + 2] = 255; sd.data[i * 4 + 3] = a * 210;
    }
    (sg as CanvasRenderingContext2D).putImageData(sd, 0, 0);
  }

  /** Рисует область клеток [cx0, cx0+cw) × [cy0, cy0+ch) в холст с масштабом ppc пикселей на клетку */
  paintInto(canvas: AnyCanvas, cx0: number, cy0: number, cw: number, ch: number, ppc: number): void {
    const { w, h, elevation: E, biome: B, seaLevel: sea } = this.world;
    const W = Math.round(cw * ppc), H = Math.round(ch * ppc);
    const g = canvas.getContext("2d") as Ctx;
    const img = (g as CanvasRenderingContext2D).createImageData(W, H);
    const d = img.data, col = this.col, sh = this.shade;
    const idx = (x: number, y: number) => Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x));
    for (let py = 0; py < H; py++) {
      const ry = cy0 + (py + 0.5) / ppc - 0.5;
      for (let px = 0; px < W; px++) {
        const rx = cx0 + (px + 0.5) / ppc - 0.5;
        // искажение координат шумом: края лесов, снегов, озёр становятся органичными, а не «по клеткам»
        const fx = rx + (vnoise(rx * 0.55, ry * 0.55, 21) - 0.5) * 0.9, fy = ry + (vnoise(rx * 0.55 + 40, ry * 0.55 + 40, 22) - 0.5) * 0.9;
        const x0 = Math.floor(fx), tx = smooth(fx - x0), y0 = Math.floor(fy), ty = smooth(fy - y0);
        const i00 = idx(x0, y0), i10 = idx(x0 + 1, y0), i01 = idx(x0, y0 + 1), i11 = idx(x0 + 1, y0 + 1);
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        const e = E[i00]! * w00 + E[i10]! * w10 + E[i01]! * w01 + E[i11]! * w11;
        const lk = (B[i00] === Biome.Lake ? w00 : 0) + (B[i10] === Biome.Lake ? w10 : 0) + (B[i01] === Biome.Lake ? w01 : 0) + (B[i11] === Biome.Lake ? w11 : 0);
        // лёгкий шум сдвигает берег — линия получается живой, а не «по линейке»
        const wn = (vnoise(fx * 1.7, fy * 1.7, 5) - 0.5) * 0.012;
        const water = (e + wn < sea && (isWater(B[i00]!) || isWater(B[i10]!) || isWater(B[i01]!) || isWater(B[i11]!))) || lk > 0.5;
        let sw = 0, r = 0, gg = 0, bb = 0, s = 0;
        const add = (j: number, wt: number) => { if (wt > 0 && isWater(B[j]!) === water) { sw += wt; r += col[j * 3]! * wt; gg += col[j * 3 + 1]! * wt; bb += col[j * 3 + 2]! * wt; s += sh[j]! * wt; } };
        add(i00, w00); add(i10, w10); add(i01, w01); add(i11, w11);
        if (sw === 0) { const n = tx + ty < 1 ? i00 : i11; sw = 1; r = col[n * 3]!; gg = col[n * 3 + 1]!; bb = col[n * 3 + 2]!; s = sh[n]!; }
        r /= sw; gg /= sw; bb /= sw; s /= sw;
        if (water && lk <= 0.5) {
          // цвет моря — от непрерывной глубины и близости берега: мелководье плавно переходит в глубину
          const sh = this.shallow, sv = sh[i00]! * w00 + sh[i10]! * w10 + sh[i01]! * w01 + sh[i11]! * w11;
          const dep = Math.min(1, Math.max(0, (sea - e) / 0.12));
          const t = Math.min(1, Math.max(sv * 0.85, dep * 0.9) + 0.04);
          r = 92 + (20 - 92) * t; gg = 162 + (56 - 162) * t; bb = 170 + (96 - 170) * t;
        }
        // фактура: крупные пятна + мелкое зерно (в координатах мира — без швов между плитками)
        const tex = water ? (vnoise(fx * 0.9, fy * 0.9, 11) - 0.5) * 7 : (vnoise(fx * 0.8, fy * 0.8, 7) - 0.5) * 16 + (vnoise(fx * 4, fy * 4, 9) - 0.5) * 9;
        const o = (py * W + px) * 4;
        d[o] = r * s + tex; d[o + 1] = gg * s + tex; d[o + 2] = bb * s + tex * 0.8; d[o + 3] = 255;
      }
    }
    (g as CanvasRenderingContext2D).putImageData(img, 0, 0);
    g.save();
    g.scale(ppc, ppc);
    g.translate(-cx0, -cy0);
    this.coastFoam(g, cx0, cy0, cw, ch, ppc);
    this.rivers(g, cx0, cy0, cw, ch, ppc);
    this.decor(g, cx0, cy0, cw, ch, ppc);
    g.restore();
  }

  /** Плитка высокой чёткости (кэш, LRU) */
  tile(tx: number, ty: number, ppc: number, frame: number): AnyCanvas | null {
    const key = `${tx}:${ty}:${ppc}`;
    const hit = this.tiles.get(key);
    if (hit) { hit.used = frame; return hit.c; }
    return null;
  }
  makeTile(tx: number, ty: number, ppc: number, frame: number): AnyCanvas {
    const T = TerrainPainter.TILE;
    const c = mkCanvas(T * ppc, T * ppc);
    this.paintInto(c, tx * T, ty * T, T, T, ppc);
    this.tiles.set(`${tx}:${ty}:${ppc}`, { c, used: frame });
    if (this.tiles.size > 28) {
      let oldK = "", oldF = Infinity;
      for (const [k, v] of this.tiles) if (v.used < oldF) { oldF = v.used; oldK = k; }
      this.tiles.delete(oldK);
    }
    return c;
  }

  private coastFoam(g: Ctx, cx0: number, cy0: number, cw: number, ch: number, ppc: number): void {
    const { w, h, biome: B } = this.world;
    g.strokeStyle = "rgba(240,248,240,0.35)"; g.lineWidth = 1.2 / ppc; g.lineCap = "round";
    g.beginPath();
    for (let y = Math.max(1, cy0 - 1); y < Math.min(h - 1, cy0 + ch + 1); y++) for (let x = Math.max(1, cx0 - 1); x < Math.min(w - 1, cx0 + cw + 1); x++) {
      const i = y * w + x;
      if (!isWater(B[i]!) || B[i] === Biome.Lake || this.shallow[i]! > 0.05) continue;
      if (hash32(x, y, 7) % 2) continue;
      const a = (hash32(x, y, 8) % 628) / 100;
      g.moveTo(x + 0.5 + Math.cos(a) * 0.3, y + 0.5 + Math.sin(a) * 0.3);
      g.arc(x + 0.5, y + 0.5, 0.3, a, a + 1.4);
    }
    g.stroke();
  }

  private rivers(g: Ctx, cx0: number, cy0: number, cw: number, ch: number, ppc: number): void {
    const { w, h, river: R, biome: B } = this.world;
    g.lineCap = "round"; g.lineJoin = "round";
    const segs: number[] = [];
    for (let y = Math.max(1, cy0 - 2); y < Math.min(h - 1, cy0 + ch + 2); y++) for (let x = Math.max(1, cx0 - 2); x < Math.min(w - 1, cx0 + cw + 2); x++) {
      const i = y * w + x;
      if (!R[i]) continue;
      let best = -1, bf = R[i]!;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = (y + dy) * w + x + dx;
        if (R[j]! > bf) { bf = R[j]!; best = j; }
      }
      if (best < 0) for (let dy = -1; dy <= 1 && best < 0; dy++) for (let dx = -1; dx <= 1; dx++) { const j = (y + dy) * w + x + dx; if ((dx || dy) && isWater(B[j]!)) { best = j; break; } }
      if (best >= 0) segs.push(x, y, best % w, (best / w) | 0, R[i]!);
    }
    for (const pass of [0, 1]) {
      for (let k = 0; k < segs.length; k += 5) {
        const x = segs[k]!, y = segs[k + 1]!, bx = segs[k + 2]!, by = segs[k + 3]!, s = segs[k + 4]!;
        const wd = 0.12 + (s / 255) * 0.38;
        g.strokeStyle = pass ? "rgba(96,152,190,0.95)" : "rgba(40,70,90,0.28)";
        g.lineWidth = pass ? wd : wd + 1.6 / ppc;
        const jx = ((hash32(x, y) % 100) / 100 - 0.5) * 0.45, jy = ((hash32(y, x) % 100) / 100 - 0.5) * 0.45;
        g.beginPath();
        g.moveTo(x + 0.5, y + 0.5);
        g.quadraticCurveTo((x + bx) / 2 + 0.5 + jx, (y + by) / 2 + 0.5 + jy, bx + 0.5, by + 0.5);
        g.stroke();
      }
    }
  }

  private decor(g: Ctx, cx0: number, cy0: number, cw: number, ch: number, ppc: number): void {
    const { w, h, biome: B, temperature: T } = this.world;
    const detail = ppc >= 12;
    // рисуем сверху вниз — нижние значки перекрывают верхние (объём)
    for (let y = Math.max(0, cy0 - 1); y < Math.min(h, cy0 + ch + 1); y++) for (let x = Math.max(0, cx0 - 1); x < Math.min(w, cx0 + cw + 1); x++) {
      const i = y * w + x, b = B[i]!, r = hash32(x, y, 3);
      const cx = x + 0.5 + ((r & 15) / 15 - 0.5) * 0.35, cy = y + 0.5 + (((r >> 4) & 15) / 15 - 0.5) * 0.35;
      switch (b) {
        case Biome.Mountain: case Biome.Peak:
          // на общей карте — реже и без мелкой «ряби», на крупной — хребет целиком
          {
            const sparse = ppc <= 12 ? 3 : ppc <= 20 ? 2 : 1;      // мельче масштаб — реже вершины, но крупнее
            if ((!detail || sparse > 1) && (r >> 8) % (detail ? sparse : 3) !== 0 && b === Biome.Mountain) break;
            if (sparse === 1 && b === Biome.Mountain && (r >> 8) % 10 < 3) break;
            const k = (b === Biome.Peak ? 1.3 : 0.95) * (0.75 + ((r >> 12) & 15) / 30) * (detail ? (sparse > 1 ? 1.35 : 1.05) : 1.3);
            mountain(g, cx, cy + 0.32, k, b === Biome.Peak || (sparse === 1 && T[i]! < 0.2));
          }
          break;
        case Biome.Hills:
          if ((r >> 8) % 2 === 0) hill(g, cx, cy + 0.2, 0.75);
          break;
        case Biome.Forest: case Biome.Rainforest: {
          const n = detail ? (b === Biome.Rainforest ? 4 : 3) : 2;
          for (let t = 0; t < n; t++) { const rr = hash32(x, y, 10 + t); tree(g, x + 0.12 + (rr & 255) / 255 * 0.76, y + 0.15 + ((rr >> 8) & 255) / 255 * 0.7, b === Biome.Rainforest ? 0.3 : 0.25, b === Biome.Rainforest ? [40, 96, 56] : [58, 110, 58], detail); }
          break;
        }
        case Biome.Taiga:
          for (let t = 0; t < (detail ? 3 : 2); t++) { const rr = hash32(x, y, 20 + t); conifer(g, x + 0.18 + (rr & 255) / 255 * 0.64, y + 0.3 + ((rr >> 8) & 255) / 255 * 0.55, 0.42); }
          break;
        case Biome.Desert:
          if ((r >> 8) % 3 === 0) { g.strokeStyle = "rgba(160,120,70,0.35)"; g.lineWidth = 0.06; g.beginPath(); g.arc(cx, cy + 0.3, 0.35, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
          break;
        case Biome.Marsh:
          if ((r >> 8) % 2 === 0) { g.strokeStyle = "rgba(60,90,70,0.55)"; g.lineWidth = 0.05; g.beginPath(); for (let t = -1; t <= 1; t++) { g.moveTo(cx + t * 0.15, cy + 0.15); g.lineTo(cx + t * 0.2, cy - 0.15); } g.stroke(); }
          break;
        case Biome.Savanna:
          if ((r >> 8) % 6 === 0) tree(g, cx, cy, 0.2, [104, 116, 60], detail);
          break;
        case Biome.Grassland:
          if (detail && (r >> 8) % 4 === 0) { g.strokeStyle = "rgba(70,100,50,0.25)"; g.lineWidth = 0.035; g.beginPath(); g.moveTo(cx - 0.1, cy); g.lineTo(cx - 0.05, cy - 0.12); g.moveTo(cx + 0.02, cy); g.lineTo(cx + 0.05, cy - 0.14); g.stroke(); }
          break;
        default: break;
      }
    }
  }
}

function mountain(g: Ctx, x: number, y: number, s: number, snow: boolean): void {
  const hgt = s * 0.92;
  // мягкая тень на юго-восток
  g.fillStyle = "rgba(20,15,10,0.16)";
  g.beginPath(); g.moveTo(x - s * 0.35, y); g.lineTo(x + s * 0.2, y - hgt * 0.55); g.lineTo(x + s * 0.95, y + s * 0.08); g.closePath(); g.fill();
  const lit = g.createLinearGradient(x - s * 0.5, y - hgt, x, y);
  lit.addColorStop(0, "#c4b8a4"); lit.addColorStop(1, "#8f8270");
  g.fillStyle = lit;
  g.beginPath(); g.moveTo(x - s * 0.56, y); g.lineTo(x - s * 0.04, y - hgt); g.lineTo(x + s * 0.06, y - hgt * 0.4); g.lineTo(x, y); g.closePath(); g.fill();
  g.fillStyle = "#6b604f";
  g.beginPath(); g.moveTo(x - s * 0.04, y - hgt); g.lineTo(x + s * 0.56, y); g.lineTo(x, y); g.lineTo(x + s * 0.06, y - hgt * 0.4); g.closePath(); g.fill();
  if (snow) {
    g.fillStyle = "#f2f5f8";
    g.beginPath(); g.moveTo(x - s * 0.2, y - hgt * 0.62); g.lineTo(x - s * 0.04, y - hgt); g.lineTo(x + s * 0.18, y - hgt * 0.64); g.lineTo(x + s * 0.06, y - hgt * 0.56); g.lineTo(x - s * 0.06, y - hgt * 0.66); g.closePath(); g.fill();
  }
}
function hill(g: Ctx, x: number, y: number, s: number): void {
  g.fillStyle = "rgba(30,30,10,0.14)"; g.beginPath(); g.ellipse(x + s * 0.08, y + s * 0.03, s * 0.55, s * 0.2, 0, 0, Math.PI * 2); g.fill();
  const gr = g.createLinearGradient(x - s * 0.4, y - s * 0.3, x + s * 0.4, y);
  gr.addColorStop(0, "rgba(176,180,118,0.95)"); gr.addColorStop(1, "rgba(110,118,72,0.95)");
  g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, s * 0.5, s * 0.3, 0, Math.PI, 0); g.fill();
}
function tree(g: Ctx, x: number, y: number, r: number, c: [number, number, number], detail: boolean): void {
  g.fillStyle = "rgba(10,25,10,0.22)"; g.beginPath(); g.ellipse(x + r * 0.35, y + r * 0.75, r * 0.9, r * 0.38, 0, 0, Math.PI * 2); g.fill();
  if (detail) {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.05);
    gr.addColorStop(0, `rgb(${c[0] + 40},${c[1] + 40},${c[2] + 20})`); gr.addColorStop(1, `rgb(${c[0] - 15},${c[1] - 20},${c[2] - 15})`);
    g.fillStyle = gr;
  } else g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function conifer(g: Ctx, x: number, y: number, s: number): void {
  g.fillStyle = "rgba(10,25,15,0.2)"; g.beginPath(); g.ellipse(x + s * 0.18, y + s * 0.04, s * 0.32, s * 0.1, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#2c5442"; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.34, y); g.lineTo(x - s * 0.34, y); g.closePath(); g.fill();
  g.fillStyle = "#43765a"; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x - s * 0.34, y); g.lineTo(x, y); g.closePath(); g.fill();
}
