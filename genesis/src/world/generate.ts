import { Rng } from "../core/rng";
import { Simplex2 } from "../core/noise";
import { MinHeap } from "../core/heap";
import { clamp, smoothstep } from "../core/math";
import { Biome, BIOMES, isWater } from "./biomes";
import { Res } from "./resources";
import { SIZES, type WorldMap, type WorldSettings } from "../simulation/types";

/** 8 соседей клетки: смещения */
export const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Генерация мира: материки и острова (шум + «плиты»), горные хребты, климат по широте и высоте,
 * влажность с дождевой тенью, реки по стоку воды (заполнение низин + накопление потока), озёра, природные зоны и ресурсы.
 * Полностью детерминирована: одинаковые seed и настройки → одинаковая карта.
 */
export function generateWorld(settings: WorldSettings): WorldMap {
  const [w, h] = SIZES[settings.size];
  const N = w * h;
  const rng = new Rng("map:" + settings.seed);
  const n1 = new Simplex2(rng.fork("elev")), n2 = new Simplex2(rng.fork("warp")), n3 = new Simplex2(rng.fork("ridge"));
  const n4 = new Simplex2(rng.fork("moist")), n5 = new Simplex2(rng.fork("temp")), n6 = new Simplex2(rng.fork("res"));
  const elevation = new Float32Array(N);

  // «плиты» материков: центры и размеры
  const plates: { x: number; y: number; r: number; k: number }[] = [];
  const count = rng.int(3, 6);
  for (let i = 0; i < count; i++) plates.push({ x: rng.range(0.15, 0.85), y: rng.range(0.2, 0.8), r: rng.range(0.16, 0.32), k: rng.range(0.7, 1.1) });
  const aspect = w / h;
  const sc = 3.2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / w, ny = y / h;
      // искажение координат — береговые линии становятся «рваными»
      const wx = nx + 0.18 * n2.fbm(nx * 2.2 * aspect, ny * 2.2, 3), wy = ny + 0.18 * n2.fbm(nx * 2.2 * aspect + 31, ny * 2.2 + 17, 3);
      let cont = 0;
      for (const p of plates) {
        const dx = (wx - p.x) * aspect * 0.75, dy = wy - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) / p.r;
        cont = Math.max(cont, p.k * (1 - smoothstep(0.2, 1.25, d)));
      }
      const base = n1.fbm(wx * sc * aspect, wy * sc, 6) * 0.5 + 0.5;
      // хребты сильнее там, где край плиты (сталкиваются материки)
      const ridge = n3.ridged(wx * 4.5 * aspect, wy * 4.5, 4);
      const seam = 1 - Math.abs(cont - 0.55) * 2.2;
      let e = 0.42 * base + 0.5 * cont + 0.28 * ridge * clamp(seam, 0, 1) * cont;
      // края карты — океан
      const edge = Math.min(nx, 1 - nx, ny, 1 - ny);
      e *= smoothstep(0, 0.08, edge);
      elevation[y * w + x] = e;
    }
  }
  // нормализуем 0…1 и выбираем уровень моря под нужную долю суши
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) { mn = Math.min(mn, elevation[i]!); mx = Math.max(mx, elevation[i]!); }
  for (let i = 0; i < N; i++) elevation[i] = (elevation[i]! - mn) / (mx - mn || 1);
  const sorted = Float32Array.from(elevation).sort();
  const seaLevel = sorted[Math.floor(N * (1 - clamp(settings.landRatio, 0.2, 0.7)))]!;

  // --- заполнение низин (priority-flood): вода всегда находит путь к морю, а глубокие низины становятся озёрами
  const filled = Float32Array.from(elevation);
  const done = new Uint8Array(N);
  const heap = new MinHeap(N);
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i / w) | 0;
    if (elevation[i]! < seaLevel || x === 0 || y === 0 || x === w - 1 || y === h - 1) { heap.push(filled[i]!, i); done[i] = 1; }
  }
  while (heap.size) {
    const i = heap.pop(), x = i % w, y = (i / w) | 0, e = filled[i]!;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX8[k]!, yy = y + DY8[k]!;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(filled[j]!, e + 1e-5);
      heap.push(filled[j]!, j);
    }
  }

  // --- температура: широта, высота, климат
  const temperature = new Float32Array(N);
  const climShift = settings.climate === "cold" ? -0.12 : settings.climate === "warm" ? 0.1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, lat = Math.abs(y / h - 0.5) * 2;
    const alt = Math.max(0, elevation[i]! - seaLevel) / (1 - seaLevel);
    temperature[i] = clamp(1.04 - lat * 1.0 - alt * 0.4 + climShift + 0.08 * n5.fbm(x / w * 4, y / h * 4, 3));
  }

  // --- влажность: ветер с запада несёт влагу с моря, горы её забирают (дождевая тень)
  const moisture = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    let hum = 0.9;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (elevation[i]! < seaLevel) hum = Math.min(1, hum + 0.08);
      else {
        const alt = (elevation[i]! - seaLevel) / (1 - seaLevel);
        hum *= 0.985 - alt * 0.06;
      }
      moisture[i] = hum;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    // экваториальные дожди и сухие субтропики
    const lat = Math.abs(y / h - 0.5) * 2;
    const belt = 0.25 * Math.cos(lat * Math.PI * 1.6);
    moisture[i] = clamp(moisture[i]! * 0.55 + 0.35 * (n4.fbm(x / w * 5, y / h * 5, 4) * 0.5 + 0.5) + belt);
  }

  // --- реки: накопление стока по направлению наибольшего уклона
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  const ord = Array.from(order).filter((i) => elevation[i]! >= seaLevel).sort((a, b) => filled[b]! - filled[a]!);
  const flow = new Float32Array(N);
  for (const i of ord) flow[i] = 0.3 + moisture[i]!;
  for (const i of ord) {
    const x = i % w, y = (i / w) | 0;
    let best = -1, be = filled[i]!;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX8[k]!, yy = y + DY8[k]!;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (filled[j]! < be) { be = filled[j]!; best = j; }
    }
    if (best >= 0) flow[best] = flow[best]! + flow[i]!;
  }
  const river = new Uint8Array(N);
  const thr = 0.010 * N ** 0.75;
  for (const i of ord) if (flow[i]! > thr) river[i] = Math.min(255, Math.round(40 + 40 * Math.log2(flow[i]! / thr)));

  // --- природные зоны. Горы и холмы — по долям суши (верхние 9 % — горы, 2,5 % — вершины), а не по абсолютной высоте:
  // так в любом мире хребты выглядят как хребты, а не как сплошное нагорье
  const landE = Array.from(elevation).filter((e) => e >= seaLevel).sort((a, b) => a - b);
  const q = (p: number): number => landE[Math.min(landE.length - 1, Math.floor(landE.length * p))] ?? 1;
  const ePeak = q(0.975), eMount = q(0.91), eHill = q(0.78);
  const biome = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const e = elevation[i]!, t = temperature[i]!, m = moisture[i]!;
    if (e < seaLevel) { biome[i] = e < seaLevel - 0.09 ? Biome.DeepOcean : Biome.Ocean; continue; }
    if (filled[i]! - e > 0.03 && !river[i]) { biome[i] = Biome.Lake; continue; }
    const alt = (e - seaLevel) / (1 - seaLevel);
    if (e >= ePeak) biome[i] = Biome.Peak;
    else if (e >= eMount) biome[i] = Biome.Mountain;
    else if (t < 0.08) biome[i] = Biome.Snow;
    else if (t < 0.2) biome[i] = Biome.Tundra;
    else if (e >= eHill) biome[i] = Biome.Hills;
    else if (t < 0.38) biome[i] = m > 0.4 ? Biome.Taiga : Biome.Tundra;
    else if (m < 0.22) biome[i] = t > 0.55 ? Biome.Desert : Biome.Grassland;
    else if (m > 0.72 && t > 0.68) biome[i] = Biome.Rainforest;
    else if (m > 0.7 && alt < 0.08) biome[i] = Biome.Marsh;
    else if (m > 0.5) biome[i] = Biome.Forest;
    else if (t > 0.7 && m < 0.4) biome[i] = Biome.Savanna;
    else biome[i] = Biome.Grassland;
  }
  // побережье и пляжи
  const coast = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (isWater(biome[i]!)) continue;
    for (let k = 0; k < 4; k++) if (isWater(biome[(y + DY8[k]!) * w + x + DX8[k]!]!)) { coast[i] = 1; break; }
    if (coast[i] && biome[i] !== Biome.Mountain && biome[i] !== Biome.Peak && biome[i] !== Biome.Snow && (elevation[i]! - seaLevel) < 0.02 && moisture[i]! < 0.6) biome[i] = Biome.Beach;
  }

  // --- плодородие
  const baseFertility = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = biome[i]!;
    if (isWater(b)) continue;
    const rv = river[i] ? 0.25 + river[i]! / 900 : 0;
    baseFertility[i] = clamp(BIOMES[b]!.food + rv + (coast[i] ? 0.08 : 0), 0, 1.3);
  }

  // --- ресурсы: скоплениями (шум) и по природной зоне
  const resource = new Uint8Array(N);
  const rr = rng.fork("resources");
  const k = clamp(settings.resources, 0.3, 2.5);
  for (let i = 0; i < N; i++) {
    const b = biome[i]!, x = i % w, y = (i / w) | 0;
    const cluster = n6.noise(x / 7, y / 7) * 0.5 + 0.5;
    const p = 0.035 * k * (0.4 + cluster);
    if (!rr.chance(p)) continue;
    let opts: Res[] = [];
    switch (b) {
      case Biome.Ocean: if (coast[i] || rr.chance(0.3)) opts = [Res.Fish]; break;
      case Biome.Grassland: opts = [Res.Wheat, Res.Wheat, Res.Horses, Res.Salt]; break;
      case Biome.Savanna: opts = [Res.Horses, Res.Spices, Res.Gold, Res.Incense]; break;
      case Biome.Desert: opts = [Res.Salt, Res.Incense, Res.Gold, Res.Gems]; break;
      case Biome.Forest: opts = [Res.Wood, Res.Wood, Res.Furs]; break;
      case Biome.Rainforest: opts = [Res.Spices, Res.Wood, Res.Gems]; break;
      case Biome.Taiga: opts = [Res.Furs, Res.Wood, Res.Iron]; break;
      case Biome.Tundra: opts = [Res.Furs]; break;
      case Biome.Hills: opts = [Res.Stone, Res.Copper, Res.Iron, Res.Coal, Res.Gold]; break;
      case Biome.Mountain: opts = [Res.Iron, Res.Copper, Res.Gems, Res.Gold, Res.Coal, Res.Stone]; break;
      case Biome.Marsh: opts = [Res.Spices, Res.Fish]; break;
      case Biome.Beach: opts = [Res.Fish, Res.Salt]; break;
      default: break;
    }
    if (opts.length) resource[i] = rr.pick(opts);
  }
  return { w, h, elevation, seaLevel, temperature, moisture, biome, river, resource, fertility: Float32Array.from(baseFertility), baseFertility, coast };
}

/** Насколько клетка хороша для поселения (0…~2) */
export function settleScore(map: WorldMap, x: number, y: number): number {
  const { w, h } = map;
  if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) return 0;
  const i = y * w + x, b = map.biome[i]!;
  if (isWater(b) || b === Biome.Peak || b === Biome.Mountain || b === Biome.Snow) return 0;
  let s = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const j = (y + dy) * w + x + dx;
    const wgt = dx === 0 && dy === 0 ? 2 : Math.abs(dx) + Math.abs(dy) <= 2 ? 1 : 0.5;
    s += map.fertility[j]! * wgt;
    if (map.resource[j]) s += 0.25 * wgt;
  }
  s /= 22;
  if (map.river[i]) s += 0.35;
  if (map.coast[i]) s += 0.2;
  if (b === Biome.Hills) s += 0.05; // холм — удобно защищаться
  return s;
}
