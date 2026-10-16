import type { HistEvent, WorldState } from "../simulation/types";
import { GOV_NAMES, ROLE_NAMES } from "../simulation/types";
import { TECHS, ERAS } from "../simulation/tech";

/** Типы исторических событий. В событии хранятся только числа — текст собирается при показе из живых данных. */
export enum EV {
  Founded, TribeEmerges, Grew, NewCapital, CivFounded, GovChange, Crowned, RulerDied, WarDeclared, Battle,
  Captured, Razed, Peace, Alliance, AllianceBroken, Tech, Era, Disaster, Famine, Plague, Migration, Collapse,
  Secession, CivilWar, Unification, ReligionFounded, Conversion, Schism, PersonRose, Deed, Wonder, RuinsFound,
  Abandoned, GoldenAge, Revolt, CultureFormed, Exploration, Intervention, Colony, Truce, Annexed, Reform, Artifact,
}

export const DISASTER_NAMES: Record<string, string> = {
  drought: "Великая засуха", plague: "Мор", flood: "Великий потоп", earthquake: "Землетрясение",
  volcano: "Извержение вулкана", famine: "Голод", locust: "Нашествие саранчи", winter: "Долгая зима",
};
export const DISASTER_CODES = ["drought", "plague", "flood", "earthquake", "volcano", "famine", "locust", "winter"] as const;

export interface LogArgs { a?: number; b?: number; c?: number; d?: number; s?: number; n?: number; cause?: number; imp?: number; x?: number; y?: number }

export function logEvent(st: WorldState, t: EV, args: LogArgs = {}): HistEvent {
  const s = args.s ?? -1;
  const place = s >= 0 ? st.settlements[s] : undefined;
  const ev: HistEvent = {
    id: st.events.length, y: st.year, t,
    a: args.a ?? -1, b: args.b ?? -1, c: args.c ?? -1, d: args.d ?? -1,
    s, n: args.n ?? 0, cause: args.cause ?? -1, imp: args.imp ?? 1,
    x: args.x ?? place?.x ?? -1, y2: args.y ?? place?.y ?? -1,
  };
  st.events.push(ev);
  if (place) { place.history.push(ev.id); if (place.history.length > 60) place.history.splice(0, place.history.length - 60); }
  for (const cid of [ev.a, ev.b]) {
    if (isCivEvent(t) && cid >= 0 && st.civs[cid] && ev.imp >= 2) { const c = st.civs[cid]!; c.events.push(ev.id); if (c.events.length > 120) c.events.splice(0, c.events.length - 120); }
  }
  return ev;
}

const CIV_EVENTS = new Set<EV>([EV.CivFounded, EV.GovChange, EV.Crowned, EV.RulerDied, EV.WarDeclared, EV.Battle, EV.Captured, EV.Razed, EV.Peace,
  EV.Alliance, EV.AllianceBroken, EV.Tech, EV.Era, EV.Collapse, EV.Secession, EV.CivilWar, EV.Unification, EV.Conversion, EV.Wonder, EV.RuinsFound,
  EV.GoldenAge, EV.Revolt, EV.Exploration, EV.Colony, EV.Truce, EV.Annexed, EV.Reform, EV.NewCapital, EV.Migration]);
const isCivEvent = (t: EV): boolean => CIV_EVENTS.has(t);

// ---------- имена для текста
export const civN = (st: WorldState, id: number): string => (id >= 0 && st.civs[id] ? st.civs[id]!.title : "неизвестный народ");
export const setN = (st: WorldState, id: number): string => (id >= 0 && st.settlements[id] ? st.settlements[id]!.name : "безымянное место");
export const chN = (st: WorldState, id: number): string => {
  const c = id >= 0 ? st.characters[id] : undefined;
  return c ? c.name + (c.epithet ? " " + c.epithet : "") : "неизвестный";
};
export const relN = (st: WorldState, id: number): string => (id >= 0 && st.religions[id] ? st.religions[id]!.name : "старые боги");
export const warN = (st: WorldState, id: number): string => (id >= 0 && st.wars[id] ? st.wars[id]!.name : "война");

const OUTCOMES = ["белый мир", "победа нападавших", "победа защитников", "капитуляция"];
const DEEDS = ["совершает открытие", "пишет великий труд", "объединяет знать", "проводит реформу", "строит дороги", "открывает новые земли", "побеждает непобедимых", "основывает школу"];
export const DEED_TEXT = DEEDS;

