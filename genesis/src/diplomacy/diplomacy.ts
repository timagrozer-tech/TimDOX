import type { Rng } from "../core/rng";
import { clamp } from "../core/math";
import { EV, logEvent } from "../history/events";
import { Gov, type Civ, type War, type WorldState } from "../simulation/types";
import { alive, rel } from "../simulation/entities";
import { borderLen } from "../simulation/territory";
import { RESOURCES } from "../world/resources";

/**
 * Дипломатия: мнение народов друг о друге складывается из родства, веры, торговли, общей границы, союзов
 * и исторической памяти обид. Из мнения, силы, голода и характера правителя рождаются войны и союзы.
 */
export function diplomacy(st: WorldState, rng: Rng): void {
  const civs = st.civs.filter((c) => c.fallen === null);
  // соседи по границе всегда «знакомы»
  for (const key of Object.keys(st.borders)) {
    const k = +key, a = Math.floor(k / 4096), b = k % 4096;
    if (alive(st, a) && alive(st, b)) { rel(st, a, b); rel(st, b, a); }
  }
  for (const a of civs) {
    const ruler = st.characters[a.ruler];
    for (const [bid, r] of Object.entries(a.relations)) {
      const b = st.civs[+bid];
      if (!b || b.fallen !== null) continue;
      let target = 0;
      if (a.culture === b.culture) target += 25;
      else if (st.cultures[a.culture]!.parent === b.culture || st.cultures[b.culture]!.parent === a.culture) target += 12;
      if (a.religion >= 0 && a.religion === b.religion) target += 20;
      else if (a.religion >= 0 && b.religion >= 0) target -= 18 * (a.traits.piety + b.traits.piety) / 2;
      target += Math.min(30, r.trade * 4);
      if (r.alliance) target += 20;
      target -= r.grievance * 0.8;
      const border = borderLen(st, a.id, b.id);
      if (border) target -= Math.min(25, border * 0.35) * (0.4 + a.traits.aggression);
      if (ruler) target += (ruler.traits.diplomacy - 5) * 2 - (ruler.role === "tyrant" ? 10 : 0);
      if (r.war >= 0) target -= 40;
      r.opinion = clamp(r.opinion + (target - r.opinion) * 0.06, -100, 100);
      r.grievance *= 0.992;                 // обиды помнят веками
    }
  }
  // войны
  for (const a of civs) {
    if (a.stability < 22 || a.cities < 1) continue;
    const wars = Object.values(a.relations).filter((r) => r.war >= 0).length;
    if (wars >= 2) continue;
    for (const [bid, r] of Object.entries(a.relations)) {
      const b = st.civs[+bid];
      if (!b || b.fallen !== null || r.war >= 0 || r.alliance || r.truceUntil > st.year) continue;
      const border = borderLen(st, a.id, b.id);
      if (!border && !nearBySea(st, a, b)) continue;
      const allies = Object.entries(b.relations).filter(([, x]) => x.alliance).reduce((s, [id]) => s + (st.civs[+id]?.military ?? 0) * 0.6, 0);
      const power = a.military / Math.max(1, b.military + allies);
      const ruler = st.characters[a.ruler];
      const hunger = landHunger(st, a);
      const holy = a.religion >= 0 && b.religion >= 0 && a.religion !== b.religion && (a.gov === Gov.Theocracy || a.traits.piety > 0.8) ? 0.25 : 0;
      const loot = richBorder(st, a, b);
      const parts: [string, number][] = [
        ["жажда завоеваний", a.traits.aggression * 0.45 + (power - 1) * 0.25],
        ["пограничные споры", Math.min(0.3, border * 0.006) + (-r.opinion / 100) * 0.4],
        ["месть за старые обиды", r.grievance / 100 * 0.6],
        ["борьба за плодородные земли", hunger * 0.45],
        ["священная война", holy],
        ["честолюбие правителя", ruler ? (ruler.traits.ambition - 5) * 0.04 + (ruler.role === "tyrant" ? 0.15 : 0) : 0],
        [loot ? `за богатые земли (${loot})` : "", loot ? 0.12 : 0],
      ];
      const desire = parts.reduce((s, p) => s + p[1], 0) - a.warWeariness / 60 - (power < 0.8 ? 0.4 : 0) - (a.gov === Gov.Republic ? 0.1 : 0);
      if (desire < 0.74 || !rng.chance(0.008 + (desire - 0.74) * 0.06)) continue;
      const cause = parts.filter((p) => p[0]).sort((x, y) => y[1] - x[1])[0]![0];
      declareWar(st, rng, a, b, cause);
      break;
    }
  }
  // союзы
  for (const a of civs) for (const [bid, r] of Object.entries(a.relations)) {
    const b = st.civs[+bid];
    if (!b || b.fallen !== null || b.id < a.id) continue;
    const back = rel(st, b.id, a.id);
    if (!r.alliance && r.war < 0 && r.opinion > 50 && back.opinion > 45) {
      const common = Object.entries(a.relations).some(([cid, x]) => (x.war >= 0 || x.opinion < -25) && (b.relations[+cid]?.opinion ?? 0) < -15);
      if ((common || a.culture === b.culture) && rng.chance(0.02)) { r.alliance = back.alliance = true; logEvent(st, EV.Alliance, { a: a.id, b: b.id, imp: 2 }); }
    } else if (r.alliance && (r.opinion < 5 || back.opinion < 5)) {
      r.alliance = back.alliance = false;
      logEvent(st, EV.AllianceBroken, { a: a.id, b: b.id, imp: 2 });
    }
  }
}

