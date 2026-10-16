import type { Rng } from "../core/rng";
import { EV, logEvent } from "../history/events";
import { has, T } from "../simulation/tech";
import { BLD, type Artifact, type Ruin, type Settlement, type WorldState } from "../simulation/types";

/**
 * Руины и артефакты. Когда город гибнет, его следы остаются на карте, а предметы в руинах «помнят» реальные
 * события его истории: надпись — коронацию, меч — битву, идол — забытую веру. Народы с письменностью находят
 * руины случайно, с археологией — ищут их нарочно.
 */
export function makeRuin(st: WorldState, rng: Rng, s: Settlement): Ruin {
  const ruin: Ruin = {
    id: st.ruins.length, settlement: s.id, name: s.name, x: s.x, y: s.y, civ: s.civ, culture: s.culture, religion: s.religion,
    from: s.founded, to: st.year, discovered: null, discoveredBy: -1, artifacts: [], tier: s.tier, fortress: s.walls >= 2,
  };
  const civ = st.civs[s.civ];
  const evs = s.history.map((id) => st.events[id]!).filter((e) => e.imp >= 2);
  const mk = (kind: Artifact["kind"], event: number, character = -1, religion = -1): void => {
    if (ruin.artifacts.length >= 6) return;
    ruin.artifacts.push({ id: st.nextId++, kind, event, character, religion, year: event >= 0 ? st.events[event]!.y : s.founded, found: null });
  };
  for (const e of evs.slice(-12)) {
    switch (e.t) {
      case EV.Battle: mk("weapon", e.id, e.d); break;
      case EV.Crowned: mk(civ && has(civ.techs, T.Writing) ? "inscription" : "crown", e.id, e.b); break;
      case EV.RulerDied: mk("tomb", e.id, e.b); break;
      case EV.ReligionFounded: mk("idol", e.id, e.b, e.a); break;
      case EV.Wonder: mk("mosaic", e.id, e.d); break;
      case EV.Captured: mk("inscription", e.id); break;
      case EV.Grew: if (civ && has(civ.techs, T.Writing) && rng.chance(0.4)) mk("tablet", e.id); break;
      case EV.Disaster: case EV.Plague: if (rng.chance(0.5)) mk("tablet", e.id); break;
      default: break;
    }
  }
  if (s.buildings & BLD.Market) mk("coins", s.history[s.history.length - 1] ?? -1);
  if (s.buildings & BLD.Library) mk("scroll", s.history[0] ?? -1);
  if (s.religion >= 0 && !ruin.artifacts.some((a) => a.kind === "idol")) mk("idol", -1, -1, s.religion);
  if (civ && ruin.artifacts.length < 2) mk("seal", s.history[0] ?? -1);
  s.ruin = ruin.id;
  st.ruins.push(ruin);
  return ruin;
}

/** Находки: соседи с письменностью иногда натыкаются на руины, с археологией — раскапывают их */
export function archaeology(st: WorldState, rng: Rng): void {
  const { w } = st.map;
  for (const r of st.ruins) {
    if (st.year - r.to < 60) continue;               // ещё свежо в памяти — это не археология
    const own = st.owner[r.y * w + r.x]!;
    if (own < 0) continue;
    const c = st.civs[own]!;
    if (c.fallen !== null) continue;
    const arch = has(c.techs, T.Archaeology), writing = has(c.techs, T.Writing);
    if (!writing) continue;
    if (r.discovered === null) {
      if (!rng.chance(arch ? 0.06 : 0.006)) continue;
      r.discovered = st.year; r.discoveredBy = own;
      const near = nearestAlive(st, r.x, r.y);
      logEvent(st, EV.RuinsFound, { a: own, d: r.id, s: near, x: r.x, y: r.y, imp: r.tier >= 3 ? 4 : 3 });
    } else {
      const next = r.artifacts.find((a) => a.found === null);
      if (next && rng.chance(arch ? 0.08 : 0.01)) {
        next.found = st.year;
        logEvent(st, EV.Artifact, { a: own, d: r.id, c: r.artifacts.indexOf(next), x: r.x, y: r.y, cause: next.event, imp: 2 });
      }
    }
  }
}

/** Раскопки по желанию игрока (режим вмешательства): все артефакты сразу */
export function excavate(st: WorldState, ruinId: number): number {
  const r = st.ruins[ruinId];
  if (!r) return 0;
  if (r.discovered === null) { r.discovered = st.year; r.discoveredBy = -1; }
  let n = 0;
  for (const a of r.artifacts) if (a.found === null) { a.found = st.year; n++; }
  return n;
}

function nearestAlive(st: WorldState, x: number, y: number): number {
  let best = -1, bd = Infinity;
  for (const s of st.settlements) if (s.alive) { const d = Math.abs(s.x - x) + Math.abs(s.y - y); if (d < bd) { bd = d; best = s.id; } }
  return best;
}
