import type { Rng } from "../core/rng";
import { RESOURCES } from "../world/resources";
import { has, T } from "../simulation/tech";
import { BLD, type Settlement, type WorldState } from "../simulation/types";
import { rel } from "../simulation/entities";

/**
 * Экономика: богатство города = ресурсы округи + ремесло + торговля. Торговые пути связывают города дружественных
 * народов, несут богатство, знания, веру — и болезни. Где ходят караваны, остаются дороги, которые потом
 * переживают сами государства («древние дороги» на карте).
 */
export function economy(st: WorldState, rng: Rng): void {
  const { w, h } = st.map;
  // ресурсы в округе города (радиус 2)
  for (const s of st.settlements) {
    if (!s.alive) continue;
    let res = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const r = st.map.resource[y * w + x]!;
      if (r && st.owner[y * w + x] === s.civ) res += RESOURCES[r]!.wealth;
    }
    const c = st.civs[s.civ];
    let craft = Math.sqrt(s.pop) * 0.05 * (1 + s.tier * 0.3);
    if (c && has(c.techs, T.Currency)) craft *= 1.4;
    if (c && has(c.techs, T.Steam)) craft *= 2;
    if (s.buildings & BLD.Market) craft *= 1.3;
    const income = res * 0.8 + craft;
    // богатство копится, но и тратится (содержание) — стремится к равновесию
    s.wealth += income - s.wealth * 0.05;
  }
  if (st.year % 5 === 0) rebuildRoutes(st, rng);
  for (const r of st.routes) {
    const a = st.settlements[r.a]!, b = st.settlements[r.b]!;
    if (!a.alive || !b.alive) { r.volume = 0; continue; }
    const g = r.volume * 0.15;
    a.wealth += g; b.wealth += g;
    if (a.civ !== b.civ && a.civ >= 0 && b.civ >= 0) {
      const ra = rel(st, a.civ, b.civ), rb = rel(st, b.civ, a.civ);
      ra.trade += r.volume; rb.trade += r.volume;
    }
  }
  // дороги медленно зарастают
  if (st.year % 8 === 0) for (let i = 0; i < st.road.length; i++) if (st.road[i]) st.road[i] = st.road[i]! - 1;
  for (const c of st.civs) for (const r of Object.values(c.relations)) r.trade *= 0.8;
}

function rebuildRoutes(st: WorldState, rng: Rng): void {
  const old = new Set(st.routes.map((r) => r.a * 100000 + r.b));
  const hubs = st.settlements.filter((s) => s.alive && s.tier >= 1 && s.civ >= 0);
  const routes: typeof st.routes = [];
  for (const a of hubs) {
    const ca = st.civs[a.civ]!;
    const range = has(ca.techs, T.Railroad) ? 40 : has(ca.techs, T.Wheel) ? 20 : 12;
    const sea = has(ca.techs, T.Sailing) && st.map.coast[a.y * st.map.w + a.x] === 1;
    const cand: { s: Settlement; v: number; sea: boolean }[] = [];
    for (const b of hubs) {
      if (b.id <= a.id) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const bSea = sea && st.map.coast[b.y * st.map.w + b.x] === 1 && has(st.civs[b.civ]!.techs, T.Sailing);
      if (d > (bSea ? range * 2 : range)) continue;
      if (a.civ !== b.civ) {
        const r = st.civs[a.civ]!.relations[b.civ];
        if (r && (r.war >= 0 || r.opinion < -40)) continue;
      }
      const v = Math.sqrt(a.pop * b.pop) / 900 / (1 + d * 0.08) * (a.civ !== b.civ ? 1.3 : 1) * (has(ca.techs, T.Currency) ? 1.5 : 1);
      cand.push({ s: b, v, sea: bSea && d > range });
    }
    cand.sort((x, y) => y.v - x.v);
    for (const c of cand.slice(0, 2)) routes.push({ a: a.id, b: c.s.id, volume: c.v, since: st.year, sea: c.sea });
  }
  routes.sort((x, y) => y.volume - x.volume);
  st.routes = routes.slice(0, 220);
  for (const r of st.routes) {
    if (old.has(r.a * 100000 + r.b)) r.since = Math.min(r.since, st.year);
    const a = st.settlements[r.a]!, b = st.settlements[r.b]!;
    if (!r.sea) wearRoad(st, a.x, a.y, b.x, b.y, r.volume);
    // торговля сближает народы
    if (a.civ !== b.civ) { rel(st, a.civ, b.civ).opinion += 1.5; rel(st, b.civ, a.civ).opinion += 1.5; }
  }
  void rng;
}

function wearRoad(st: WorldState, x0: number, y0: number, x1: number, y1: number, v: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const inc = Math.min(40, 4 + v * 3);
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + (x1 - x0) * (k / n)), y = Math.round(y0 + (y1 - y0) * (k / n));
    const i = y * st.map.w + x;
    st.road[i] = Math.min(255, st.road[i]! + inc);
  }
}
