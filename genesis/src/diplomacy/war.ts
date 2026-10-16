import type { Rng } from "../core/rng";
import { EV, logEvent } from "../history/events";
import { has, T } from "../simulation/tech";
import { Biome } from "../world/biomes";
import type { Army, Civ, Settlement, War, WorldState } from "../simulation/types";
import { rel } from "../simulation/entities";
import { abandon, ensureCapital } from "../civilizations/settlements";
import { fall } from "../civilizations/civ";
import { die } from "../characters/characters";

/**
 * Войны: армии выходят из городов, идут к цели (их видно на карте), бьются в поле, осаждают стены
 * и берут города. Исход зависит от численности, технологий, полководца, стен и местности.
 * Мир заключают, когда одна сторона явно побеждает или обе устали.
 */
export function wars(st: WorldState, rng: Rng): void {
  for (const war of st.wars) {
    if (war.end !== null) continue;
    const A = st.civs[war.attacker]!, D = st.civs[war.defender]!;
    if (A.fallen !== null || D.fallen !== null) { endWar(st, war, A.fallen !== null ? 2 : 1); continue; }
    for (const side of [A, D]) side.warWeariness += 1.6;
    raiseArmy(st, rng, war, A, D);
    if (D.military > A.military * 0.75 && rng.chance(0.35)) raiseArmy(st, rng, war, D, A);
    for (const ally of war.defenderAllies) { const c = st.civs[ally]; if (c && c.fallen === null && rng.chance(0.25)) raiseArmy(st, rng, war, c, A); }
    tryPeace(st, rng, war);
  }
  moveArmies(st, rng);
  st.armies = st.armies.filter((a) => a.strength > 1 && st.wars[a.war]?.end === null);
}

function raiseArmy(st: WorldState, rng: Rng, war: War, me: Civ, foe: Civ): void {
  if (st.armies.some((a) => a.civ === me.id && a.war === war.id)) return;
  const mine = st.settlements.filter((s) => s.alive && s.civ === me.id);
  const theirs = st.settlements.filter((s) => s.alive && s.civ === foe.id);
  if (!mine.length || !theirs.length) return;
  // цель — ближайший город врага (слабые стены и богатство делают цель заманчивее)
  let best: { from: Settlement; to: Settlement; score: number } | null = null;
  for (const t of theirs) for (const f of mine) {
    const d = Math.hypot(t.x - f.x, t.y - f.y);
    const score = d + t.walls * 4 - Math.log10(t.pop + 10) * 2;
    if (!best || score < best.score) best = { from: f, to: t, score };
  }
  if (!best || best.score > 60) return;
  const general = st.characters.find((x) => x.died === null && x.civ === me.id && x.role === "general") ?? null;
  const army: Army = {
    id: st.nextId++, civ: me.id, war: war.id, x: best.from.x, y: best.from.y, fromX: best.from.x, fromY: best.from.y,
    target: best.to.id, strength: me.military * rng.range(0.55, 0.8), general: general ? general.id : -1, progress: 0, state: "march", siegeYears: 0,
  };
  if (war.target < 0 && me.id === war.attacker) war.target = best.to.id;
  st.armies.push(army);
}

function speed(c: Civ): number {
  let v = 4;
  if (has(c.techs, T.Wheel)) v += 2;
  if (has(c.techs, T.Husbandry)) v += 1;
  if (c.gov === 6) v += 3;
  if (has(c.techs, T.Railroad)) v += 8;
  return v;
}

