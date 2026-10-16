import { Rng } from "./rng";

/**
 * Языки культур. У каждой культуры свой набор звуков и слогов, поэтому имена одного народа звучат похоже,
 * а разных — по-разному («Арден», «Кассалея», «Тхуурмок»). Хранится как простые данные — сохраняется с миром.
 */
export interface Language {
  name: string;
  cons: string[];      // согласные
  vows: string[];      // гласные
  shapes: string[];    // слоги: C — согласная, V — гласная
  minSyl: number;
  maxSyl: number;
  cityEnd: string[];
  personEnd: string[];
  femaleEnd: string[];
}

const CONS_SETS = [
  ["р", "д", "н", "л", "в", "т", "м", "с", "к", "г"],
  ["к", "с", "т", "р", "л", "м", "н", "ш", "з", "б"],
  ["т", "х", "р", "м", "к", "г", "з", "д", "н", "у"].filter((c) => c !== "у"),
  ["л", "в", "н", "р", "с", "ф", "т", "м", "д", "й"],
  ["б", "г", "д", "з", "р", "в", "н", "к", "ж", "м"],
  ["с", "ш", "т", "н", "р", "к", "п", "л", "м", "ц"],
];
const VOW_SETS = [
  ["а", "е", "и", "о"], ["а", "о", "у", "ы"], ["а", "э", "и", "о", "у"], ["е", "и", "а", "я"], ["о", "у", "а", "ё"], ["а", "и", "е", "ю"],
];
const SHAPES = [["CV", "CVC", "V", "CV"], ["CV", "CVC", "CCV"], ["CVC", "VC", "CV"], ["CV", "CV", "CVC", "CVV"]];
const CITY_END = [["ен", "ор", "ан", "ия"], ["град", "ск", "ов", "ец"], ["мир", "тар", "ум", "ель"], ["ос", "ея", "ара", "он"], ["хан", "даш", "ур", "кент"], ["ина", "ло", "вель", "ис"]];
const PERSON_END = [["ар", "ан", "ей", "ор"], ["ус", "ий", "он", "ен"], ["ад", "им", "ут", "ак"], ["иан", "ел", "ор", "ир"]];
const FEMALE_END = [["а", "ия", "ея"], ["ина", "эль", "а"], ["ара", "ия", "уна"], ["ея", "ана", "ис"]];

export function makeLanguage(rng: Rng): Language {
  const lang: Language = {
    name: "",
    cons: rng.pick(CONS_SETS).slice(),
    vows: rng.pick(VOW_SETS).slice(),
    shapes: rng.pick(SHAPES).slice(),
    minSyl: rng.int(1, 2),
    maxSyl: rng.int(2, 3),
    cityEnd: rng.pick(CITY_END).slice(),
    personEnd: rng.pick(PERSON_END).slice(),
    femaleEnd: rng.pick(FEMALE_END).slice(),
  };
  // у каждого языка немного своих звуков
  if (rng.chance(0.4)) lang.cons.push(rng.pick(["х", "ч", "щ", "ф", "ц", "ж"]));
  if (rng.chance(0.3)) lang.vows.push(rng.pick(["э", "ю", "я", "ы"]));
  lang.name = cap(word(lang, rng, 2, 2));
  return lang;
}

function syllable(l: Language, rng: Rng): string {
  let s = "";
  for (const ch of rng.pick(l.shapes)) s += ch === "C" ? rng.pick(l.cons) : rng.pick(l.vows);
  return s;
}
function word(l: Language, rng: Rng, min = l.minSyl, max = l.maxSyl): string {
  const n = rng.int(min, max);
  let w = "";
  for (let i = 0; i < n; i++) w += syllable(l, rng);
  return tidy(w);
}
/** Убираем неудобочитаемые сочетания */
function tidy(w: string): string {
  return w
    .replace(/([бвгджзйклмнпрстфхцчшщ])\1+/g, "$1")
    .replace(/([бвгджзйклмнпрстфхцчшщ]{2})[бвгджзйклмнпрстфхцчшщ]+/g, "$1")
    .replace(/([аеёиоуыэюя])\1+/g, "$1")
    .replace(/^й/, "и")
    .replace(/й([бвгджзклмнпрстфхцчшщ])/g, "и$1")
    .replace(/[ыъь]+$/, "")
    .replace(/^ы/, "а")
    .replace(/([аеёиоуыэюя])([аеёиоуыэюя])[аеёиоуыэюя]+/g, "$1$2")
    .replace(/(ао|оа|уа|ыа|эа|ыо|эо|уо|ои[аео])/g, (m) => m[0]!)
    .replace(/^([бвгджзйклмнпрстфхцчшщ])([бвгджзйклмнпрстфхцчшщ])([бвгджзйклмнпрстфхцчшщ])/, "$1$3");
}
export const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function cityName(l: Language, rng: Rng): string {
  for (let k = 0; k < 6; k++) {
    const base = word(l, rng, 1, 2);
    const n = cap(tidy(rng.chance(0.65) ? base + rng.pick(l.cityEnd) : base));
    if (n.length >= 4 && n.length <= 11 && /[аеёиоуыэюя]/.test(n)) return n;
  }
  return cap(tidy(word(l, rng, 2, 2) + rng.pick(l.cityEnd)));
}
export function personName(l: Language, rng: Rng, female = false): string {
  for (let k = 0; k < 6; k++) {
    const n = cap(tidy(word(l, rng, 1, 2) + rng.pick(female ? l.femaleEnd : l.personEnd)));
    if (n.length >= 4 && n.length <= 10) return n;
  }
  return cap(tidy(word(l, rng, 1, 1) + rng.pick(female ? l.femaleEnd : l.personEnd)));
}
export function godName(l: Language, rng: Rng): string { return cap(tidy(word(l, rng, 2, 3))); }
export function peopleName(l: Language, rng: Rng): string { return cap(word(l, rng, 2, 2)); }

/** Прилагательное от названия: «Арден» → «Арденская» */
export function adjective(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/(ия|ея|ья)$/, "и").replace(/[аеёиоуыэюяй]$/, "");
  if (/(ск|цк)$/.test(s)) s = s.slice(0, -2);
  const suffix = /[кгх]$/.test(s) ? "ская" : /[жшчщц]$/.test(s) ? "ская" : "ская";
  return cap(s + suffix);
}
/** Прилагательное мужского рода (для «… народ») */
export const adjectiveM = (name: string): string => adjective(name).replace(/ая$/, "ий");

const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
export function roman(n: number): string {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}