/** Иконка события для хроники */
export function eventIcon(t: EV): string {
  switch (t) {
    case EV.Founded: case EV.Colony: return "🏕";
    case EV.TribeEmerges: return "🔥";
    case EV.Grew: return "🏛";
    case EV.CivFounded: case EV.Unification: return "👑";
    case EV.Crowned: return "👑";
    case EV.RulerDied: return "⚱";
    case EV.WarDeclared: return "⚔";
    case EV.Battle: return "🗡";
    case EV.Captured: case EV.Annexed: return "🏴";
    case EV.Razed: return "🔥";
    case EV.Peace: case EV.Truce: return "🕊";
    case EV.Alliance: return "🤝";
    case EV.AllianceBroken: return "💔";
    case EV.Tech: return "💡";
    case EV.Era: return "🌅";
    case EV.Disaster: return "🌋";
    case EV.Famine: return "🥀";
    case EV.Plague: return "☠";
    case EV.Migration: return "🚶";
    case EV.Collapse: return "💥";
    case EV.Secession: case EV.CivilWar: case EV.Revolt: return "✊";
    case EV.ReligionFounded: case EV.Conversion: case EV.Schism: return "✨";
    case EV.PersonRose: case EV.Deed: return "⭐";
    case EV.Wonder: return "🗿";
    case EV.RuinsFound: case EV.Artifact: return "🏺";
    case EV.Abandoned: return "🏚";
    case EV.GoldenAge: return "🌟";
    case EV.CultureFormed: return "🎭";
    case EV.Exploration: return "🧭";
    case EV.Intervention: return "☄";
    case EV.Reform: case EV.GovChange: return "📜";
    default: return "•";
  }
}

const TIER_NAMES = ["стоянка", "деревня", "посёлок", "город", "большой город", "великий город"];
export const tierName = (t: number): string => TIER_NAMES[Math.max(0, Math.min(5, t))]!;

