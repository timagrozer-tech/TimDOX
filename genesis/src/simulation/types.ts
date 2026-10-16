import type { Language } from "../core/names";
import type { RngState } from "../core/rng";

/** Настройки нового мира (экран «Создать мир») */
export interface WorldSettings {
  name: string;
  seed: string;
  size: "small" | "medium" | "large";
  tribes: number;          // первоначальных племён
  climate: "cold" | "temperate" | "warm";
  resources: number;       // 0.5 … 2 — обилие ресурсов
  disasters: number;       // 0 … 2 — частота катастроф
  startEra: number;        // 0 — каменный век, 1 — бронзовый, 2 — железный
  pace: number;            // 0.5 … 2 — скорость развития
  landRatio: number;       // доля суши 0.25 … 0.6
}

export const SIZES = { small: [160, 104], medium: [224, 144], large: [300, 192] } as const;

/** Карта мира: только типизированные массивы — быстро, компактно и передаётся в поток отрисовки без копирования */
export interface WorldMap {
  w: number;
  h: number;
  elevation: Float32Array;   // 0…1, уровень моря — seaLevel
  seaLevel: number;
  temperature: Float32Array; // 0…1
  moisture: Float32Array;    // 0…1
  biome: Uint8Array;
  river: Uint8Array;         // сила течения 0…255 (0 — нет реки)
  resource: Uint8Array;
  fertility: Float32Array;   // текущая (засухи, разорение снижают)
  baseFertility: Float32Array;
  coast: Uint8Array;         // 1 — суша у воды
}

export enum Gov { Tribe, Chiefdom, Kingdom, Empire, Republic, Theocracy, Horde }
export const GOV_NAMES = ["Племя", "Вождество", "Царство", "Империя", "Республика", "Теократия", "Орда"];

export interface Relation {
  opinion: number;       // -100 … 100
  war: number;           // id войны или -1
  alliance: boolean;
  truceUntil: number;
  trade: number;         // объём торговли за последние годы
  grievance: number;     // историческая память обид (медленно забывается)
}

export interface Civ {
  id: number;
  name: string;
  adj: string;
  color: [number, number, number];
  founded: number;
  fallen: number | null;
  capital: number;          // id поселения
  culture: number;
  religion: number;         // -1 — нет государственной религии
  gov: Gov;
  techs: number[];          // изученные технологии (индексы TECHS)
  research: number;         // очки к текущей технологии
  treasury: number;
  stability: number;        // 0…100
  warWeariness: number;
  ruler: number;            // id персонажа или -1
  dynasty: string;
  traits: { aggression: number; expansion: number; trade: number; piety: number; science: number };
  relations: Record<number, Relation>;
  parent: number;           // из какого государства выделилось (-1)
  peakPop: number;
  peakCities: number;
  events: number[];         // ключевые события (id)
  goldenAge: number;        // год окончания золотого века или 0
  title: string;            // «Арденская империя»
  pop: number;              // кэш: население
  cities: number;           // кэш: число поселений
  military: number;         // кэш: сила армии
}

export interface Settlement {
  id: number;
  name: string;
  x: number;
  y: number;
  civ: number;              // -1 — независимое
  founded: number;
  founder: number;          // id персонажа или -1
  pop: number;
  culture: number;
  religion: number;
  tier: number;             // 0 стоянка … 5 мегаполис
  walls: number;            // 0…3
  wealth: number;
  food: number;             // обеспеченность едой (1 — хватает)
  unrest: number;
  buildings: number;        // битовая маска BLD
  alive: boolean;
  fell: number | null;      // год гибели/запустения
  ruin: number;             // id руин или -1
  history: number[];
  origin: number;           // из какого поселения пришли основатели
  devastation: number;      // разорение войной/катастрофой 0…1
  plague: number;           // год окончания эпидемии или 0
  wonder: string;
  cap: number;              // сколько людей прокормят земли вокруг (пересчитывается с границами)
  land: number;             // клеток во владении
}

export const BLD = { Temple: 1, Market: 2, Library: 4, Harbor: 8, Fortress: 16, Wonder: 32, Academy: 64, Palace: 128 } as const;

