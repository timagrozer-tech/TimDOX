import { Rng } from "./rng";

/** Двумерный симплекс-шум (Stefan Gustavson), детерминированный по seed */
export class Simplex2 {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);
  private static readonly G = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1];

  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); const t = p[i]!; p[i] = p[j]!; p[j] = t; }
    for (let i = 0; i < 512; i++) { this.perm[i] = p[i & 255]!; this.permMod12[i] = this.perm[i]! % 12; }
  }

  /** Значение в [-1, 1] */
  noise(xin: number, yin: number): number {
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6, G = Simplex2.G;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255, pm = this.permMod12, pp = this.perm;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = pm[ii + pp[jj]!]! * 2; t0 *= t0; n += t0 * t0 * (G[g]! * x0 + G[g + 1]! * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = pm[ii + i1 + pp[jj + j1]!]! * 2; t1 *= t1; n += t1 * t1 * (G[g]! * x1 + G[g + 1]! * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = pm[ii + 1 + pp[jj + 1]!]! * 2; t2 *= t2; n += t2 * t2 * (G[g]! * x2 + G[g + 1]! * y2); }
    return 70 * n;
  }

  /** Фрактальный шум (fBm), примерно в [-1, 1] */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * this.noise(x * freq, y * freq); norm += amp; amp *= gain; freq *= lacunarity; }
    return sum / norm;
  }
  /** «Хребтовый» шум — для горных цепей */
  ridged(x: number, y: number, octaves = 4): number {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) { const v = 1 - Math.abs(this.noise(x * freq, y * freq)); sum += amp * v * v; norm += amp; amp *= 0.5; freq *= 2.1; }
    return sum / norm;
  }
}
