import { Rng } from "../core/rng";
import { generateWorld, settleScore } from "../world/generate";
import { EV, logEvent } from "../history/events";
import { computeTerritory } from "./territory";
import { T } from "./tech";
import { Gov, type WorldSettings, type WorldState } from "./types";
import { newCharacter, newCiv, newCulture, newSettlement } from "./entities";
import { colonize, migrations, updateSettlements, abandon } from "../civilizations/settlements";
import { politics, refreshCivStats, research } from "../civilizations/civ";
import { spreadReligions } from "../civilizations/religion";
import { ensureRulers, spawnGreatPeople, updateCharacters } from "../characters/characters";
import { economy } from "../economy/economy";
import { diplomacy } from "../diplomacy/diplomacy";
import { wars } from "../diplomacy/war";
import { disasters } from "./disasters";
import { archaeology, excavate } from "../archaeology/archaeology";

export const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS: WorldSettings = {
  name: "Новый мир", seed: "", size: "medium", tribes: 14, climate: "temperate", resources: 1, disasters: 1, startEra: 0, pace: 1, landRatio: 0.4,
};

/** Новый мир: карта + первые племена на лучших землях, подальше друг от друга */
export function createWorld(settings: WorldSettings): WorldState {
  const map = generateWorld(settings);
  const N = map.w * map.h;
  const st: WorldState = {
    version: SAVE_VERSION, settings, year: 0, rng: new Rng("sim:" + settings.seed).state(), map,
    owner: new Int16Array(N).fill(-1), road: new Uint8Array(N), settlements: [], civs: [], cultures: [], religions: [], characters: [],
    wars: [], armies: [], ruins: [], events: [], routes: [], disasters: [], era: 0, nextId: 1, territoryDirty: true, borders: {},
    stats: { peakPop: 0, wars: 0, collapses: 0 },
  };
  const rng = new Rng(st.rng);
  // кандидаты — лучшие места
  const cand: { x: number; y: number; s: number }[] = [];
  for (let k = 0; k < 4000; k++) {
    const x = rng.int(3, map.w - 4), y = rng.int(3, map.h - 4);
    const s = settleScore(map, x, y);
    if (s > 0.55) cand.push({ x, y, s: s + rng.range(0, 0.3) });
  }
  cand.sort((a, b) => b.s - a.s);
  const minD = Math.sqrt((map.w * map.h * settings.landRatio) / Math.max(1, settings.tribes)) * 0.75;
  const placed: { x: number; y: number }[] = [];
  for (const c of cand) {
    if (placed.length >= settings.tribes) break;
    if (placed.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < minD)) continue;
    placed.push(c);
  }
  const startTechs: number[] = settings.startEra >= 1 ? [T.Agriculture, T.Husbandry, T.Pottery, T.Mysticism] : [];
  if (settings.startEra >= 2) startTechs.push(T.Bronze, T.Writing, T.Wheel, T.Sailing);
  for (const p of placed) {
    const cul = newCulture(st, rng);
    const s = newSettlement(st, rng, p.x, p.y, -1, cul.id, rng.range(60, 140) * (1 + settings.startEra * 2));
    const civ = newCiv(st, rng, s.id, cul.id, settings.startEra >= 2 ? Gov.Chiefdom : Gov.Tribe);
    s.civ = civ.id;
    civ.techs = startTechs.slice();
    const chief = newCharacter(st, rng, civ.id, s.id, "founder", rng.int(25, 40));
    chief.fame = 4; s.founder = chief.id; civ.ruler = chief.id;
    const ev = logEvent(st, EV.TribeEmerges, { a: civ.id, s: s.id, b: chief.id, imp: 2 });
    chief.deeds.push(ev.id);
  }
  st.rng = rng.state();
  computeTerritory(st);
  refreshCivStats(st);
  return st;
}

/** Один год истории мира. Порядок важен: природа → люди → знания → власть → дипломатия → войны → память. */
export function tick(st: WorldState): void {
  const rng = new Rng(st.rng);
  st.year++;
  disasters(st, rng);
  if (st.territoryDirty || st.year % 3 === 0) computeTerritory(st);
  updateSettlements(st, rng);
  economy(st, rng);
  colonize(st, rng);
  if (st.year % 2 === 0) migrations(st, rng);
  research(st, rng);
  refreshCivStats(st);
  ensureRulers(st, rng);
  updateCharacters(st, rng);
  spawnGreatPeople(st, rng);
  if (st.year % 2 === 1) spreadReligions(st, rng);
  diplomacy(st, rng);
  wars(st, rng);
  politics(st, rng);
  if (st.year % 3 === 0) archaeology(st, rng);
  st.rng = rng.state();
}

