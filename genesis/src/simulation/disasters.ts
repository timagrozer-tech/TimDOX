import type { Rng } from "../core/rng";
import { Biome, isWater } from "../world/biomes";
import { EV, logEvent, DISASTER_CODES } from "../history/events";
import { has, T } from "./tech";
import type { Disaster, Settlement, WorldState } from "./types";
import { abandon } from "../civilizations/settlements";

/**
 * Катастрофы: засухи, мор, потопы, землетрясения, извержения, долгие зимы, саранча.
 * Они меняют плодородие и население — а значит, вызывают голод, переселения и войны за землю.
 */
export function disasters(st: WorldState, rng: Rng): void {
  const k = st.settings.disasters;
  const map = st.map;
  // закончившиеся бедствия: земля восстанавливается
  for (const d of st.disasters) {
    if (d.until === st.year) restore(st, d);
  }
  st.disasters = st.disasters.filter((d) => d.until >= st.year - 1);
  if (k <= 0) return;
  const alive = st.settlements.filter((s) => s.alive);
  if (!alive.length) return;
  const roll = (p: number) => rng.chance(p * k);

  if (roll(0.05)) start(st, rng, "drought", rng.pick(alive), rng.int(6, 14), rng.int(3, 12), rng.range(0.35, 0.7));
  if (roll(0.012)) {
    const cold = alive.filter((s) => map.temperature[s.y * map.w + s.x]! < 0.4);
    if (cold.length) start(st, rng, "winter", rng.pick(cold), rng.int(10, 20), rng.int(2, 5), rng.range(0.4, 0.7));
  }
  if (roll(0.02)) {
    const dry = alive.filter((s) => { const b = map.biome[s.y * map.w + s.x]; return b === Biome.Grassland || b === Biome.Savanna; });
    if (dry.length) start(st, rng, "locust", rng.pick(dry), rng.int(6, 10), rng.int(1, 3), rng.range(0.4, 0.7));
  }
  if (roll(0.02)) {
    const river = alive.filter((s) => map.river[s.y * map.w + s.x]! > 90);
    if (river.length) {
      const s = rng.pick(river);
      const d = start(st, rng, "flood", s, 3, 1, 0.5);
      s.pop *= 0.8; s.devastation = Math.min(1, s.devastation + 0.3);
      void d;
    }
  }
  if (roll(0.012)) {
    const mount = alive.filter((s) => nearBiome(st, s, Biome.Mountain, 3));
    if (mount.length) {
      const s = rng.pick(mount);
      start(st, rng, "earthquake", s, 4, 1, 0.5);
      for (const o of alive) if (Math.hypot(o.x - s.x, o.y - s.y) <= 4) { o.walls = Math.max(0, o.walls - 1); o.pop *= 0.88; o.devastation = Math.min(1, o.devastation + 0.25); }
    }
  }
  if (roll(0.005)) {
    const peaks = alive.filter((s) => nearBiome(st, s, Biome.Peak, 4));
    if (peaks.length) {
      const s = rng.pick(peaks);
      const d = start(st, rng, "volcano", s, 4, 2, 0.8);
      for (const o of alive) {
        const dd = Math.hypot(o.x - s.x, o.y - s.y);
        if (dd <= 2.5 && rng.chance(0.5)) abandon(st, o, rng, -1, d.event);
        else if (dd <= 4) { o.pop *= 0.6; o.devastation = 1; }
      }
    }
  }
  // мор: начинается в большом городе, идёт по торговым путям
  const big = alive.filter((s) => s.tier >= 3 && s.plague < st.year);
  if (big.length && roll(0.012 + big.length * 0.001)) {
    const s = rng.pick(big);
    const d = start(st, rng, "plague", s, 1, 4, rng.range(0.15, 0.35));
    infect(st, s, d);
  }
  for (const d of st.disasters) if (d.type === "plague" && d.until >= st.year) spreadPlague(st, rng, d);
}

function start(st: WorldState, rng: Rng, type: Disaster["type"], s: Settlement, r: number, years: number, severity: number): Disaster {
  const ev = logEvent(st, EV.Disaster, { s: s.id, n: DISASTER_CODES.indexOf(type), imp: type === "plague" || type === "volcano" || (type === "drought" && r >= 12 && years >= 8) ? 4 : 3, a: s.civ });
  const d: Disaster = { id: st.nextId++, type, x: s.x, y: s.y, r, start: st.year, until: st.year + years, severity, event: ev.id };
  st.disasters.push(d);
  ev.c = d.id;
  if (type === "drought" || type === "winter" || type === "locust") {
    const { w, h } = st.map;
    for (let y = Math.max(0, d.y - r); y <= Math.min(h - 1, d.y + r); y++) for (let x = Math.max(0, d.x - r); x <= Math.min(w - 1, d.x + r); x++) {
      if (Math.hypot(x - d.x, y - d.y) > r) continue;
      const i = y * w + x;
      if (!isWater(st.map.biome[i]!)) st.map.fertility[i] = st.map.baseFertility[i]! * (1 - severity);
    }
    st.territoryDirty = true; // пересчёт пропитания
  }
  void rng;
  return d;
}

function restore(st: WorldState, d: Disaster): void {
  if (d.type !== "drought" && d.type !== "winter" && d.type !== "locust" && d.type !== "volcano") return;
  const { w, h } = st.map, r = d.r;
  for (let y = Math.max(0, d.y - r); y <= Math.min(h - 1, d.y + r); y++) for (let x = Math.max(0, d.x - r); x <= Math.min(w - 1, d.x + r); x++) {
    const i = y * w + x;
    // после извержения пепел делает землю особенно плодородной
    st.map.fertility[i] = d.type === "volcano" ? Math.min(1.3, st.map.baseFertility[i]! * 1.25) : st.map.baseFertility[i]!;
  }
  st.territoryDirty = true;
}

function infect(st: WorldState, s: Settlement, d: Disaster): void {
  const c = st.civs[s.civ];
  const k = c && has(c.techs, T.Medicine) ? 0.35 : 1;
  const deaths = s.pop * d.severity * k;
  s.pop -= deaths;
  s.plague = st.year + 3;
  if (deaths > 400) logEvent(st, EV.Plague, { s: s.id, n: deaths, a: s.civ, cause: d.event, imp: deaths > 20000 ? 4 : 3 });
}
function spreadPlague(st: WorldState, rng: Rng, d: Disaster): void {
  const sick = new Set(st.settlements.filter((s) => s.alive && s.plague >= st.year).map((s) => s.id));
  for (const r of st.routes) {
    const inA = sick.has(r.a), inB = sick.has(r.b);
    if (inA === inB) continue;
    const to = st.settlements[inA ? r.b : r.a]!;
    if (to.alive && to.plague < st.year - 20 && rng.chance(0.35)) infect(st, to, d);
  }
}
function nearBiome(st: WorldState, s: Settlement, b: Biome, r: number): boolean {
  const { w, h } = st.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x >= 0 && y >= 0 && x < w && y < h && st.map.biome[y * w + x] === b) return true;
  }
  return false;
}
