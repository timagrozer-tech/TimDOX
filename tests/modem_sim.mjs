// Проверка звукового модема в «плохом эфире»: шум, эхо комнаты, разные частоты дискретизации. Запуск: node tests/modem_sim.mjs
import { encode, Decoder } from "../static/js/sound/modem.js";
let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function resample(x, from, to) { const n = Math.floor(x.length * to / from), y = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i * from / to, j = Math.floor(t), f = t - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; } return y; }
function reverb(x, sr, rt, drr = 3) { const n = Math.round(rt * sr), ir = new Float32Array(n); ir[0] = 1; let e = 0; for (let i = 7; i < n; i += 7) { ir[i] = gauss() * Math.exp(-6.9 * i / n); e += (ir[i] * 7) ** 2; }
  const sc = Math.sqrt(Math.pow(10, -drr / 10) / e); for (let i = 7; i < n; i += 7) ir[i] *= sc;
  // разреженная свёртка (каждый 7-й отсчёт IR) — быстро и достаточно для теста
  const y = new Float32Array(x.length + n); for (let i = 0; i < x.length; i++) { const v = x[i]; if (!v) continue; y[i] += v; for (let k = 7; k < n; k += 7) y[i + k] += v * ir[k] * 7; } return y; }
let c_drr = 3;
function trial({ snrDb, rt, gain, srTx, srRx, hum, babble, value, drr = 3 }) {
  c_drr = drr;
  let x = encode(value, srTx);
  if (srTx !== srRx) x = resample(x, srTx, srRx);
  if (rt) x = reverb(x, srRx, rt, c_drr);
  const lead = Math.round(srRx * 0.7), y = new Float32Array(x.length + lead * 2);
  let pw = 0; for (const v of x) pw += v * v; pw = pw / x.length * gain * gain;
  const nAmp = Math.sqrt(pw / Math.pow(10, snrDb / 10));
  for (let i = 0; i < y.length; i++) {
    const s = i >= lead && i - lead < x.length ? x[i - lead] * gain : 0;
    let n = gauss() * nAmp;
    if (hum) n += 0.05 * Math.sin(2 * Math.PI * 50 * i / srRx) + 0.03 * Math.sin(2 * Math.PI * 440 * i / srRx);
    if (babble) n += 0.08 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(i / srRx * 3)) * i / srRx) * (0.5 + 0.5 * Math.sin(i / srRx * 7));
    y[i] = s + n;
  }
  const d = new Decoder(srRx); const got = [];
  for (let i = 0; i < y.length; i += 1024) got.push(...d.push(y.subarray(i, i + 1024)));
  return got;
}
const cases = [
  { name: "чисто", snrDb: 30, rt: 0, gain: 1 },
  { name: "шум 10дБ", snrDb: 10, rt: 0, gain: 1 },
  { name: "шум 5дБ", snrDb: 5, rt: 0, gain: 1 },
  { name: "шум 0дБ", snrDb: 0, rt: 0, gain: 1 },
  { name: "эхо 0.3с DRR+3", snrDb: 15, rt: 0.3, gain: 1 },
  { name: "эхо 0.6с DRR0 шум8", snrDb: 8, rt: 0.6, gain: 1, drr: 0 },
  { name: "эхо 0.8с DRR-3", snrDb: 12, rt: 0.8, gain: 1, drr: -3 },
  { name: "тихо, шум 6дБ", snrDb: 6, rt: 0.2, gain: 0.03 },
  { name: "44.1→48 кГц", snrDb: 12, rt: 0.2, gain: 1, srTx: 44100 },
  { name: "гул+голоса", snrDb: 10, rt: 0.3, gain: 1, hum: 1, babble: 1 },
];
for (const c of cases) {
  let ok = 0, wrong = 0, N = 4;
  for (let k = 0; k < N; k++) { const value = Math.floor(rnd() * 2 ** 32) >>> 0;
    const got = trial({ srTx: 48000, srRx: 48000, ...c, value }); if (got.includes(value)) ok++; if (got.some((g) => g !== value)) wrong++; }
  console.log(`${c.name.padEnd(22)} принято ${ok}/${N}  ложных ${wrong}`);
}
