import type { Rng } from "../core/rng";
import { clamp } from "../core/math";
import { EV, logEvent } from "../history/events";
import { available, civEra, has, T, TECHS, techMilitary, ERAS } from "../simulation/tech";
import { Gov, type Civ, type Settlement, type WorldState } from "../simulation/types";
import { citiesOf, newCiv, newCulture, rel } from "../simulation/entities";
import { ensureCapital } from "./settlements";
import { setGov } from "../characters/characters";
import { Res } from "../world/resources";

/** Сводные показатели государства: население, число городов, армия */
export function refreshCivStats(st: WorldState): void {
  const pop = new Float64Array(st.civs.length), cities = new Int32Array(st.civs.length), walls = new Float64Array(st.civs.length);
  for (const s of st.settlements) if (s.alive && s.civ >= 0) { pop[s.civ] += s.pop; cities[s.civ]++; walls[s.civ] += s.walls; }
  for (const c of st.civs) {
    if (c.fallen !== null) continue;
    c.pop = pop[c.id]!; c.cities = cities[c.id]!;
    c.peakPop = Math.max(c.peakPop, c.pop); c.peakCities = Math.max(c.peakCities, c.cities);
    const cul = st.cultures[c.culture]!;
    const general = st.characters.filter((x) => x.died === null && x.civ === c.id && x.role === "general").reduce((m, g) => Math.max(m, g.traits.martial), 0);
    c.military = Math.pow(c.pop, 0.85) * 0.02 * techMilitary(c.techs) * (1 + cul.traits.martial * 0.3) * (0.5 + c.stability / 140) * (1 + general * 0.04) * (c.gov === Gov.Horde ? 1.35 : 1);
    if (c.cities === 0) fall(st, c.id);
  }
  let peak = 0; for (const c of st.civs) if (c.fallen === null) peak += c.pop;
  st.stats.peakPop = Math.max(st.stats.peakPop, peak);
}

export function fall(st: WorldState, civId: number, cause = -1): void {
  const c = st.civs[civId]!;
  if (c.fallen !== null) return;
  c.fallen = st.year;
  st.stats.collapses++;
  logEvent(st, EV.Collapse, { a: civId, imp: c.peakCities >= 5 ? 5 : c.peakCities >= 2 ? 3 : 1, cause, x: st.settlements[c.capital]?.x, y: st.settlements[c.capital]?.y });
  for (const o of st.civs) { const r = o.relations[civId]; if (r) { r.war = -1; r.alliance = false; } }
  for (const w of st.wars) if (w.end === null && (w.attacker === civId || w.defender === civId)) { w.end = st.year; w.outcome = "одна из сторон исчезла"; }
  for (const a of st.armies) if (a.civ === civId) a.strength = 0;
}

/** Исследования: собственные очки + знания соседей и торговых партнёров */
export function research(st: WorldState, rng: Rng): void {
  const pace = st.settings.pace;
  for (const c of st.civs) {
    if (c.fallen !== null) continue;
    const libraries = st.settlements.filter((s) => s.alive && s.civ === c.id && s.buildings & 4).length;
    let pts = Math.pow(c.pop, 0.4) * 0.05 * (0.6 + c.traits.science) * pace * (1 + Math.min(10, libraries) * 0.05);
    if (has(c.techs, T.Writing)) pts *= 1.3;
    if (has(c.techs, T.Mathematics)) pts *= 1.2;
    if (has(c.techs, T.Printing)) pts *= 1.5;
    if (has(c.techs, T.Science)) pts *= 1.6;
    if (c.goldenAge > st.year) pts *= 1.4;
    c.research += pts;
    const opts = available(c.techs);
    if (!opts.length) continue;
    // выбор — по нуждам: у моря — мореходство, в войне — оружие, при голоде — еда
    const coastal = st.settlements.some((s) => s.alive && s.civ === c.id && st.map.coast[s.y * st.map.w + s.x]);
    const atWar = Object.values(c.relations).some((r) => r.war >= 0);
    const hungry = st.settlements.some((s) => s.alive && s.civ === c.id && s.food < 0.9);
    const pick = rng.weighted(opts, (t) => {
      let wgt = 1 / TECHS[t]!.cost;
      if (coastal && (t === T.Sailing || t === T.Navigation || t === T.Astronomy)) wgt *= 2;
      if (atWar && (t === T.Bronze || t === T.Iron || t === T.Steel || t === T.Gunpowder)) wgt *= 2.5;
      if (hungry && (t === T.Agriculture || t === T.Irrigation || t === T.Pottery)) wgt *= 3;
      if (t === T.Mysticism) wgt *= 0.5 + c.traits.piety;
      return wgt;
    })!;
    // знания соседей удешевляют изучение (диффузия технологий)
    let known = 0;
    for (const [oid, r] of Object.entries(c.relations)) { const o = st.civs[+oid]; if (o && o.fallen === null && has(o.techs, pick) && (r.trade > 0 || r.opinion > 0)) known++; }
    const cost = TECHS[pick]!.cost * (1 - Math.min(0.5, known * 0.12)) * (1 + c.techs.length * 0.06);
    if (c.research >= cost) {
      c.research -= cost;
      c.techs.push(pick);
      const first = !st.civs.some((o) => o.id !== c.id && o.techs.includes(pick));
      const scholar = st.characters.find((x) => x.died === null && x.civ === c.id && x.role === "scholar");
      const ev = logEvent(st, EV.Tech, { a: c.id, n: pick, d: first && scholar ? scholar.id : -1, imp: first ? 3 : 1, s: c.capital });
      if (first && scholar) { scholar.fame += 4; scholar.deeds.push(ev.id); }
      const era = TECHS[pick]!.era;
      if (era > st.era) { st.era = era; logEvent(st, EV.Era, { a: c.id, n: era, imp: 5, s: c.capital }); }
    }
  }
}