function moveArmies(st: WorldState, rng: Rng): void {
  for (const a of st.armies) {
    const t = st.settlements[a.target];
    const me = st.civs[a.civ]!;
    const war = st.wars[a.war]!;
    if (!t || !t.alive || t.civ === a.civ) { a.strength = 0; continue; }
    // цель могла перейти к другому, нейтральному народу — тогда поход окончен
    const foe = st.civs[t.civ]!;
    const enemy = rel(st, a.civ, t.civ).war === a.war;
    if (!enemy) { a.strength = 0; continue; }
    if (a.state === "march") {
      const d = Math.max(1, Math.hypot(t.x - a.fromX, t.y - a.fromY));
      a.progress = Math.min(1, a.progress + speed(me) / d);
      a.x = a.fromX + (t.x - a.fromX) * a.progress;
      a.y = a.fromY + (t.y - a.fromY) * a.progress;
      if (a.progress >= 1) battle(st, rng, a, t, foe, war);
    } else if (a.state === "siege") {
      a.siegeYears++;
      const need = has(me.techs, T.Gunpowder) ? 0 : t.walls;
      a.strength *= 0.94;
      if (a.siegeYears > need) capture(st, rng, a, t, foe, war);
    }
  }
}

function battle(st: WorldState, rng: Rng, a: Army, t: Settlement, foe: Civ, war: War): void {
  const me = st.civs[a.civ]!;
  const general = st.characters[a.general];
  const foeGeneral = st.characters.find((x) => x.died === null && x.civ === foe.id && x.role === "general");
  const wallK = has(me.techs, T.Gunpowder) ? 0.08 : 0.25;
  const terrain = st.map.biome[t.y * st.map.w + t.x] === Biome.Hills ? 1.2 : 1;
  const atk = a.strength * (1 + (general ? general.traits.martial * 0.05 : 0));
  const def = (foe.military * 0.45 + Math.sqrt(t.pop) * 0.25) * (1 + t.walls * wallK) * terrain * (1 + (foeGeneral ? foeGeneral.traits.martial * 0.05 : 0));
  const p = Math.pow(atk, 1.2) / (Math.pow(atk, 1.2) + Math.pow(def, 1.2));
  const win = rng.chance(p);
  const lossA = a.strength * (win ? rng.range(0.15, 0.35) : rng.range(0.45, 0.8));
  const lossD = def * (win ? rng.range(0.4, 0.7) : rng.range(0.1, 0.3));
  const dead = Math.round((lossA + lossD) * 40);
  a.strength -= lossA;
  war.casualties += dead;
  t.pop = Math.max(20, t.pop - lossD * 8);
  const winner = win ? me : foe, loser = win ? foe : me;
  const wGen = win ? general : foeGeneral;
  const big = dead > 2000 || t.tier >= 3;
  const ev = logEvent(st, EV.Battle, { a: winner.id, b: loser.id, c: war.id, s: t.id, n: dead, d: wGen ? wGen.id : -1, imp: big ? 3 : 2 });
  war.battles.push(ev.id);
  if (wGen) { wGen.fame += big ? 3 : 1; wGen.deeds.push(ev.id); }
  const lGen = win ? foeGeneral : general;
  if (lGen && rng.chance(0.2)) die(st, lGen, "пал в битве");
  const sign = a.civ === war.attacker || war.attackerAllies.includes(a.civ) ? 1 : -1;
  war.score += (win ? 8 : -8) * sign;
  me.warWeariness += win ? 1 : 4; foe.warWeariness += win ? 4 : 1;
  if (win) { a.state = "siege"; a.siegeYears = 0; } else a.strength = 0; // разбитое войско рассеивается
}

