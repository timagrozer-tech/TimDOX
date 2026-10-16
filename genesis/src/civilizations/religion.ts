import type { Rng } from "../core/rng";
import { godName } from "../core/names";
import { EV, logEvent } from "../history/events";
import { BLD, type Character, type Religion, type WorldState } from "../simulation/types";
import { newCharacter, rel } from "../simulation/entities";

const TENETS = ["почитание предков", "культ солнца", "священный огонь", "небесные звёзды", "милосердие", "аскеза", "священная война",
  "единый бог", "круговорот жизни", "духи леса", "владыка моря", "земля-мать", "очищение водой", "жертвоприношения", "мудрость книг", "тайные мистерии"];
const KINDS = ["Культ", "Вера", "Учение", "Путь", "Завет"];

/** Пророк основывает веру. Она получает имя божества на языке народа и пару заповедей. */
export function foundReligion(st: WorldState, rng: Rng, prophet: Character, parent = -1): Religion | null {
  const civ = st.civs[prophet.civ];
  const home = st.settlements[prophet.home];
  if (!civ || !home || !home.alive) return null;
  if (st.religions.some((r) => r.founder === prophet.id)) return null;      // один пророк — одна вера
  if (parent < 0 && civ.religion >= 0 && rng.chance(0.85)) return null;   // у народа уже есть вера
  const lang = st.cultures[home.culture]!.lang;
  const deity = godName(lang, rng);
  const kind = rng.pick(KINDS);
  const r: Religion = {
    id: st.religions.length, deity, founder: prophet.id, holyCity: home.id, founded: st.year, parent,
    tenets: rng.shuffle(TENETS.slice()).slice(0, 3), kind,
    name: kind === "Учение" || kind === "Путь" ? `${kind} ${prophet.name}` : `${kind} ${deity}`,
    extinct: null,
  };
  st.religions.push(r);
  prophet.religion = r.id;
  prophet.fame += 6;
  home.religion = r.id;
  home.buildings |= BLD.Temple;
  const ev = logEvent(st, parent >= 0 ? EV.Schism : EV.ReligionFounded, parent >= 0 ? { a: r.id, b: parent, s: home.id, imp: 3 } : { a: r.id, b: prophet.id, s: home.id, imp: 4 });
  prophet.deeds.push(ev.id);
  if (civ.religion < 0 || rng.chance(civ.traits.piety)) convertCiv(st, civ.id, r.id, ev.id);
  prophet.role = "prophet";
  return r;
}

export function convertCiv(st: WorldState, civId: number, relId: number, cause = -1): void {
  const c = st.civs[civId]!;
  if (c.religion === relId) return;
  const old = c.religion;
  c.religion = relId;
  logEvent(st, EV.Conversion, { a: civId, b: relId, cause, imp: 2 });
  c.stability -= old >= 0 ? 8 : 2;
}

/** Распространение: государственная вера, торговля и соседство; смена веры государства; расколы */
export function spreadReligions(st: WorldState, rng: Rng): void {
  for (const s of st.settlements) {
    if (!s.alive) continue;
    const c = st.civs[s.civ];
    if (c && c.religion >= 0 && s.religion !== c.religion && rng.chance(0.03 + c.traits.piety * 0.04)) s.religion = c.religion;
  }
  // торговые пути несут веру
  for (const r of st.routes) {
    const a = st.settlements[r.a]!, b = st.settlements[r.b]!;
    if (a.religion >= 0 && b.religion < 0 && rng.chance(0.05)) b.religion = a.religion;
    else if (b.religion >= 0 && a.religion < 0 && rng.chance(0.05)) a.religion = b.religion;
  }
  // государство принимает веру большинства подданных
  const followers: Record<number, Record<number, number>> = {};
  for (const s of st.settlements) if (s.alive && s.religion >= 0) {
    const m = (followers[s.civ] ??= {}); m[s.religion] = (m[s.religion] ?? 0) + s.pop;
  }
  for (const c of st.civs) {
    if (c.fallen !== null) continue;
    const m = followers[c.id]; if (!m) continue;
    let top = -1, tv = 0, total = 0;
    for (const [k, v] of Object.entries(m)) { total += v; if (v > tv) { tv = v; top = +k; } }
    if (top >= 0 && top !== c.religion && tv > total * 0.6 && rng.chance(0.06)) convertCiv(st, c.id, top);
  }
  // раскол: старая вера, раскинувшаяся по многим государствам
  for (const r of st.religions) {
    if (r.extinct !== null || st.year - r.founded < 300) continue;
    const civs = st.civs.filter((c) => c.fallen === null && c.religion === r.id);
    if (civs.length >= 3 && rng.chance(0.004)) {
      const c = rng.pick(civs);
      const cities = st.settlements.filter((s) => s.alive && s.civ === c.id);
      if (!cities.length) continue;
      const home = rng.pick(cities);
      const prophet = st.characters.find((x) => x.died === null && x.civ === c.id && x.role === "prophet")
        ?? newCharacter(st, rng, c.id, home.id, "prophet", rng.int(25, 45));
      prophet.home = home.id;
      const nr = foundReligion(st, rng, prophet, r.id);
      if (nr) for (const o of civs) if (o.id !== c.id) { rel(st, o.id, c.id).opinion -= 25; rel(st, c.id, o.id).opinion -= 25; }
    }
  }
  // вымершие веры
  const alive = new Set<number>();
  for (const s of st.settlements) if (s.alive && s.religion >= 0) alive.add(s.religion);
  for (const r of st.religions) if (r.extinct === null && !alive.has(r.id) && st.year - r.founded > 5) r.extinct = st.year;
}
