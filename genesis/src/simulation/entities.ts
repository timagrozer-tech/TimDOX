import { Rng } from "../core/rng";
import { adjective, cityName, makeLanguage, peopleName, personName, type Language } from "../core/names";
import type { Character, Civ, Culture, Relation, Role, Settlement, WorldState } from "./types";
import { Gov } from "./types";

/**
 * Создание сущностей мира. Сущности никогда не удаляются (только помечаются погибшими) — поэтому
 * история и энциклопедия могут ссылаться на них по номеру через тысячи лет.
 */
export function rngOf(st: WorldState): Rng { return new Rng(st.rng); }

/** Цвет по номеру (золотое сечение по кругу оттенков) — соседние номера сильно различаются, и цвет не зависит от загрузки сохранения */
export function civColor(rng: Rng, idx: number): [number, number, number] {
  const hue = (idx * 0.61803398875 + 0.13 + rng.range(-0.04, 0.04) + 10) % 1;
  return hslToRgb(hue, rng.range(0.42, 0.6), rng.range(0.48, 0.58));
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

export function newCulture(st: WorldState, rng: Rng, parent = -1): Culture {
  let lang: Language;
  if (parent >= 0 && st.cultures[parent]) lang = driftLanguage(st.cultures[parent]!.lang, rng);
  else lang = makeLanguage(rng);
  const name = peopleName(lang, rng);
  const c: Culture = {
    id: st.cultures.length, name: name + (rng.chance(0.5) ? "ы" : "цы").replace(/^/, ""), adj: adjective(name), lang,
    founded: st.year, parent, color: civColor(rng, st.cultures.length + 7),
    traits: { art: rng.range(0, 1), martial: rng.range(0, 1), sea: rng.range(0, 1), tradition: rng.range(0, 1) },
    extinct: null,
  };
  c.name = fixPeopleName(c.name);
  st.cultures.push(c);
  return c;
}
function fixPeopleName(s: string): string {
  return s.replace(/([аеёиоуыэюя])ы$/, "$1и").replace(/йы$/, "и").replace(/([кгхжшчщ])ы$/, "$1и");
}

/** Язык потомков: часть звуков меняется, окончания смещаются — имена «дочерних» народов похожи, но не те же */
export function driftLanguage(l: Language, rng: Rng): Language {
  const n: Language = JSON.parse(JSON.stringify(l));
  const pool = ["р", "д", "н", "л", "в", "т", "м", "с", "к", "г", "ш", "з", "б", "х", "ф", "ц", "ж", "ч", "п"];
  for (let i = 0; i < 2; i++) n.cons[rng.int(0, n.cons.length - 1)] = rng.pick(pool);
  if (rng.chance(0.5)) n.vows[rng.int(0, n.vows.length - 1)] = rng.pick(["а", "е", "и", "о", "у", "ы", "э", "ю", "я"]);
  n.cityEnd[rng.int(0, n.cityEnd.length - 1)] = rng.pick(["ия", "ов", "ин", "ар", "ель", "ум", "ат", "ея", "ик"]);
  n.personEnd[rng.int(0, n.personEnd.length - 1)] = rng.pick(["ан", "ер", "ис", "ор", "ий", "ут", "ен"]);
  return n;
}

const STATE_WORDS: Record<number, string> = {
  [Gov.Tribe]: "племя", [Gov.Chiefdom]: "вождество", [Gov.Kingdom]: "царство", [Gov.Empire]: "империя",
  [Gov.Republic]: "республика", [Gov.Theocracy]: "теократия", [Gov.Horde]: "орда",
};
/** Название по устройству: «Арденская империя», «Племя ардов» */
export function civTitle(c: Civ, st: WorldState): string {
  if (c.gov === Gov.Tribe) return `Племя «${c.name}»`;
  const w = STATE_WORDS[c.gov] ?? "держава";
  const adj = c.adj;
  // «царство» — средний род
  const a = w === "царство" || w === "вождество" ? adj.replace(/ая$/, "ое") : adj;
  void st;
  return `${a} ${w}`;
}

export function blankRelation(): Relation { return { opinion: 0, war: -1, alliance: false, truceUntil: 0, trade: 0, grievance: 0 }; }
export function rel(st: WorldState, a: number, b: number): Relation {
  const ca = st.civs[a]!;
  let r = ca.relations[b];
  if (!r) { r = blankRelation(); ca.relations[b] = r; }
  return r;
}

export function newSettlement(st: WorldState, rng: Rng, x: number, y: number, civ: number, culture: number, pop: number, origin = -1): Settlement {
  const lang = st.cultures[culture]!.lang;
  let name = cityName(lang, rng);
  for (let k = 0; k < 5 && st.settlements.some((s) => s.name === name); k++) name = cityName(lang, rng);
  const s: Settlement = {
    id: st.settlements.length, name, x, y, civ, founded: st.year, founder: -1, pop, culture, religion: civ >= 0 ? st.civs[civ]!.religion : -1,
    tier: 0, walls: 0, wealth: 0, food: 1, unrest: 0, buildings: 0, alive: true, fell: null, ruin: -1, history: [], origin,
    devastation: 0, plague: 0, wonder: "", cap: 200, land: 0,
  };
  st.settlements.push(s);
  return s;
}

export function newCiv(st: WorldState, rng: Rng, capital: number, culture: number, gov: Gov, parent = -1): Civ {
  const cul = st.cultures[culture]!;
  const base = cityName(cul.lang, rng);
  const name = rng.chance(0.5) ? st.settlements[capital]!.name : base;
  const c: Civ = {
    id: st.civs.length, name, adj: adjective(name), color: civColor(rng, st.civs.length), founded: st.year, fallen: null, capital, culture,
    religion: st.settlements[capital]?.religion ?? -1, gov, techs: [], research: 0, treasury: 0, stability: 70, warWeariness: 0,
    ruler: -1, dynasty: personName(cul.lang, rng).replace(/[аяь]$/, "") + "иды",
    traits: { aggression: rng.range(0.1, 0.9), expansion: rng.range(0.2, 1), trade: rng.range(0.1, 0.9), piety: rng.range(0.1, 0.9), science: rng.range(0.1, 0.9) },
    relations: {}, parent, peakPop: 0, peakCities: 0, events: [], goldenAge: 0, title: "", pop: 0, cities: 0, military: 0,
  };
  c.title = civTitle(c, st);
  st.civs.push(c);
  return c;
}

export function newCharacter(st: WorldState, rng: Rng, civ: number, home: number, role: Role, age = 20): Character {
  const culture = home >= 0 ? st.settlements[home]!.culture : st.civs[civ]?.culture ?? 0;
  const female = rng.chance(role === "general" ? 0.15 : 0.35);
  const t = () => Math.max(0, Math.min(10, Math.round(rng.gauss(5, 2))));
  const ch: Character = {
    id: st.characters.length, name: personName(st.cultures[culture]!.lang, rng, female), female, civ, home, role,
    born: st.year - age, died: null, deathCause: "", fame: 1, deeds: [], epithet: "",
    traits: { martial: t(), diplomacy: t(), stewardship: t(), learning: t(), zeal: t(), cruelty: t(), ambition: t() },
    religion: civ >= 0 ? st.civs[civ]!.religion : -1, dynasty: civ >= 0 ? st.civs[civ]!.dynasty : "", reignStart: st.year,
  };
  // роль подталкивает нужные черты
  const boost: Partial<Record<Role, keyof Character["traits"]>> = { general: "martial", scholar: "learning", prophet: "zeal", philosopher: "learning", reformer: "stewardship", tyrant: "cruelty", explorer: "ambition", artist: "learning" };
  const k = boost[role]; if (k) ch.traits[k] = Math.min(10, ch.traits[k] + 3);
  st.characters.push(ch);
  return ch;
}

export const alive = (st: WorldState, civ: number): boolean => civ >= 0 && !!st.civs[civ] && st.civs[civ]!.fallen === null;
export const citiesOf = (st: WorldState, civ: number): Settlement[] => st.settlements.filter((s) => s.alive && s.civ === civ);
export const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);
