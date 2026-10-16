// Звуковой модем Ярко: передаёт 32 бита (код человека) звуком из динамика в микрофон, без интернета и Bluetooth.
//
// Как устроено:
//  • 17 тонов данных 2000–4000 Гц (шаг 125 Гц) + два тона-маркера (1500 и 4500 Гц) — начало пакета;
//  • каждый символ — 4 бита, 70 мс; тон считается от предыдущего ((пред + 1 + значение) mod 17), поэтому два
//    соседних символа никогда не звучат одинаково — приёмнику не нужны часы, границы видны по смене тона;
//  • 32 бита + CRC-8 = 10 символов, пакет ≈ 0,9 с и повторяется; приёмник проверяет контрольную сумму;
//  • приёмник каждые 10 мс меряет энергию 19 частот (алгоритм Гёрцеля) и собирает символы из «полос» одного тона.
// Модуль без DOM — тот же код работает в браузере и в тестах.

export const DATA_F0 = 2000, DATA_STEP = 125, NT = 17;
export const MARK_A = 1500, MARK_B = 4500;
export const SYM = 0.09, MARK = 0.1, RAMP = 0.006;
const FREQS = [...Array.from({ length: NT }, (_, k) => DATA_F0 + k * DATA_STEP), MARK_A, MARK_B];
const IA = NT, IB = NT + 1;

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
  return c;
}
function toNibbles(value) {
  const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const all = [...bytes, crc8(bytes)];
  return all.flatMap((b) => [b >> 4, b & 15]);
}
function fromNibbles(n) {
  const b = []; for (let i = 0; i < 10; i += 2) b.push((n[i] << 4) | n[i + 1]);
  if (crc8(b.slice(0, 4)) !== b[4]) return null;
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** Тоны пакета: [{ f, dur }] */
export function packetTones(value) {
  const tones = [{ f: MARK_A, dur: MARK }, { f: MARK_B, dur: MARK }];
  let prev = 0;
  for (const v of toNibbles(value >>> 0)) { const t = (prev + 1 + v) % NT; tones.push({ f: FREQS[t], dur: SYM }); prev = t; }
  return tones;
}

/** Пакет в отсчёты (Float32Array) — для проверки и для проигрывания одним буфером */
export function encode(value, sr, { repeats = 3, gap = 0.25, amp = 0.6 } = {}) {
  const tones = packetTones(value);
  const one = tones.reduce((s, t) => s + t.dur, 0);
  const out = new Float32Array(Math.ceil((one + gap) * repeats * sr) + 1);
  let pos = 0;
  for (let r = 0; r < repeats; r++) {
    let phase = 0;
    for (const { f, dur } of tones) {
      const n = Math.round(dur * sr), ramp = Math.round(RAMP * sr);
      for (let i = 0; i < n; i++) {
        const e = i < ramp ? .5 - .5 * Math.cos(Math.PI * i / ramp) : i > n - ramp ? .5 - .5 * Math.cos(Math.PI * (n - i) / ramp) : 1;
        out[pos + i] = amp * e * Math.sin(phase);
        phase += 2 * Math.PI * f / sr;
      }
      pos += n;
    }
    pos += Math.round(gap * sr);
  }
  return out;
}

/** Приёмник: decoder.push(отсчёты) → массив принятых 32-битных кодов.
 *  1) по маркерам A→B находим начало пакета; 2) дальше символы идут через равные 90 мс — для каждого
 *  берём энергию тонов в его середине; 3) тон предыдущего символа исключаем (по построению он не повторяется —
 *  так эхо прошлого тона не может «перекричать» новый); 4) пробуем сдвиги ±1 кадр и проверяем CRC. */
export class Decoder {
  constructor(sr) {
    this.sr = sr;
    this.hop = Math.round(sr * 0.01);
    this.win = this.hop * 2;
    this.buf = new Float32Array(0);
    this.hann = Float32Array.from({ length: this.win }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (this.win - 1)));
    this.coef = FREQS.map((f) => 2 * Math.cos(2 * Math.PI * f / sr));
    this.floor = 0;
    this.level = 0;
    this.frames = [];          // энергии по кадрам (последние ~4 с)
    this.base = 0;             // номер кадра frames[0]
    this.n = 0;                // всего кадров
    this.aRun = 0; this.lastA = -99;
    this.pending = [];         // ожидаемые пакеты: номер кадра начала данных
    this.L = SYM / 0.01; this.M = MARK / 0.01;
  }
  analyze(x, off) {
    const p = new Float32Array(FREQS.length), w = this.win, h = this.hann;
    for (let k = 0; k < FREQS.length; k++) {
      const c = this.coef[k]; let s1 = 0, s2 = 0;
      for (let i = 0; i < w; i++) { const s0 = x[off + i] * h[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      p[k] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return p;
  }
  label(p) {
    let best = 0, second = 0, bi = -1;
    for (let k = 0; k < p.length; k++) { if (p[k] > best) { second = best; best = p[k]; bi = k; } else if (p[k] > second) second = p[k]; }
    const sorted = Array.from(p).sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    this.floor = this.floor ? this.floor * .97 + median * .03 : median;
    this.level = Math.min(1, Math.sqrt(best / (this.floor * 400 + 1e-12)));
    return best > this.floor * 20 + 1e-9 && best > median * 6 && best > second * 1.3 ? bi : -1;
  }
  energy(f0, f1) { // сумма энергий кадров [f0, f1)
    const e = new Float64Array(NT);
    for (let f = Math.round(f0); f < Math.round(f1); f++) {
      const p = this.frames[f - this.base]; if (!p) continue;
      for (let k = 0; k < NT; k++) e[k] += p[k];
    }
    return e;
  }
  tryDecode(start) {
    for (const shift of [0, -1, 1, -2, 2]) {
      const nib = []; let prev = 0;
      for (let j = 0; j < 10; j++) {
        const s0 = start + shift + j * this.L;
        const e = this.energy(s0 + this.L * .3, s0 + this.L * .9);
        let bi = -1, bv = -1;
        for (let k = 0; k < NT; k++) if (k !== prev && e[k] > bv) { bv = e[k]; bi = k; }
        nib.push((bi - prev - 1 + NT) % NT); prev = bi;
      }
      if (nib.every((v) => v <= 15)) { const v = fromNibbles(nib); if (v != null) return v; }
    }
    return null;
  }
  push(samples) {
    const nb = new Float32Array(this.buf.length + samples.length);
    nb.set(this.buf); nb.set(samples, this.buf.length);
    const got = [];
    let off = 0;
    for (; off + this.win <= nb.length; off += this.hop) {
      const p = this.analyze(nb, off), f = this.n++;
      this.frames.push(p);
      if (this.frames.length > 400) { this.frames.shift(); this.base++; }
      const lab = this.label(p);
      if (lab === IA) { this.aRun++; this.lastA = f; }
      else if (lab === IB) {
        // B сразу после звучавшего A (≥ 3 кадров) — начало пакета; данные — через длину маркера B
        if (this.aRun >= 3 && f - this.lastA <= 4) {
          this.pending.push(f + this.M - 1);
          this.aRun = 0;
        }
      } else if (lab !== -1 || f - this.lastA > 4) this.aRun = lab === -1 ? this.aRun : 0;
      // пакет целиком записан — разбираем
      while (this.pending.length && this.n > this.pending[0] + 10 * this.L + 3) {
        const v = this.tryDecode(this.pending.shift());
        if (v != null && !got.includes(v)) got.push(v);
      }
    }
    this.buf = nb.slice(off);
    return got;
  }
}
