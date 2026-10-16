import type { Rng } from "../core/rng";
import { clamp } from "../core/math";
import { settleScore } from "../world/generate";
import { isWater, Biome } from "../world/biomes";
import { EV, logEvent } from "../history/events";
import { has, T } from "../simulation/tech";
import { BLD, Gov, type Settlement, type WorldState } from "../simulation/types";
import { alive, newCharacter, newCiv, newSettlement, rel } from "../simulation/entities";
import { makeRuin } from "../archaeology/archaeology";

export const TIER_POP = [0, 150, 1500, 8000, 40000, 200000];
const WONDERS = ["Великий маяк", "Висячие сады", "Колосс", "Великая библиотека", "Храм тысячи огней", "Небесная обсерватория", "Звёздный зиккурат", "Великая стена", "Хрустальный дворец", "Башня ветров", "Каменный амфитеатр", "Медный собор"];

/** Рост населения, голод, уровни поселений, постройки, запустение */
export function updateSettlements(st: WorldState, rng: Rng): void {
  const pace = st.settings.pace;
  for (const s of st.settlements) {
    if (!s.alive) continue;
    const c = st.civs[s.civ];
    const golden = c && c.goldenAge > st.year ? 1.25 : 1;
    let r = 0.018 * pace * golden;
    if (c && has(c.techs, T.Medicine)) r += 0.006;
    const cap = s.cap;
    if (s.pop < cap) s.pop += r * s.pop * (1 - s.pop / cap) + 0.4;
    else {
      // голод: лишние люди погибают или уходят
      const excess = s.pop - cap;
      const loss = excess * (c && has(c.techs, T.Pottery) ? 0.18 : 0.28);
      s.pop -= loss;
      if (loss > 500 && loss > s.pop * 0.08 && rng.chance(0.35)) {
        const cause = st.disasters.find((d) => d.until >= st.year && Math.hypot(d.x - s.x, d.y - s.y) <= d.r);
        logEvent(st, EV.Famine, { s: s.id, n: loss, a: s.civ, cause: cause?.event ?? -1, imp: loss > 3000 ? 3 : 2 });
        s.unrest += 8;
      }
    }
    s.food = cap / Math.max(1, s.pop);
    s.devastation = Math.max(0, s.devastation - 0.04);
    s.unrest = Math.max(0, s.unrest * 0.93 + (s.food < 0.8 ? 2 : 0));
    // уровень поселения
    let tier = 0;
    while (tier < 5 && s.pop >= TIER_POP[tier + 1]!) tier++;
    if (tier > s.tier) {
      s.tier = tier;
      if (tier >= 2) logEvent(st, EV.Grew, { s: s.id, a: s.civ, n: tier, imp: tier >= 4 ? 3 : 2 });
    } else if (tier < s.tier - 1) s.tier = tier + 1; // не мигаем туда-обратно на границе
    if (c) build(st, rng, s);
    if (s.pop < 18) abandon(st, s, rng);
  }
}

function build(st: WorldState, rng: Rng, s: Settlement): void {
  const c = st.civs[s.civ]!;
  const t = c.techs;
  const want = (flag: number, ok: boolean, p: number) => { if (ok && !(s.buildings & flag) && rng.chance(p)) s.buildings |= flag; };
  want(BLD.Temple, has(t, T.Mysticism) && s.tier >= 1, 0.04);
  want(BLD.Market, has(t, T.Currency) && s.tier >= 2, 0.05);
  want(BLD.Library, has(t, T.Writing) && s.tier >= 3, 0.03);
  want(BLD.Harbor, has(t, T.Sailing) && st.map.coast[s.y * st.map.w + s.x] === 1 && s.tier >= 1, 0.05);
  want(BLD.Academy, has(t, T.Philosophy) && s.tier >= 3, 0.02);
  want(BLD.Palace, c.capital === s.id && s.tier >= 3, 0.05);
  // стены: при угрозе (война, сосед-агрессор) строят охотнее
  const threat = Object.values(c.relations).some((r) => r.war >= 0) ? 3 : 1;
  if (s.tier >= 2 && s.walls < (has(t, T.Engineering) ? 3 : has(t, T.Bronze) ? 2 : 1) && rng.chance(0.012 * threat)) s.walls++;
  // чудо света: богатый крупный город, инженерия
  if (!s.wonder && s.tier >= 4 && has(t, T.Engineering) && c.treasury > 400 && rng.chance(0.004 * st.settings.pace)) {
    s.wonder = rng.pick(WONDERS.filter((wn) => !st.settlements.some((o) => o.wonder === wn))) ?? "";
    if (s.wonder) {
      s.buildings |= BLD.Wonder;
      c.treasury -= 300;
      const arch = newCharacter(st, rng, c.id, s.id, "artist", rng.int(35, 55));
      arch.fame += 6;
      const ev = logEvent(st, EV.Wonder, { s: s.id, a: c.id, d: arch.id, imp: 4 });
      arch.deeds.push(ev.id);
    }
  }
}