export type Role = "ruler" | "general" | "scholar" | "prophet" | "philosopher" | "explorer" | "reformer" | "tyrant" | "artist" | "founder";
export const ROLE_NAMES: Record<Role, string> = {
  ruler: "Правитель", general: "Полководец", scholar: "Учёный", prophet: "Пророк", philosopher: "Философ",
  explorer: "Путешественник", reformer: "Реформатор", tyrant: "Тиран", artist: "Зодчий", founder: "Основатель",
};

export interface Character {
  id: number;
  name: string;
  female: boolean;
  civ: number;
  home: number;             // поселение
  role: Role;
  born: number;
  died: number | null;
  deathCause: string;
  traits: { martial: number; diplomacy: number; stewardship: number; learning: number; zeal: number; cruelty: number; ambition: number };
  fame: number;
  deeds: number[];
  epithet: string;
  religion: number;
  dynasty: string;
  reignStart: number;
}

export interface Culture {
  id: number;
  name: string;
  adj: string;
  lang: Language;
  founded: number;
  parent: number;
  color: [number, number, number];
  traits: { art: number; martial: number; sea: number; tradition: number };
  extinct: number | null;
}

export interface Religion {
  id: number;
  name: string;
  deity: string;
  founder: number;
  holyCity: number;
  founded: number;
  parent: number;
  tenets: string[];
  kind: string;             // «культ», «вера», «учение»
  extinct: number | null;
}

export interface War {
  id: number;
  name: string;
  attacker: number;
  defender: number;
  attackerAllies: number[];
  defenderAllies: number[];
  start: number;
  end: number | null;
  cause: string;
  causeEvent: number;
  score: number;            // >0 — побеждает нападающий
  battles: number[];
  casualties: number;
  captured: number[];       // захваченные поселения
  outcome: string;
  target: number;           // поселение-цель
}

export interface Army {
  id: number;
  civ: number;
  war: number;
  x: number; y: number;      // текущее положение (клетки, дробные)
  fromX: number; fromY: number;
  target: number;            // поселение
  strength: number;
  general: number;
  progress: number;          // 0…1 путь
  state: "march" | "siege" | "return";
  siegeYears: number;
}

export interface Artifact {
  id: number;
  kind: "inscription" | "weapon" | "idol" | "crown" | "tablet" | "coins" | "tomb" | "mosaic" | "seal" | "scroll";
  event: number;             // связанное реальное событие
  character: number;
  religion: number;
  year: number;              // время создания
  found: number | null;
}

export interface Ruin {
  id: number;
  settlement: number;
  name: string;
  x: number; y: number;
  civ: number;
  culture: number;
  religion: number;
  from: number; to: number;
  discovered: number | null;
  discoveredBy: number;
  artifacts: Artifact[];
  tier: number;
  fortress: boolean;
}

export interface HistEvent {
  id: number;
  y: number;
  t: number;                 // тип (EV)
  a: number; b: number; c: number; d: number;  // участники (смысл зависит от типа)
  s: number;                 // поселение-место (-1)
  n: number;                 // число (потери, население…)
  cause: number;             // id события-причины (-1)
  imp: number;               // важность 1…5
  x: number; y2: number;     // место на карте (клетка) для отметки
}

export interface TradeRoute { a: number; b: number; volume: number; since: number; sea: boolean }

export interface Disaster {
  id: number;
  type: "drought" | "plague" | "flood" | "earthquake" | "volcano" | "famine" | "locust" | "winter";
  x: number; y: number; r: number;
  start: number; until: number;
  severity: number;
  event: number;
}

export interface WorldState {
  version: number;
  settings: WorldSettings;
  year: number;
  rng: RngState;
  map: WorldMap;
  owner: Int16Array;          // государство-хозяин клетки (-1)
  road: Uint8Array;           // накатанность дорог 0…255 (медленно зарастает — «древние дороги»)
  settlements: Settlement[];
  civs: Civ[];
  cultures: Culture[];
  religions: Religion[];
  characters: Character[];
  wars: War[];
  armies: Army[];
  ruins: Ruin[];
  events: HistEvent[];
  routes: TradeRoute[];
  disasters: Disaster[];
  era: number;
  nextId: number;             // общий счётчик для армий/артефактов
  territoryDirty: boolean;
  /** пары государств с общей границей: ключ a*4096+b → длина границы (пересчитывается) */
  borders: Record<number, number>;
  stats: { peakPop: number; wars: number; collapses: number };
}