/** Режим Творца: вмешательство в мир */
export type Tool = "meteor" | "rain" | "drought" | "plague" | "genius" | "tribe" | "quake" | "discord" | "dig";
export const TOOLS: { id: Tool; name: string; icon: string; hint: string }[] = [
  { id: "meteor", name: "Небесный огонь", icon: "☄", hint: "Огненный камень с неба разрушает всё вокруг" },
  { id: "rain", name: "Благодатные дожди", icon: "🌧", hint: "Земля вокруг становится плодородной" },
  { id: "drought", name: "Засуха", icon: "☀", hint: "Поля высыхают — придут голод и переселения" },
  { id: "plague", name: "Мор", icon: "☠", hint: "Болезнь пойдёт по торговым путям" },
  { id: "genius", name: "Рождение гения", icon: "✨", hint: "В ближайшем городе родится великий человек" },
  { id: "tribe", name: "Новое племя", icon: "🔥", hint: "На этом месте появится новый народ" },
  { id: "quake", name: "Землетрясение", icon: "🌋", hint: "Рушатся стены, гибнут люди" },
  { id: "discord", name: "Раздор", icon: "🗡", hint: "Государство охватывает смута" },
  { id: "dig", name: "Раскопки", icon: "⛏", hint: "Раскопать ближайшие руины" },
];

export function intervene(st: WorldState, tool: Tool, x: number, y: number): string {
  const rng = new Rng(st.rng);
  const near = st.settlements.filter((s) => s.alive).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
  let msg = "";
  const code = ["meteor", "rain", "drought", "plague", "genius", "tribe", "quake", "discord"].indexOf(tool);
  const log = (s = near?.id ?? -1) => logEvent(st, EV.Intervention, { n: code, s, x, y, imp: 4, a: near?.civ ?? -1 });
  const { w, h } = st.map;
  const area = (r: number, fn: (i: number) => void) => { for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (Math.hypot(xx - x, yy - y) <= r) fn(yy * w + xx); };
  switch (tool) {
    case "meteor": {
      const ev = log();
      for (const s of st.settlements) if (s.alive && Math.hypot(s.x - x, s.y - y) <= 3) abandon(st, s, rng, -1, ev.id);
      for (const s of st.settlements) if (s.alive && Math.hypot(s.x - x, s.y - y) <= 7) { s.pop *= 0.7; s.devastation = 1; }
      area(3, (i) => { st.map.fertility[i] = 0.05; });
      msg = "Небесный огонь упал на землю"; break;
    }
    case "rain": log(); area(8, (i) => { st.map.baseFertility[i] = Math.min(1.3, st.map.baseFertility[i]! * 1.3 + 0.05); st.map.fertility[i] = st.map.baseFertility[i]!; }); msg = "Земли стали плодороднее"; break;
    case "drought": log(); area(10, (i) => { st.map.fertility[i] = st.map.baseFertility[i]! * 0.35; }); st.disasters.push({ id: st.nextId++, type: "drought", x, y, r: 10, start: st.year, until: st.year + 8, severity: 0.65, event: st.events.length - 1 }); msg = "Началась засуха"; break;
    case "plague": if (near) { log(); near.pop *= 0.7; near.plague = st.year + 3; st.disasters.push({ id: st.nextId++, type: "plague", x: near.x, y: near.y, r: 1, start: st.year, until: st.year + 4, severity: 0.3, event: st.events.length - 1 }); msg = `Мор в ${near.name}`; } break;
    case "genius": if (near && near.civ >= 0) { log(); const roles = ["scholar", "prophet", "general", "philosopher", "reformer", "explorer"] as const; const ch = newCharacter(st, rng, near.civ, near.id, rng.pick(roles), 20); ch.fame = 6; for (const k of Object.keys(ch.traits) as (keyof typeof ch.traits)[]) if (k !== "cruelty") ch.traits[k] = Math.min(10, ch.traits[k] + 3); ch.deeds.push(logEvent(st, EV.PersonRose, { a: near.civ, b: ch.id, s: near.id, imp: 3 }).id); msg = `В ${near.name} родился гений: ${ch.name}`; } break;
    case "tribe": {
      if (settleScore(st.map, x, y) <= 0.1) { msg = "Здесь не выжить — выберите сушу"; break; }
      const cul = newCulture(st, rng);
      const s = newSettlement(st, rng, x, y, -1, cul.id, 120);
      const c = newCiv(st, rng, s.id, cul.id, Gov.Tribe);
      s.civ = c.id;
      log(s.id);
      logEvent(st, EV.TribeEmerges, { a: c.id, s: s.id, imp: 2 });
      st.territoryDirty = true;
      msg = `Появилось новое племя: ${c.title}`; break;
    }
    case "quake": log(); for (const s of st.settlements) if (s.alive && Math.hypot(s.x - x, s.y - y) <= 5) { s.walls = 0; s.pop *= 0.75; s.devastation = Math.min(1, s.devastation + 0.5); } msg = "Земля содрогнулась"; break;
    case "discord": if (near && near.civ >= 0) { log(); const c = st.civs[near.civ]!; c.stability = Math.max(0, c.stability - 45); msg = `Смута охватила державу ${c.title}`; } break;
    case "dig": {
      const r = st.ruins.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
      if (!r || Math.hypot(r.x - x, r.y - y) > 6) { msg = "Рядом нет руин"; break; }
      const n = excavate(st, r.id);
      const ev = logEvent(st, EV.RuinsFound, { a: -1, d: r.id, x: r.x, y: r.y, imp: 3 });
      void ev;
      msg = `Раскопаны руины ${r.name}: ${n} находок`; break;
    }
  }
  st.rng = rng.state();
  st.territoryDirty = true;
  return msg;
}