export function abandon(st: WorldState, s: Settlement, rng: Rng, razedBy = -1, cause = -1): void {
  s.alive = false;
  s.fell = st.year;
  if (razedBy < 0) logEvent(st, EV.Abandoned, { s: s.id, a: s.civ, imp: s.tier >= 2 ? 3 : 1, cause });
  if (s.tier >= 1 || s.history.length > 2) makeRuin(st, rng, s);
  const c = st.civs[s.civ];
  if (c && c.capital === s.id) c.capital = -1;
}

/** Хорошее место для нового поселения в пределах досягаемости */
export function findSite(st: WorldState, rng: Rng, fromX: number, fromY: number, minD: number, maxD: number, civ: number, sea: boolean, tries = 30): { x: number; y: number; score: number } | null {
  const { w, h } = st.map;
  let bestSite: { x: number; y: number; score: number } | null = null;
  for (let k = 0; k < tries; k++) {
    const ang = rng.next() * Math.PI * 2, d = rng.range(minD, maxD);
    const x = Math.round(fromX + Math.cos(ang) * d), y = Math.round(fromY + Math.sin(ang) * d);
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    const i = y * w + x;
    const own = st.owner[i]!;
    if (own >= 0 && own !== civ) continue;
    let sc = settleScore(st.map, x, y);
    if (sc <= 0.35) continue;
    // по суше: путь не должен пересекать море (если нет кораблей)
    if (!sea && crossesWater(st, fromX, fromY, x, y)) continue;
    // далеко от других поселений
    let near = false;
    for (const o of st.settlements) if (o.alive && Math.abs(o.x - x) + Math.abs(o.y - y) < 5) { near = true; break; }
    if (near) continue;
    // руины — люди любят старые места (и потом найдут древности)
    if (st.ruins.some((r) => Math.abs(r.x - x) + Math.abs(r.y - y) <= 1)) sc += 0.05;
    sc -= d * 0.004;
    if (!bestSite || sc > bestSite.score) bestSite = { x, y, score: sc };
  }
  return bestSite;
}
function crossesWater(st: WorldState, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 1; k < n; k++) {
    const x = Math.round(x0 + (x1 - x0) * (k / n)), y = Math.round(y0 + (y1 - y0) * (k / n));
    if (isWater(st.map.biome[y * st.map.w + x]!)) return true;
  }
  return false;
}

/** Освоение земель: перенаселённые поселения выводят колонии */
export function colonize(st: WorldState, rng: Rng): void {
  const pace = st.settings.pace;
  const list = st.settlements.filter((s) => s.alive && s.civ >= 0 && s.pop > 220 && s.pop > s.cap * 0.55);
  for (const s of list) {
    const c = st.civs[s.civ]!;
    if (!alive(st, c.id)) continue;
    if (!rng.chance(0.05 * pace * (0.5 + c.traits.expansion) * (c.stability / 70))) continue;
    const sea = has(c.techs, T.Sailing) && st.map.coast[s.y * st.map.w + s.x] === 1;
    const far = sea && has(c.techs, T.Navigation) ? 40 : sea ? 18 : has(c.techs, T.Wheel) ? 12 : 9;
    const site = findSite(st, rng, s.x, s.y, 5, far, c.id, sea);
    if (!site) continue;
    const movers = s.pop * rng.range(0.15, 0.25);
    s.pop -= movers;
    // за морем колонисты часто становятся независимыми (особенно у племён)
    const overseas = crossesWaterLand(st, s, site.x, site.y);
    const independent = c.gov <= Gov.Chiefdom && Math.hypot(site.x - s.x, site.y - s.y) > 11 && rng.chance(0.35);
    const ns = newSettlement(st, rng, site.x, site.y, independent ? -1 : c.id, s.culture, movers, s.id);
    ns.religion = s.religion;
    if (overseas && rng.chance(0.4)) {
      const ex = newCharacter(st, rng, c.id, s.id, "explorer", rng.int(25, 40));
      ex.fame += 3; ns.founder = ex.id;
      const ev = logEvent(st, EV.Exploration, { a: c.id, b: ex.id, s: ns.id, imp: 2 });
      ex.deeds.push(ev.id);
    }
    if (independent) {
      const nc = newCiv(st, rng, ns.id, s.culture, Gov.Tribe, c.id);
      ns.civ = nc.id; nc.religion = s.religion; nc.techs = c.techs.slice();
      rel(st, nc.id, c.id).opinion = 30; rel(st, c.id, nc.id).opinion = 30;
      logEvent(st, EV.CivFounded, { a: nc.id, b: c.id, s: ns.id, imp: 2 });
    } else logEvent(st, EV.Colony, { s: ns.id, a: c.id, d: s.id, imp: 1 });
    st.territoryDirty = true;
  }
}
function crossesWaterLand(st: WorldState, s: Settlement, x: number, y: number): boolean { return crossesWater(st, s.x, s.y, x, y); }