function nearBySea(st: WorldState, a: Civ, b: Civ): boolean {
  const ca = st.settlements[a.capital], cb = st.settlements[b.capital];
  return !!ca && !!cb && a.techs.includes(7) && Math.hypot(ca.x - cb.x, ca.y - cb.y) < 25;
}
function landHunger(st: WorldState, c: Civ): number {
  let hungry = 0, total = 0;
  for (const s of st.settlements) if (s.alive && s.civ === c.id) { total += s.pop; if (s.food < 1.05) hungry += s.pop; }
  return total ? hungry / total : 0;
}
function richBorder(st: WorldState, a: Civ, b: Civ): string {
  const { w } = st.map;
  for (const s of st.settlements) {
    if (!s.alive || s.civ !== b.id) continue;
    const cap = st.settlements[a.capital];
    if (!cap || Math.hypot(cap.x - s.x, cap.y - s.y) > 20) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const r = st.map.resource[(s.y + dy) * w + s.x + dx];
      if (r && RESOURCES[r]!.wealth >= 0.9) return RESOURCES[r]!.name.toLowerCase();
    }
  }
  return "";
}

export function warName(a: Civ, b: Civ, cause: string): string {
  if (cause === "священная война") return `Священная война ${a.adj.replace(/ая$/, "ой")} державы`;
  const s1 = a.adj.replace(/ская$/, "ско").replace(/ая$/, "о");
  const s2 = b.adj.toLowerCase();
  return `${s1}-${s2} война`;
}

export function declareWar(st: WorldState, rng: Rng, a: Civ, b: Civ, cause: string): War {
  const r = rel(st, a.id, b.id), back = rel(st, b.id, a.id);
  // причина-событие: последняя обида между ними (взятый город, отделение, прошлая война)
  let causeEvent = -1;
  for (let i = st.events.length - 1; i >= 0 && i > st.events.length - 4000; i--) {
    const e = st.events[i]!;
    if (((e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)) && (e.t === EV.Captured || e.t === EV.Secession || e.t === EV.Peace || e.t === EV.AllianceBroken)) { causeEvent = e.id; break; }
    if (cause.startsWith("борьба") && e.t === EV.Famine && st.settlements[e.s]?.civ === a.id && st.year - e.y < 15) { causeEvent = e.id; break; }
  }
  const war: War = {
    id: st.wars.length, name: warName(a, b, cause), attacker: a.id, defender: b.id, attackerAllies: [], defenderAllies: [],
    start: st.year, end: null, cause, causeEvent, score: 0, battles: [], casualties: 0, captured: [], outcome: "", target: -1,
  };
  st.wars.push(war);
  st.stats.wars++;
  r.war = back.war = war.id;
  r.alliance = back.alliance = false;
  // союзники вступаются
  for (const [cid, x] of Object.entries(b.relations)) {
    const c = st.civs[+cid];
    if (!c || c.fallen !== null || !x.alliance || c.id === a.id) continue;
    if ((c.relations[a.id]?.opinion ?? 0) < 40 && rng.chance(0.7)) {
      war.defenderAllies.push(c.id);
      rel(st, c.id, a.id).war = war.id; rel(st, a.id, c.id).war = war.id;
    }
  }
  logEvent(st, EV.WarDeclared, { a: a.id, b: b.id, c: war.id, cause: causeEvent, imp: a.cities + b.cities >= 8 ? 4 : 3, s: b.capital });
  return war;
}