/** Устойчивость, смена устройства, золотой век, распад, отделение, объединение */
export function politics(st: WorldState, rng: Rng): void {
  for (const c of st.civs) {
    if (c.fallen !== null) continue;
    ensureCapital(st, c.id);
    const cities = citiesOf(st, c.id);
    if (!cities.length) { fall(st, c.id); continue; }
    // --- устойчивость
    const foreign = cities.reduce((s, x) => s + (x.culture !== c.culture ? x.pop : 0), 0) / Math.max(1, c.pop);
    const hungry = cities.reduce((s, x) => s + (x.food < 0.85 ? x.pop : 0), 0) / Math.max(1, c.pop);
    const ruler = st.characters[c.ruler];
    let target = 72 - Math.pow(c.cities, 0.8) * (has(c.techs, T.Law) ? 1.6 : 2.6) - foreign * 30 - hungry * 25 - c.warWeariness * 0.6;
    if (has(c.techs, T.Philosophy)) target += 5;
    if (has(c.techs, T.Railroad)) target += 8;
    if (c.gov === Gov.Republic) target += 4;
    if (c.gov === Gov.Theocracy) target += c.religion >= 0 ? 6 : -4;
    if (c.gov === Gov.Tribe) target += 10;
    if (ruler) target += (ruler.traits.stewardship - 5) * 1.5 - Math.max(0, ruler.traits.cruelty - 6) * 2 + (ruler.role === "tyrant" ? -8 : 0);
    if (c.goldenAge > st.year) target += 10;
    c.stability = clamp(c.stability + (target - c.stability) * 0.08, 0, 100);
    c.warWeariness = Math.max(0, c.warWeariness * 0.9);
    c.treasury += cities.reduce((s, x) => s + x.wealth * 0.02, 0) + c.pop * 0.0004;
    // --- устройство
    if (c.gov === Gov.Tribe && (c.cities >= 2 || c.pop > 900)) setGov(st, c.id, c.traits.aggression > 0.72 && has(c.techs, T.Husbandry) && nearHorses(st, cities) ? Gov.Horde : Gov.Chiefdom);
    else if ((c.gov === Gov.Chiefdom || c.gov === Gov.Horde) && c.pop > 5000 && c.cities >= 3 && (has(c.techs, T.Writing) || has(c.techs, T.Bronze))) setGov(st, c.id, c.traits.piety > 0.8 && c.religion >= 0 ? Gov.Theocracy : Gov.Kingdom);
    else if ((c.gov === Gov.Kingdom || c.gov === Gov.Theocracy) && c.cities >= 10 && c.pop > 60000) setGov(st, c.id, Gov.Empire);
    else if (c.gov === Gov.Kingdom && has(c.techs, T.Philosophy) && has(c.techs, T.Currency) && c.traits.trade > 0.65 && c.stability < 50 && rng.chance(0.01)) setGov(st, c.id, Gov.Republic);
    else if (c.gov === Gov.Empire && c.cities < 6) setGov(st, c.id, Gov.Kingdom);
    // --- золотой век
    if (c.goldenAge < st.year && c.stability > 82 && c.treasury > 200 && c.cities >= 3 && rng.chance(0.01)) {
      c.goldenAge = st.year + rng.int(30, 70);
      logEvent(st, EV.GoldenAge, { a: c.id, s: c.capital, imp: 3 });
    }
    // --- восстания и отделения
    if (c.stability < 30 && c.cities >= 3 && rng.chance((30 - c.stability) * 0.004)) secede(st, rng, c, cities);
    // --- полный распад большой державы в смуте
    if (c.stability < 10 && c.cities >= 6 && rng.chance(0.05)) shatter(st, rng, c, cities);
    // --- ассимиляция: завоёванные города постепенно перенимают язык
    for (const s of cities) if (s.culture !== c.culture && rng.chance(0.004 * (1 - st.cultures[s.culture]!.traits.tradition * 0.7))) s.culture = c.culture;
  }
  unify(st, rng);
  cultureLife(st);
}
function nearHorses(st: WorldState, cities: Settlement[]): boolean {
  const { w } = st.map;
  return cities.some((s) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { if (st.map.resource[(s.y + dy) * w + s.x + dx] === Res.Horses) return true; } return false; });
}