/** Великие переселения: из голодающих, разорённых, пострадавших от бедствий мест */
export function migrations(st: WorldState, rng: Rng): void {
  for (const s of st.settlements) {
    if (!s.alive || s.pop < 400) continue;
    const pressure = (s.food < 0.85 ? (0.85 - s.food) * 2 : 0) + s.devastation * 0.8 + (s.unrest > 40 ? 0.3 : 0);
    if (pressure <= 0.25 || !rng.chance(0.06 * pressure)) continue;
    const c = st.civs[s.civ];
    const sea = !!c && has(c.techs, T.Sailing);
    const site = findSite(st, rng, s.x, s.y, 10, 34, -2, sea, 40);
    const movers = s.pop * rng.range(0.2, 0.38);
    s.pop -= movers;
    const cause = st.events.length ? lastCauseFor(st, s) : -1;
    if (!site) { logEvent(st, EV.Migration, { s: s.id, a: s.civ, n: movers, cause, imp: 2 }); continue; }
    // далеко от своих — переселенцы основывают свой народ
    const nearOwn = st.settlements.some((o) => o.alive && o.civ === s.civ && Math.hypot(o.x - site.x, o.y - site.y) < 9);
    const ns = newSettlement(st, rng, site.x, site.y, nearOwn ? s.civ : -1, s.culture, movers, s.id);
    ns.religion = s.religion;
    if (!nearOwn || s.civ < 0) {
      const nc = newCiv(st, rng, ns.id, s.culture, c && c.gov >= Gov.Kingdom ? Gov.Chiefdom : Gov.Tribe, s.civ);
      ns.civ = nc.id; nc.religion = s.religion; if (c) nc.techs = c.techs.filter(() => rng.chance(0.85));
      if (c) { rel(st, nc.id, c.id).grievance = 10; }
    }
    logEvent(st, EV.Migration, { s: s.id, a: s.civ, d: ns.id, n: movers, cause, imp: movers > 3000 ? 4 : 3 });
    if (!nearOwn) logEvent(st, EV.CivFounded, { a: ns.civ, b: s.civ, s: ns.id, imp: 2 });
    st.territoryDirty = true;
  }
}
function lastCauseFor(st: WorldState, s: Settlement): number {
  // ближайшая по времени беда, связанная с этим местом: голод, мор, бедствие, взятие
  for (let k = s.history.length - 1; k >= 0; k--) {
    const e = st.events[s.history[k]!]!;
    if (st.year - e.y > 30) break;
    if (e.t === EV.Famine || e.t === EV.Plague || e.t === EV.Disaster || e.t === EV.Captured || e.t === EV.Battle) return e.id;
  }
  const d = st.disasters.find((dd) => dd.until >= st.year - 5 && Math.hypot(dd.x - s.x, dd.y - s.y) <= dd.r + 2);
  return d ? d.event : -1;
}

/** Самое людное место государства — новая столица */
export function ensureCapital(st: WorldState, civId: number): void {
  const c = st.civs[civId]!;
  const cap = st.settlements[c.capital];
  if (cap && cap.alive && cap.civ === civId) return;
  let bestS: Settlement | null = null;
  for (const s of st.settlements) if (s.alive && s.civ === civId && (!bestS || s.pop > bestS.pop)) bestS = s;
  if (!bestS) return;
  const old = c.capital;
  c.capital = bestS.id;
  if (old >= 0) logEvent(st, EV.NewCapital, { s: bestS.id, a: civId, imp: 2 });
}

export const isMountainous = (b: number): boolean => b === Biome.Mountain || b === Biome.Hills || b === Biome.Peak;
export const habitableShare = (s: Settlement): number => clamp(s.food, 0, 2);
