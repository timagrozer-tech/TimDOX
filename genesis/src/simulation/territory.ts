import { MinHeap } from "../core/heap";
import { BIOMES, isWater } from "../world/biomes";
import { RESOURCES } from "../world/resources";
import { has, T } from "./tech";
import type { WorldState } from "./types";

/** Временные массивы (не сохраняются — пересчитываются) */
let claim: Int32Array | null = null;
let best: Float64Array | null = null;
let srcOf: Int32Array | null = null;
const heap = new MinHeap(4096);

export function claimMap(): Int32Array | null { return claim; }
/** Растёт при каждом пересчёте границ — интерфейс узнаёт, что карту владений пора перерисовать */
export let territoryVersion = 0;

/** Сила притяжения поселения: крупные города и столицы раздвигают границы */
function reach(st: WorldState, sid: number): number {
  const s = st.settlements[sid]!;
  const c = st.civs[s.civ];
  let r = 1.6 + s.tier * 1.1 + Math.log10(Math.max(10, s.pop)) * 0.5;
  if (c && c.capital === sid) r += 1.2;
  if (c && has(c.techs, T.Engineering)) r += 0.6;
  if (c && has(c.techs, T.Railroad)) r += 1.2;
  return r * (1 - s.devastation * 0.4);
}

/**
 * Границы: многоисточниковая Дейкстра от всех поселений. Цена шага — проходимость местности, делённая на силу
 * поселения, поэтому границы идут по горам и рекам, а большие города «перетягивают» земли. Заодно считаем,
 * сколько людей прокормят земли каждого поселения, и длины общих границ между государствами.
 */
export function computeTerritory(st: WorldState): void {
  const { w, h } = st.map, N = w * h, map = st.map;
  if (!claim || claim.length !== N) { claim = new Int32Array(N); best = new Float64Array(N); srcOf = new Int32Array(N); }
  const cl = claim, bs = best!, so = srcOf!;
  cl.fill(-1); bs.fill(Infinity);
  heap.clear();
  const alive = st.settlements.filter((s) => s.alive && s.civ >= 0);
  const R = new Float32Array(st.settlements.length);
  for (const s of alive) {
    R[s.id] = reach(st, s.id);
    const i = s.y * w + s.x;
    bs[i] = 0; so[i] = s.id; heap.push(0, i);
  }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, 1.41, 1.41, 1.41, 1.41];
  while (heap.size) {
    const key = heap.peekKey();
    const i = heap.pop();
    if (key > bs[i]!) continue;
    if (key > 1) continue;
    cl[i] = so[i]!;
    const x = i % w, y = (i / w) | 0, sid = so[i]!, r = R[sid]!;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k]!, yy = y + DY[k]!;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, b = map.biome[j]!;
      // вода: прибрежная полоса принадлежит (рыболовство), но дальше не идём
      const step = isWater(b) ? (map.coast[i] || isWater(map.biome[i]!) ? 2.5 : 99) : BIOMES[b]!.move + (map.river[j] && !map.river[i] ? 0.6 : 0);
      const nk = key + (step * DC[k]!) / r;
      if (nk < bs[j]! && nk <= 1) { bs[j] = nk; so[j] = sid; heap.push(nk, j); }
    }
  }
  // хозяева клеток, пропитание, общие границы
  const owner = st.owner;
  const food = new Float32Array(st.settlements.length), land = new Int32Array(st.settlements.length);
  for (let i = 0; i < N; i++) {
    const sid = cl[i]!;
    if (sid < 0) { owner[i] = -1; continue; }
    const s = st.settlements[sid]!;
    owner[i] = s.civ;
    const b = map.biome[i]!;
    let f = map.fertility[i]!;
    if (isWater(b)) f = map.resource[i] ? 0.35 : 0.08; // море кормит рыбой
    const res = map.resource[i]!;
    if (res) f += RESOURCES[res]!.food;
    food[sid] = food[sid]! + f;
    land[sid] = land[sid]! + 1;
  }
  st.borders = {};
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    const a = owner[i]!, b = owner[i + 1]!, c = y < h - 1 ? owner[i + w]! : -1;
    if (a >= 0 && b >= 0 && a !== b) addBorder(st, a, b);
    if (a >= 0 && c >= 0 && a !== c) addBorder(st, a, c);
  }
  for (const s of alive) { s.land = land[s.id]!; s.cap = capacity(st, s.id, food[s.id]!); }
  st.territoryDirty = false;
  territoryVersion++;
}
function addBorder(st: WorldState, a: number, b: number): void {
  const k = a < b ? a * 4096 + b : b * 4096 + a;
  st.borders[k] = (st.borders[k] ?? 0) + 1;
}
export const borderLen = (st: WorldState, a: number, b: number): number => st.borders[a < b ? a * 4096 + b : b * 4096 + a] ?? 0;

/** Сколько людей прокормит земля поселения — зависит от технологий */
export function capacity(st: WorldState, sid: number, food: number): number {
  const s = st.settlements[sid]!;
  const c = st.civs[s.civ];
  const t = c ? c.techs : [];
  let per = 24;                                   // собиратели
  if (has(t, T.Agriculture)) per += 80;
  if (has(t, T.Husbandry)) per += 25;
  if (has(t, T.Pottery)) per += 15;
  if (has(t, T.Irrigation)) per += 60;
  if (has(t, T.Currency)) per += 20;
  if (has(t, T.Engineering)) per += 40;
  if (has(t, T.Steel)) per += 30;
  if (has(t, T.Science)) per += 90;
  if (has(t, T.Medicine)) per += 60;
  if (has(t, T.Steam)) per += 220;
  if (has(t, T.Railroad)) per += 260;
  let cap = food * per;
  // города кормятся и торговлей
  cap += s.wealth * 6;
  if (c && c.capital === sid) cap *= 1.15;
  return Math.max(30, cap * (1 - s.devastation * 0.5));
}