/** Отделение: дальний или чужой по языку город с соседями провозглашает независимость */
function secede(st: WorldState, rng: Rng, c: Civ, cities: Settlement[]): void {
  const cap = st.settlements[c.capital]!;
  const cand = cities.filter((s) => s.id !== c.capital).sort((a, b) =>
    (Math.hypot(b.x - cap.x, b.y - cap.y) + (b.culture !== c.culture ? 20 : 0) + b.unrest) - (Math.hypot(a.x - cap.x, a.y - cap.y) + (a.culture !== c.culture ? 20 : 0) + a.unrest));
  const leader = cand[0];
  if (!leader) return;
  const group = cities.filter((s) => s.id !== c.capital && Math.hypot(s.x - leader.x, s.y - leader.y) < 9 && Math.hypot(s.x - leader.x, s.y - leader.y) < Math.hypot(s.x - cap.x, s.y - cap.y));
  const revolt = logEvent(st, EV.Revolt, { s: leader.id, a: c.id, imp: 2 });
  const nc = splitOff(st, rng, c, leader, group);
  logEvent(st, EV.Secession, { a: nc.id, b: c.id, s: leader.id, imp: group.length >= 3 ? 4 : 3, cause: revolt.id });
  c.stability += 8; // избавились от беспокойной окраины
}

/** Распад великой державы на несколько государств-наследников */
function shatter(st: WorldState, rng: Rng, c: Civ, cities: Settlement[]): void {
  const cw = logEvent(st, EV.CivilWar, { a: c.id, s: c.capital, imp: 4 });
  const cap = st.settlements[c.capital]!;
  const rest = cities.filter((s) => s.id !== c.capital && Math.hypot(s.x - cap.x, s.y - cap.y) > 4);
  const parts = Math.min(4, Math.max(2, Math.floor(rest.length / 3)));
  const seeds = rng.shuffle(rest.slice()).slice(0, parts);
  const groups = seeds.map(() => [] as Settlement[]);
  for (const s of rest) {
    let bi = 0, bd = Infinity;
    seeds.forEach((sd, i) => { const d = Math.hypot(sd.x - s.x, sd.y - s.y); if (d < bd) { bd = d; bi = i; } });
    if (bd < Math.hypot(cap.x - s.x, cap.y - s.y)) groups[bi]!.push(s);
  }
  seeds.forEach((sd, i) => { if (groups[i]!.length) { const nc = splitOff(st, rng, c, sd, groups[i]!); logEvent(st, EV.Secession, { a: nc.id, b: c.id, s: sd.id, imp: 3, cause: cw.id }); } });
  c.stability = 35;
}

function splitOff(st: WorldState, rng: Rng, c: Civ, leader: Settlement, group: Settlement[]): Civ {
  // далёкая и давняя окраина говорит уже на своём наречии — рождается новый народ
  let culture = leader.culture;
  if (culture === c.culture && st.year - st.cultures[culture]!.founded > 350 && rng.chance(0.5)) {
    const nc = newCulture(st, rng, culture);
    logEvent(st, EV.CultureFormed, { a: nc.id, b: culture, s: leader.id, imp: 3 });
    culture = nc.id;
  }
  const n = newCiv(st, rng, leader.id, culture, c.gov === Gov.Empire ? Gov.Kingdom : Math.max(Gov.Chiefdom, Math.min(c.gov, Gov.Kingdom)), c.id);
  n.techs = c.techs.slice();
  n.religion = leader.religion >= 0 ? leader.religion : c.religion;
  n.treasury = c.treasury * 0.2; c.treasury *= 0.8;
  for (const s of new Set([leader, ...group])) { s.civ = n.id; if (culture !== c.culture && s.culture === c.culture) s.culture = culture; s.unrest = 0; }
  const r1 = rel(st, n.id, c.id), r2 = rel(st, c.id, n.id);
  r1.opinion = -40; r2.opinion = -50; r1.grievance = 30; r2.grievance = 40;
  st.territoryDirty = true;
  return n;
}

/** Мирное объединение: два небольших родственных государства в долгом союзе сливаются */
function unify(st: WorldState, rng: Rng): void {
  for (const a of st.civs) {
    if (a.fallen !== null) continue;
    for (const [bid, r] of Object.entries(a.relations)) {
      const b = st.civs[+bid];
      if (!b || b.fallen !== null || !r.alliance || r.opinion < 70 || a.culture !== b.culture || b.cities > a.cities || b.cities > 4) continue;
      if (!rng.chance(0.01)) continue;
      for (const s of st.settlements) if (s.alive && s.civ === b.id) s.civ = a.id;
      logEvent(st, EV.Unification, { a: a.id, b: b.id, s: a.capital, imp: 4 });
      b.fallen = st.year;
      for (const o of st.civs) { const rr = o.relations[b.id]; if (rr) { rr.war = -1; rr.alliance = false; } }
      st.territoryDirty = true;
    }
  }
}

function cultureLife(st: WorldState): void {
  if (st.year % 10) return;
  const alive = new Set<number>();
  for (const s of st.settlements) if (s.alive) alive.add(s.culture);
  for (const cu of st.cultures) if (cu.extinct === null && !alive.has(cu.id)) cu.extinct = st.year;
}

export const eraName = (c: Civ): string => ERAS[civEra(c.techs)]!;