function capture(st: WorldState, rng: Rng, a: Army, t: Settlement, foe: Civ, war: War): void {
  const me = st.civs[a.civ]!;
  const ruler = st.characters[me.ruler];
  const holy = war.cause === "священная война";
  const raze = (ruler && ruler.traits.cruelty >= 8 && rng.chance(0.35)) || (holy && rng.chance(0.2)) || (me.gov === 6 && rng.chance(0.3));
  const wasCapital = foe.capital === t.id;
  const sign = a.civ === war.attacker || war.attackerAllies.includes(a.civ) ? 1 : -1;
  war.score += (12 + t.tier * 5) * sign;
  rel(st, foe.id, me.id).grievance += 20 + t.tier * 6;
  if (raze) {
    const ev = logEvent(st, EV.Razed, { a: me.id, b: foe.id, s: t.id, c: war.id, imp: t.tier >= 3 ? 4 : 3 });
    abandon(st, t, rng, me.id, ev.id);
  } else {
    t.civ = me.id;
    t.pop *= 0.82;
    t.devastation = Math.min(1, t.devastation + 0.45);
    t.walls = Math.max(0, t.walls - 1);
    war.captured.push(t.id);
    logEvent(st, EV.Captured, { a: me.id, b: foe.id, s: t.id, c: war.id, imp: wasCapital ? 4 : t.tier >= 3 ? 3 : 2 });
  }
  if (wasCapital) { foe.stability -= 15; ensureCapital(st, foe.id); }
  st.territoryDirty = true;
  // армия идёт дальше, если ещё сильна
  a.state = "march"; a.progress = 0; a.fromX = t.x; a.fromY = t.y;
  const next = st.settlements.filter((s) => s.alive && s.civ === foe.id).sort((x, y) => Math.hypot(x.x - t.x, x.y - t.y) - Math.hypot(y.x - t.x, y.y - t.y))[0];
  if (next && a.strength > me.military * 0.25 && Math.hypot(next.x - t.x, next.y - t.y) < 25) a.target = next.id; else a.strength = 0;
  if (!st.settlements.some((s) => s.alive && s.civ === foe.id)) {
    logEvent(st, EV.Annexed, { a: me.id, b: foe.id, s: t.id, imp: 4 });
    fall(st, foe.id);
  }
}

function tryPeace(st: WorldState, rng: Rng, war: War): void {
  const A = st.civs[war.attacker]!, D = st.civs[war.defender]!;
  const years = st.year - war.start;
  if (years < 2) return;
  const tired = A.warWeariness > 45 && D.warWeariness > 35;
  if (Math.abs(war.score) > 45 && rng.chance(0.25)) endWar(st, war, war.score > 0 ? (D.cities <= 1 ? 3 : 1) : 2);
  else if (tired && rng.chance(0.2)) endWar(st, war, Math.abs(war.score) < 15 ? 0 : war.score > 0 ? 1 : 2);
  else if (years > 25 && rng.chance(0.08)) endWar(st, war, 0);
}

export function endWar(st: WorldState, war: War, outcome: number): void {
  war.end = st.year;
  war.outcome = ["белый мир", "победа нападавших", "победа защитников", "капитуляция"][outcome] ?? "мир";
  const years = war.end - war.start;
  if (years >= 100) war.name = "Столетняя война (" + war.name + ")";
  else if (years >= 40) war.name = "Долгая " + war.name.replace(/^./, (c) => c.toLowerCase());
  const sides = [war.attacker, ...war.attackerAllies], other = [war.defender, ...war.defenderAllies];
  for (const a of sides) for (const b of other) {
    const r1 = rel(st, a, b), r2 = rel(st, b, a);
    if (r1.war === war.id) r1.war = -1;
    if (r2.war === war.id) r2.war = -1;
    r1.truceUntil = r2.truceUntil = st.year + 20 + (years > 10 ? 15 : 0);
    r1.opinion -= 10; r2.opinion -= 10;
  }
  const loser = outcome === 2 ? war.attacker : outcome === 0 ? -1 : war.defender;
  if (loser >= 0) { const c = st.civs[loser]!; c.stability -= 10; c.treasury *= 0.7; }
  const start = st.events.find((e) => e.t === EV.WarDeclared && e.c === war.id);
  logEvent(st, EV.Peace, { a: war.attacker, b: war.defender, c: war.id, n: outcome, cause: start?.id ?? -1, imp: war.captured.length >= 2 || years > 15 ? 3 : 2, s: st.civs[war.defender]?.capital ?? -1 });
  for (const a of st.armies) if (a.war === war.id) a.strength = 0;
}