/** Текст события — из реальных данных мира */
export function eventText(st: WorldState, e: HistEvent): string {
  const C = (id: number) => civN(st, id), S = (id: number) => setN(st, id), P = (id: number) => chN(st, id);
  switch (e.t as EV) {
    case EV.Founded: return `Основано поселение ${S(e.s)}${e.a >= 0 ? ` (${C(e.a)})` : ""}${e.b >= 0 ? `. Основатель — ${P(e.b)}` : ""}`;
    case EV.Colony: return `Переселенцы из ${S(e.d)} основывают колонию ${S(e.s)} — ${C(e.a)}`;
    case EV.TribeEmerges: return `У огня в ${S(e.s)} собирается племя — так начинается история народа: ${C(e.a)}`;
    case EV.Grew: return `${S(e.s)} становится: ${tierName(e.n)} (${fmtPop(st.settlements[e.s]?.pop ?? 0)} жителей)`;
    case EV.NewCapital: return `${S(e.s)} — новая столица: ${C(e.a)}`;
    case EV.CivFounded: return e.b >= 0 ? `Возникает новое государство — ${C(e.a)} (выделилось: ${C(e.b)})` : `Возникает государство — ${C(e.a)}, столица ${S(e.s)}`;
    case EV.GovChange: return `${C(e.a)}: новое устройство — ${GOV_NAMES[e.n] ?? "?"}`;
    case EV.Crowned: return `${P(e.b)} становится правителем — ${C(e.a)}`;
    case EV.RulerDied: return `Умирает правитель ${P(e.b)} (${C(e.a)}), правил ${e.n} ${plural(e.n, "год", "года", "лет")}${st.characters[e.b]?.deathCause ? ` — ${st.characters[e.b]!.deathCause}` : ""}`;
    case EV.WarDeclared: return `Начинается ${warN(st, e.c)}: ${C(e.a)} нападает, против — ${C(e.b)}`;
    case EV.Battle: return `Битва у ${S(e.s)}: ${C(e.a)} побеждает${e.d >= 0 ? `, войско ведёт ${P(e.d)}` : ""}. Противник — ${C(e.b)}, павших ${fmtPop(e.n)}`;
    case EV.Captured: return `${C(e.a)} захватывает ${S(e.s)}. Город отнят у противника — ${C(e.b)}`;
    case EV.Razed: return `${S(e.s)} разрушен и сожжён. Разрушитель — ${C(e.a)}`;
    case EV.Peace: return `Мир: ${warN(st, e.c)} окончена — ${OUTCOMES[e.n] ?? "мир"}. Стороны — ${C(e.a)} и ${C(e.b)}`;
    case EV.Truce: return `Перемирие — ${C(e.a)} и ${C(e.b)}`;
    case EV.Alliance: return `Союз заключён: ${C(e.a)} и ${C(e.b)}`;
    case EV.AllianceBroken: return `Союз распался: ${C(e.a)} и ${C(e.b)}`;
    case EV.Tech: return e.imp >= 3 ? `Впервые в мире: ${TECHS[e.n]?.name}. Открытие совершает ${C(e.a)}${e.d >= 0 ? `, учёный ${P(e.d)}` : ""}` : `${C(e.a)} осваивает: ${TECHS[e.n]?.name}`;
    case EV.Era: return `Наступает новая эпоха — ${ERAS[e.n]}. Первым её достигает ${C(e.a)}`;
    case EV.Disaster: return `${DISASTER_NAMES[DISASTER_CODES[e.n] ?? "drought"]} — окрестности ${S(e.s)}`;
    case EV.Famine: return `Голод в ${S(e.s)}: погибает ${fmtPop(e.n)} человек`;
    case EV.Plague: return `Эпидемия в ${S(e.s)} уносит ${fmtPop(e.n)} жизней`;
    case EV.Migration: return `Великое переселение: ${fmtPop(e.n)} человек уходят из ${S(e.s)}${e.d >= 0 ? ` и основывают ${S(e.d)}` : " в поисках новой земли"}`;
    case EV.Collapse: return `Падение державы — ${C(e.a)} перестаёт существовать`;
    case EV.Secession: return `${S(e.s)} отделяется и провозглашает независимость: ${C(e.a)}. Прежняя власть — ${C(e.b)}`;
    case EV.CivilWar: return `Смута и междоусобица — ${C(e.a)}`;
    case EV.Unification: return `${C(e.a)} мирно присоединяет соседей — ${C(e.b)}`;
    case EV.Annexed: return `${C(e.a)} поглощает последние земли — ${C(e.b)}`;
    case EV.ReligionFounded: return `${P(e.b)} проповедует в ${S(e.s)}: рождается ${relN(st, e.a)}`;
    case EV.Conversion: return `${C(e.a)} принимает новую веру — ${relN(st, e.b)}`;
    case EV.Schism: return `Раскол: от веры «${relN(st, e.b)}» отделяется «${relN(st, e.a)}»`;
    case EV.PersonRose: { const c = st.characters[e.b]; return `Прославляется ${P(e.b)} — ${c ? ROLE_NAMES[c.role].toLowerCase() : "человек"} (${C(e.a)})`; }
    case EV.Deed: return `${P(e.b)} ${DEEDS[e.n] ?? "вершит великое"}${e.s >= 0 ? ` в ${S(e.s)}` : ""}`;
    case EV.Wonder: return `В ${S(e.s)} возведено чудо света — ${st.settlements[e.s]?.wonder || "великое строение"}${e.d >= 0 ? `. Зодчий — ${P(e.d)}` : ""}`;
    case EV.RuinsFound: { const r = st.ruins[e.d]; return `Археологи находят руины ${r ? r.name : "древнего города"} (${r ? `${r.from}–${r.to} гг.` : ""}). Раскопки ведёт ${C(e.a)}`; }
    case EV.Artifact: return `Найдена древность: ${artifactShort(st, e.d, e.c)}`;
    case EV.Abandoned: return `${S(e.s)} пустеет — жители ушли`;
    case EV.GoldenAge: return `Золотой век — ${C(e.a)}`;
    case EV.Revolt: return `Восстание в ${S(e.s)} против власти — ${C(e.a)}`;
    case EV.CultureFormed: return `Складывается новый народ со своим языком — ${st.cultures[e.a]?.name ?? "?"}`;
    case EV.Exploration: return `${P(e.b)} открывает новые земли (${C(e.a)})`;
    case EV.Reform: return `${P(e.b)} проводит реформу — ${C(e.a)} крепнет`;
    case EV.Intervention: return `Вмешательство свыше: ${INTERVENTIONS[e.n] ?? "знамение"}${e.s >= 0 ? ` у ${S(e.s)}` : ""}`;
    default: return "Событие";
  }
}

export const INTERVENTIONS = ["небесный огонь", "благодатные дожди", "засуха", "мор", "рождение гения", "новое племя", "землетрясение", "раздор"];

function artifactShort(st: WorldState, ruinId: number, idx: number): string {
  const r = st.ruins[ruinId]; const a = r?.artifacts[idx];
  return a && r ? `${ARTIFACT_NAMES[a.kind]} из руин ${r.name}` : "предмет древности";
}
export const ARTIFACT_NAMES: Record<string, string> = {
  inscription: "Надпись на камне", weapon: "Церемониальный меч", idol: "Идол", crown: "Корона", tablet: "Глиняная табличка",
  coins: "Клад монет", tomb: "Гробница", mosaic: "Мозаика", seal: "Печать", scroll: "Свиток",
};

export function fmtPop(n: number): string {
  n = Math.round(n);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " млн";
  if (n >= 1e4) return Math.round(n / 1000) + " тыс.";
  return n.toLocaleString("ru-RU");
}
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
