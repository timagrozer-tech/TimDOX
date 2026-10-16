/**
 * Детерминированный генератор случайных чисел (sfc32). Состояние — 4 числа: его можно сохранить
 * вместе с миром, и после загрузки симуляция продолжится ровно так же.
 */
export type RngState = [number, number, number, number];

export class Rng {
  private a: number; private b: number; private c: number; private d: number;

  constructor(seed: number | string | RngState) {
    if (Array.isArray(seed)) { [this.a, this.b, this.c, this.d] = seed; return; }
    const h = typeof seed === "string" ? hashString(seed) : seed >>> 0;
    this.a = 0x9e3779b9; this.b = 0x243f6a88; this.c = 0xb7e15162; this.d = h ^ 0xdeadbeef;
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Число в [0, 1) */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number { return min + Math.floor(this.next() * (maxInclusive - min + 1)); }
  range(min: number, max: number): number { return min + this.next() * (max - min); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
  /** Выбор по весам */
  weighted<T>(items: readonly T[], weight: (x: T) => number): T | undefined {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const it of items) { r -= Math.max(0, weight(it)); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  /** Нормальное распределение (Бокс — Мюллер) */
  gauss(mean = 0, sd = 1): number {
    const u = 1 - this.next(), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; }
    return arr;
  }
  /** Отдельный поток случайности для подсистемы — не сбивает основной */
  fork(salt: string | number): Rng { return new Rng((hashString(String(salt)) ^ Math.floor(this.next() * 4294967296)) >>> 0); }
  state(): RngState { return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]; }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Хэш нескольких целых — для «случайных» но стабильных величин (например, детали легенды по возрасту) */
export function hash32(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) { h ^= x | 0; h = Math.imul(h, 0x01000193); h ^= h >>> 15; }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
export const hashUnit = (...xs: number[]): number => hash32(...xs) / 4294967296;
