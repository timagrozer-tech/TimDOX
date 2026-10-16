import type { Rng } from "../core/rng";
import { EV, logEvent } from "../history/events";
import { available, has, T, TECHS } from "../simulation/tech";
import { Gov, type Character, type Role, type WorldState } from "../simulation/types";
import { newCharacter } from "../simulation/entities";
import { foundReligion } from "../civilizations/religion";

/**
 * Великие личности. Население считается «оптом», а подробно живут только те, кто попал в историю:
 * правители, полководцы, учёные, пророки, философы, путешественники, реформаторы, тираны, зодчие.
 */
export function age(st: WorldState, c: Character): number { return (c.died ?? st.year) - c.born; }

export function updateCharacters(st: WorldState, rng: Rng): void {
  for (const ch of st.characters) {
    if (ch.died !== null) continue;
    const civ = st.civs[ch.civ];
    const a = st.year - ch.born;
    let p = a < 30 ? 0.004 : a < 45 ? 0.012 : a < 60 ? 0.03 : a < 72 ? 0.07 : 0.16;
    const home = st.settlements[ch.home];
    if (home && home.plague > st.year) p += 0.04;
    let cause = a > 60 ? "в преклонных летах" : "от болезни";
    if (civ && civ.ruler === ch.id && civ.stability < 25 && rng.chance(0.04 + ch.traits.cruelty * 0.004)) { p = 1; cause = "убит заговорщиками"; }
    if (!civ || civ.fallen !== null) p += 0.05;
    if (rng.chance(p)) { die(st, ch, cause); continue; }
    if (!civ || civ.fallen !== null) continue;
    act(st, rng, ch);
  }
}

export function die(st: WorldState, ch: Character, cause: string): void {
  ch.died = st.year;
  ch.deathCause = cause;
  const civ = st.civs[ch.civ];
  if (civ && civ.ruler === ch.id) {
    const ev = logEvent(st, EV.RulerDied, { a: civ.id, b: ch.id, n: st.year - ch.reignStart, s: civ.capital, imp: ch.fame >= 8 ? 3 : 2 });
    ch.deeds.push(ev.id);
    civ.ruler = -1;
  }
  giveEpithet(ch);
}

function giveEpithet(ch: Character): void {
  if (ch.epithet) return;
  const t = ch.traits;
  if (ch.role === "prophet" && ch.fame >= 6) ch.epithet = "Святой";
  else if (ch.role === "ruler" && ch.fame >= 14) ch.epithet = t.martial >= 7 ? "Завоеватель" : "Великий";
  else if (ch.role === "ruler" && t.cruelty >= 9) ch.epithet = "Жестокий";
  else if (ch.role === "ruler" && t.learning >= 8 && ch.fame >= 5) ch.epithet = "Мудрый";
  else if (ch.role === "ruler" && t.stewardship >= 8 && ch.fame >= 5) ch.epithet = "Строитель";
  else if (ch.role === "explorer" && ch.fame >= 4) ch.epithet = "Мореход";
  else if (ch.role === "general" && ch.fame >= 8) ch.epithet = "Непобедимый";
  else if (ch.role === "tyrant") ch.epithet = "Кровавый";
}

/** Что делает личность в этот год */
function act(st: WorldState, rng: Rng, ch: Character): void {
  const civ = st.civs[ch.civ]!;
  const t = ch.traits;
  switch (ch.role) {
    case "scholar": {
      civ.research += t.learning * 0.3;
      if (rng.chance(0.015 + t.learning * 0.003)) {
        const opts = available(civ.techs);
        if (opts.length) {
          const tech = opts.reduce((a, b) => (TECHS[a]!.cost < TECHS[b]!.cost ? a : b));
          civ.research += TECHS[tech]!.cost * 0.35;
          ch.fame += 3;
          const ev = logEvent(st, EV.Deed, { a: civ.id, b: ch.id, n: 0, s: ch.home, imp: 2 });
          ch.deeds.push(ev.id);
        }
      }
      break;
    }
    case "philosopher":
      civ.stability = Math.min(100, civ.stability + 0.3);
      civ.research += t.learning * 0.15;
      if (rng.chance(0.02)) { ch.fame += 3; ch.deeds.push(logEvent(st, EV.Deed, { a: civ.id, b: ch.id, n: rng.chance(0.5) ? 1 : 7, s: ch.home, imp: 2 }).id); }
      break;
    case "reformer":
      if (rng.chance(0.04)) {
        civ.stability = Math.min(100, civ.stability + 12 + t.stewardship);
        ch.fame += 4;
        ch.deeds.push(logEvent(st, EV.Reform, { a: civ.id, b: ch.id, s: ch.home, imp: 3 }).id);
        // реформа устройства: старое царство может стать республикой
        if (civ.gov === Gov.Kingdom && has(civ.techs, T.Philosophy) && civ.traits.trade > 0.55 && rng.chance(0.35)) setGov(st, civ.id, Gov.Republic);
      }
      break;
    case "prophet":
      if (!st.religions.some((r) => r.founder === ch.id) && rng.chance(0.06 + t.zeal * 0.01)) foundReligion(st, rng, ch);
      break;
    case "tyrant":
      civ.stability = Math.max(0, civ.stability - 0.4);
      civ.traits.aggression = Math.min(1, civ.traits.aggression + 0.002);
      break;
    case "ruler":
      if (civ.ruler === ch.id) {
        civ.stability += (t.stewardship - 5) * 0.08 - Math.max(0, t.cruelty - 6) * 0.08;
        if (t.ambition >= 8) civ.traits.aggression = Math.min(1, civ.traits.aggression + 0.001);
        if (rng.chance(0.004) && t.stewardship >= 7) { ch.fame += 2; ch.deeds.push(logEvent(st, EV.Deed, { a: civ.id, b: ch.id, n: 4, s: civ.capital, imp: 2 }).id); }
      }
      break;
    default: break;
  }
}

export function setGov(st: WorldState, civId: number, gov: Gov): void {
  const c = st.civs[civId]!;
  if (c.gov === gov) return;
  c.gov = gov;
  const old = c.title;
  c.title = titleFor(st, civId);
  logEvent(st, EV.GovChange, { a: civId, n: gov, imp: gov === Gov.Empire ? 4 : 3, d: old ? 1 : 0 });
}
function titleFor(st: WorldState, civId: number): string {
  // избегаем кругового импорта entities ↔ characters
  const c = st.civs[civId]!;
  const words = ["племя", "вождество", "царство", "империя", "республика", "теократия", "орда"];
  if (c.gov === Gov.Tribe) return `Племя «${c.name}»`;
  const w = words[c.gov]!;
  return `${w === "царство" || w === "вождество" ? c.adj.replace(/ая$/, "ое") : c.adj} ${w}`;
}

/** У каждого государства есть правитель; смерть правителя — наследник, выборы или смута */
export function ensureRulers(st: WorldState, rng: Rng): void {
  for (const c of st.civs) {
    if (c.fallen !== null) continue;
    let ruler: Character | undefined = st.characters[c.ruler];
    // республика переизбирает правителя
    if (ruler && c.gov === Gov.Republic && st.year - ruler.reignStart >= 10) { c.ruler = -1; ruler = undefined; }
    if (ruler && ruler.died === null) continue;
    const home = c.capital >= 0 ? c.capital : -1;
    // смута: при низкой устойчивости на трон садится полководец или тиран — новая династия
    const usurp = c.stability < 30 && rng.chance(0.4);
    const role: Role = usurp && rng.chance(0.5) ? "tyrant" : "ruler";
    const nr = newCharacter(st, rng, c.id, home, role, rng.int(22, 48));
    if (usurp) { c.dynasty = nr.name.replace(/[аяйь]$/, "") + "иды"; nr.dynasty = c.dynasty; nr.traits.ambition = Math.min(10, nr.traits.ambition + 3); }
    nr.role = role;
    nr.reignStart = st.year;
    c.ruler = nr.id;
    nr.fame += 2;
    const ev = logEvent(st, EV.Crowned, { a: c.id, b: nr.id, s: home, imp: c.cities >= 5 ? 3 : 2, n: usurp ? 1 : 0 });
    nr.deeds.push(ev.id);
    if (usurp && c.cities >= 3) { c.stability -= 10; logEvent(st, EV.CivilWar, { a: c.id, s: home, imp: 3, cause: ev.id }); }
  }
}

/** Рождение великих людей: вероятность зависит от населения, знаний и обстоятельств (войны, кризисы, вера) */
export function spawnGreatPeople(st: WorldState, rng: Rng): void {
  const pace = st.settings.pace;
  for (const c of st.civs) {
    if (c.fallen !== null || c.pop < 300 || c.capital < 0) continue;
    const base = 0.0013 * Math.sqrt(c.pop / 1000) * pace;
    const atWar = Object.values(c.relations).some((r) => r.war >= 0);
    const living = st.characters.filter((x) => x.died === null && x.civ === c.id);
    const count = (r: Role) => living.filter((x) => x.role === r).length;
    const roll = (role: Role, k: number, max = 1): void => {
      if (count(role) >= max || !rng.chance(base * k)) return;
      const cities = st.settlements.filter((s) => s.alive && s.civ === c.id);
      const home = rng.weighted(cities, (s) => s.pop)?.id ?? c.capital;
      const ch = newCharacter(st, rng, c.id, home, role, rng.int(22, 40));
      ch.fame = 3;
      ch.deeds.push(logEvent(st, EV.PersonRose, { a: c.id, b: ch.id, s: home, imp: 2 }).id);
    };
    roll("general", atWar ? 6 : 0.6, 2);
    if (has(c.techs, T.Writing)) roll("scholar", 1.5 + c.traits.science * 2, 2);
    if (has(c.techs, T.Mysticism)) roll("prophet", (c.religion < 0 ? 3 : 0.3) * (0.5 + c.traits.piety) * (c.stability < 40 ? 2 : 1));
    if (has(c.techs, T.Philosophy)) roll("philosopher", 1.2);
    if (c.stability < 45) roll("reformer", 1.5);
    if (has(c.techs, T.Sailing)) roll("explorer", 0.4);
  }
}
