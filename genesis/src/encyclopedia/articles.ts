import { ERAS, TECHS, civEra } from "../simulation/tech";
import { GOV_NAMES, ROLE_NAMES, type HistEvent, type WorldState } from "../simulation/types";
import { BIOMES } from "../world/biomes";
import { RESOURCES } from "../world/resources";
import { eventText, eventIcon, fmtPop, plural, tierName, ARTIFACT_NAMES, chN, civN, relN, EV } from "../history/events";
import { canBeLegend, legendOf } from "../history/legends";
import { age } from "../characters/characters";

/**
 * Живая энциклопедия: статьи собираются из данных симуляции при каждом открытии — поэтому они всегда
 * актуальны. Ссылки ведут на связанные государства, города, людей, войны, веры, народы и руины.
 */
export type Kind = "civ" | "city" | "person" | "war" | "religion" | "culture" | "ruin" | "era" | "event";
export interface Link { kind: Kind; id: number; name: string }
export interface Article {
  kind: Kind; id: number; title: string; subtitle: string;
  facts: [string, string][];
  text: string[];
  timeline: { y: number; text: string; icon: string; id: number }[];
  links: Link[];
  legend?: { stage: string; text: string | null; forgotten: boolean; keepers: string[]; fact: string; rediscovered: boolean };
  color?: [number, number, number];
}

const years = (a: number, b: number | null, now: number): string => `${a} — ${b ?? "наши дни"}${b === null ? ` (${now - a} ${plural(now - a, "год", "года", "лет")})` : ` (${b - a} ${plural(b - a, "год", "года", "лет")})`}`;
const tl = (st: WorldState, ids: number[], max = 40) => ids.slice(-max).map((id) => st.events[id]!).filter(Boolean).map((e) => ({ y: e.y, text: eventText(st, e), icon: eventIcon(e.t), id: e.id }));

export function article(st: WorldState, kind: Kind, id: number): Article | null {
  switch (kind) {
    case "civ": return civArticle(st, id);
    case "city": return cityArticle(st, id);
    case "person": return personArticle(st, id);
    case "war": return warArticle(st, id);
    case "religion": return religionArticle(st, id);
    case "culture": return cultureArticle(st, id);
    case "ruin": return ruinArticle(st, id);
    case "era": return eraArticle(st, id);
    case "event": return eventArticle(st, id);
    default: return null;
  }
}

function civArticle(st: WorldState, id: number): Article | null {
  const c = st.civs[id]; if (!c) return null;
  const cul = st.cultures[c.culture]!;
  const cap = st.settlements[c.capital];
  const ruler = st.characters[c.ruler];
  const cities = st.settlements.filter((s) => s.civ === id && s.alive);
  const wars = st.wars.filter((w) => w.attacker === id || w.defender === id || w.attackerAllies.includes(id) || w.defenderAllies.includes(id));
  const rulers = st.characters.filter((x) => x.civ === id && (x.role === "ruler" || x.role === "tyrant") && st.events.some((e) => e.t === EV.Crowned && e.b === x.id));
  const great = st.characters.filter((x) => x.civ === id && x.fame >= 5 && x.role !== "ruler").sort((a, b) => b.fame - a.fame).slice(0, 8);
  const facts: [string, string][] = [
    ["Существует", years(c.founded, c.fallen, st.year)],
    ["Устройство", GOV_NAMES[c.gov]!],
    ["Столица", cap ? cap.name : "—"],
    ["Народ", cul.name],
    ["Вера", relN(st, c.religion)],
  ];
  if (c.fallen === null) {
    facts.push(["Население", fmtPop(c.pop)], ["Поселений", String(c.cities)], ["Эпоха", ERAS[civEra(c.techs)]!], ["Устойчивость", Math.round(c.stability) + "%"]);
    if (ruler) facts.push(["Правитель", `${chN(st, ruler.id)} (с ${ruler.reignStart} г.)`]);
  } else facts.push(["В расцвете", `${fmtPop(c.peakPop)} жителей, ${c.peakCities} ${plural(c.peakCities, "поселение", "поселения", "поселений")}`]);
  const text: string[] = [];
  const parent = st.civs[c.parent];
  text.push(`${c.title} — ${c.fallen === null ? "государство" : "исчезнувшее государство"} народа ${cul.name}${parent ? `, выделившееся из державы «${parent.title}»` : ""}. ${cap ? `Столица — ${cap.name}.` : ""}`);
  const temper = c.traits.aggression > 0.7 ? "воинственный" : c.traits.trade > 0.7 ? "торговый" : c.traits.piety > 0.7 ? "набожный" : c.traits.science > 0.7 ? "любознательный" : "осторожный";
  text.push(`Характер народа — ${temper}. ${c.techs.length ? `Знания: ${c.techs.map((t) => TECHS[t]!.name).slice(-6).join(", ")}${c.techs.length > 6 ? " и другие" : ""}.` : "Письма и ремёсел ещё нет."}`);
  if (wars.length) {
    const won = wars.filter((w) => w.end !== null && ((w.attacker === id && w.outcome.includes("нападав")) || (w.defender === id && w.outcome.includes("защитник")))).length;
    text.push(`Войн в истории: ${wars.length}, из них выиграно ${won}. ${wars.filter((w) => w.end === null).length ? "Сейчас идёт война." : ""}`);
  }
  if (c.goldenAge > st.year) text.push("Сейчас переживает золотой век.");
  if (c.fallen !== null) {
    const ruins = st.ruins.filter((r) => r.civ === id);
    text.push(`Держава пала в ${c.fallen} году. ${ruins.length ? `От неё остались руины: ${ruins.slice(0, 5).map((r) => r.name).join(", ")}.` : ""}`);
  }
  const links: Link[] = [
    ...(cap ? [{ kind: "city" as Kind, id: cap.id, name: cap.name }] : []),
    { kind: "culture", id: cul.id, name: cul.name },
    ...(c.religion >= 0 ? [{ kind: "religion" as Kind, id: c.religion, name: relN(st, c.religion) }] : []),
    ...(parent ? [{ kind: "civ" as Kind, id: parent.id, name: parent.title }] : []),
    ...st.civs.filter((o) => o.parent === id).slice(0, 6).map((o) => ({ kind: "civ" as Kind, id: o.id, name: o.title })),
    ...rulers.slice(-8).map((r) => ({ kind: "person" as Kind, id: r.id, name: chN(st, r.id) })),
    ...great.map((g) => ({ kind: "person" as Kind, id: g.id, name: `${chN(st, g.id)} — ${ROLE_NAMES[g.role].toLowerCase()}` })),
    ...wars.slice(-8).map((w) => ({ kind: "war" as Kind, id: w.id, name: w.name })),
    ...cities.sort((a, b) => b.pop - a.pop).slice(0, 8).map((s) => ({ kind: "city" as Kind, id: s.id, name: s.name })),
  ];
  return { kind: "civ", id, title: c.title, subtitle: c.fallen === null ? `${GOV_NAMES[c.gov]} · ${fmtPop(c.pop)} жителей` : `Пало в ${c.fallen} г.`, facts, text, timeline: tl(st, c.events), links, color: c.color };
}

function cityArticle(st: WorldState, id: number): Article | null {
  const s = st.settlements[id]; if (!s) return null;
  const c = st.civs[s.civ];
  const i = s.y * st.map.w + s.x;
  const facts: [string, string][] = [
    ["Основан", `${s.founded} г.${st.characters[s.founder] ? ` — ${chN(st, s.founder)}` : ""}`],
    [s.alive ? "Сейчас" : "Погиб", s.alive ? `${tierName(s.tier)}, ${fmtPop(s.pop)} жителей` : `${s.fell} г.`],
    ["Принадлежит", c ? c.title : "—"],
    ["Народ", st.cultures[s.culture]?.name ?? "—"],
    ["Вера", relN(st, s.religion)],
    ["Местность", BIOMES[st.map.biome[i]!]!.name + (st.map.river[i] ? ", у реки" : "") + (st.map.coast[i] ? ", у моря" : "")],
  ];
  const res = new Set<string>();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const r = st.map.resource[(s.y + dy) * st.map.w + s.x + dx]; if (r) res.add(RESOURCES[r]!.name); }
  if (res.size) facts.push(["Богатства округи", [...res].join(", ")]);
  if (s.walls) facts.push(["Укрепления", ["", "частокол", "каменные стены", "крепость"][s.walls]!]);
  if (s.wonder) facts.push(["Чудо света", s.wonder]);
  const text = [`${s.name} — ${s.alive ? tierName(s.tier) : "погибшее поселение"}${c ? `, ${c.capital === id && s.alive ? "столица" : "владение"} державы «${c.title}»` : ""}.`];
  const origin = st.settlements[s.origin];
  if (origin) text.push(`Основан выходцами из ${origin.name}.`);
  const onRuins = st.ruins.find((r) => r.settlement !== id && Math.abs(r.x - s.x) + Math.abs(r.y - s.y) <= 1 && r.to <= s.founded);
  if (onRuins) text.push(`Построен на месте древнего города ${onRuins.name} (${onRuins.from}–${onRuins.to} гг.).`);
  if (s.plague > st.year) text.push("Сейчас здесь свирепствует мор.");
  const links: Link[] = [...(c ? [{ kind: "civ" as Kind, id: c.id, name: c.title }] : []), ...(s.ruin >= 0 ? [{ kind: "ruin" as Kind, id: s.ruin, name: `Руины ${s.name}` }] : []),
    ...(origin ? [{ kind: "city" as Kind, id: origin.id, name: origin.name }] : []), ...(onRuins ? [{ kind: "ruin" as Kind, id: onRuins.id, name: `Руины ${onRuins.name}` }] : [])];
  return { kind: "city", id, title: s.name, subtitle: s.alive ? `${tierName(s.tier)} · ${fmtPop(s.pop)}` : `руины с ${s.fell} г.`, facts, text, timeline: tl(st, s.history), links, color: c?.color };
}

function personArticle(st: WorldState, id: number): Article | null {
  const p = st.characters[id]; if (!p) return null;
  const c = st.civs[p.civ];
  const t = p.traits;
  const best = (Object.entries(t) as [string, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const TR: Record<string, string> = { martial: "воинское искусство", diplomacy: "дипломатия", stewardship: "управление", learning: "учёность", zeal: "вера", cruelty: "жестокость", ambition: "честолюбие" };
  const facts: [string, string][] = [
    ["Годы жизни", `${p.born} — ${p.died ?? "жив"} (${age(st, p)} ${plural(age(st, p), "год", "года", "лет")})`],
    ["Роль", ROLE_NAMES[p.role]],
    ["Народ", c ? c.title : "—"],
    ["Сильные стороны", best.map(([k]) => TR[k]).join(", ")],
    ["Слава", "★".repeat(Math.min(5, Math.ceil(p.fame / 4)))],
  ];
  if (p.died !== null && p.deathCause) facts.push(["Смерть", p.deathCause]);
  if (p.dynasty && (p.role === "ruler" || p.role === "tyrant")) facts.push(["Династия", p.dynasty]);
  const text = [`${chN(st, id)} — ${ROLE_NAMES[p.role].toLowerCase()}${c ? ` (${c.title})` : ""}${st.settlements[p.home] ? `, родом из ${st.settlements[p.home]!.name}` : ""}.`];
  if (t.cruelty >= 8) text.push("Современники боялись его жестокости.");
  if (t.learning >= 8) text.push("Славился учёностью.");
  if (t.martial >= 8) text.push("Прирождённый воин.");
  const mainDeed = p.deeds.map((d) => st.events[d]!).filter((e) => e && canBeLegend(e)).sort((a, b) => b.imp - a.imp)[0];
  const res: Article = { kind: "person", id, title: chN(st, id), subtitle: `${ROLE_NAMES[p.role]} · ${p.born}–${p.died ?? "…"}`, facts, text, timeline: tl(st, p.deeds), links: c ? [{ kind: "civ", id: c.id, name: c.title }] : [] };
  if (p.religion >= 0) res.links.push({ kind: "religion", id: p.religion, name: relN(st, p.religion) });
  if (mainDeed) attachLegend(st, res, mainDeed);
  return res;
}

function warArticle(st: WorldState, id: number): Article | null {
  const w = st.wars[id]; if (!w) return null;
  const facts: [string, string][] = [
    ["Годы", years(w.start, w.end, st.year)], ["Нападающий", civN(st, w.attacker)], ["Защищающийся", civN(st, w.defender)],
    ["Причина", w.cause], ["Итог", w.end === null ? "идёт" : w.outcome], ["Битв", String(w.battles.length)], ["Погибших", fmtPop(w.casualties)],
  ];
  if (w.defenderAllies.length) facts.push(["Союзники защитников", w.defenderAllies.map((a) => civN(st, a)).join(", ")]);
  if (w.captured.length) facts.push(["Захвачено", w.captured.map((s) => st.settlements[s]?.name).join(", ")]);
  const text = [`${w.name} — война, которую начал ${civN(st, w.attacker)} против народа «${civN(st, w.defender)}». Причина — ${w.cause}.`];
  const cause = st.events[w.causeEvent];
  if (cause) text.push(`Корни конфликта: ${eventText(st, cause)} (${cause.y} г.).`);
  const ids = st.events.filter((e) => e.c === id && (e.t === EV.WarDeclared || e.t === EV.Battle || e.t === EV.Captured || e.t === EV.Razed || e.t === EV.Peace)).map((e) => e.id);
  return { kind: "war", id, title: w.name, subtitle: `${w.start}–${w.end ?? "…"}`, facts, text, timeline: tl(st, ids, 60),
    links: [{ kind: "civ", id: w.attacker, name: civN(st, w.attacker) }, { kind: "civ", id: w.defender, name: civN(st, w.defender) }, ...(cause ? [{ kind: "event" as Kind, id: cause.id, name: "Причина войны" }] : [])] };
}

function religionArticle(st: WorldState, id: number): Article | null {
  const r = st.religions[id]; if (!r) return null;
  const civs = st.civs.filter((c) => c.fallen === null && c.religion === id);
  let followers = 0; for (const s of st.settlements) if (s.alive && s.religion === id) followers += s.pop;
  const facts: [string, string][] = [["Основана", `${r.founded} г.`], ["Основатель", chN(st, r.founder)], ["Божество", r.deity], ["Святой город", st.settlements[r.holyCity]?.name ?? "—"],
    ["Заповеди", r.tenets.join(", ")], [r.extinct === null ? "Верующих" : "Забыта", r.extinct === null ? fmtPop(followers) : `${r.extinct} г.`]];
  if (r.parent >= 0) facts.push(["Откололась от", relN(st, r.parent)]);
  const text = [`${r.name} — ${r.extinct === null ? "" : "забытая "}вера, которую основал ${chN(st, r.founder)}. Её последователи почитают ${r.deity}: ${r.tenets.join(", ")}.`];
  if (civs.length) text.push(`Государственная вера: ${civs.map((c) => c.title).join(", ")}.`);
  if (r.extinct !== null) text.push("Её храмы разрушены, а имя бога помнят только камни руин.");
  const ids = st.events.filter((e) => (e.t === EV.ReligionFounded && e.a === id) || (e.t === EV.Conversion && e.b === id) || (e.t === EV.Schism && (e.a === id || e.b === id))).map((e) => e.id);
  const res: Article = { kind: "religion", id, title: r.name, subtitle: r.extinct === null ? `${fmtPop(followers)} верующих` : "забытая вера", facts, text, timeline: tl(st, ids),
    links: [{ kind: "person", id: r.founder, name: chN(st, r.founder) }, ...civs.map((c) => ({ kind: "civ" as Kind, id: c.id, name: c.title })), ...(st.settlements[r.holyCity] ? [{ kind: "city" as Kind, id: r.holyCity, name: st.settlements[r.holyCity]!.name }] : [])] };
  const fe = st.events.find((e) => e.t === EV.ReligionFounded && e.a === id);
  if (fe) attachLegend(st, res, fe);
  return res;
}

function cultureArticle(st: WorldState, id: number): Article | null {
  const c = st.cultures[id]; if (!c) return null;
  let pop = 0; for (const s of st.settlements) if (s.alive && s.culture === id) pop += s.pop;
  const civs = st.civs.filter((x) => x.culture === id);
  const sample = st.settlements.filter((s) => s.culture === id).slice(0, 6).map((s) => s.name);
  const facts: [string, string][] = [["Сложился", `${c.founded} г.`], ["Язык", c.lang.name + " (примеры имён: " + sample.join(", ") + ")"], [c.extinct === null ? "Численность" : "Исчез", c.extinct === null ? fmtPop(pop) : `${c.extinct} г.`]];
  if (c.parent >= 0) facts.push(["Предки", st.cultures[c.parent]!.name]);
  const t = c.traits;
  const text = [`${c.name} — народ${c.parent >= 0 ? `, отделившийся от народа ${st.cultures[c.parent]!.name}` : ""}. ${t.sea > 0.7 ? "Мореходы. " : ""}${t.martial > 0.7 ? "Славятся воинами. " : ""}${t.art > 0.7 ? "Ценят искусство и красоту. " : ""}${t.tradition > 0.7 ? "Крепко держатся обычаев предков." : ""}`];
  return { kind: "culture", id, title: c.name, subtitle: c.extinct === null ? fmtPop(pop) : "исчезнувший народ", facts, text, timeline: [],
    links: [...civs.slice(-10).map((x) => ({ kind: "civ" as Kind, id: x.id, name: x.title })), ...st.cultures.filter((x) => x.parent === id).map((x) => ({ kind: "culture" as Kind, id: x.id, name: x.name }))], color: c.color };
}

function ruinArticle(st: WorldState, id: number): Article | null {
  const r = st.ruins[id]; if (!r) return null;
  const facts: [string, string][] = [["Город существовал", `${r.from} — ${r.to} гг.`], ["Строители", st.cultures[r.culture]?.name ?? "неизвестны"],
    ["Открыты", r.discovered !== null ? `${r.discovered} г.${r.discoveredBy >= 0 ? ` (${civN(st, r.discoveredBy)})` : ""}` : "ещё не найдены"]];
  const found = r.artifacts.filter((a) => a.found !== null);
  const text: string[] = [`Руины ${r.name}${r.fortress ? " — остатки мощной крепости" : ""}. ${r.discovered === null ? "Пока никто не знает, что под этими холмами лежит древний город." : ""}`];
  for (const a of found) {
    const e = st.events[a.event];
    const rel = st.religions[a.religion];
    let story = `${ARTIFACT_NAMES[a.kind]} (найден в ${a.found} г.)`;
    if (e) story += `: рассказывает, что в ${e.y} году — ${eventText(st, e).replace(/^./, (x) => x.toLowerCase())}`;
    else if (rel) story += `: изображение божества ${rel.deity}${rel.extinct !== null ? " — веры, о которой давно забыли" : ""}`;
    text.push(story + ".");
  }
  if (r.discovered !== null && found.length < r.artifacts.length) text.push(`В земле ещё ${r.artifacts.length - found.length} ${plural(r.artifacts.length - found.length, "находка", "находки", "находок")}.`);
  return { kind: "ruin", id, title: `Руины ${r.name}`, subtitle: `${r.from}–${r.to}`, facts, text, timeline: [],
    links: [{ kind: "city", id: r.settlement, name: r.name }, ...(st.civs[r.civ] ? [{ kind: "civ" as Kind, id: r.civ, name: st.civs[r.civ]!.title }] : []), ...(r.religion >= 0 ? [{ kind: "religion" as Kind, id: r.religion, name: relN(st, r.religion) }] : [])] };
}

function eraArticle(st: WorldState, id: number): Article | null {
  if (!ERAS[id]) return null;
  const start = st.events.find((e) => e.t === EV.Era && e.n === id);
  const next = st.events.find((e) => e.t === EV.Era && e.n === id + 1);
  const from = start ? start.y : id === 0 ? 0 : null;
  if (from === null) return { kind: "era", id, title: ERAS[id]!, subtitle: "ещё не наступила", facts: [], text: ["Эта эпоха ещё впереди."], timeline: [], links: [] };
  const to = next ? next.y : st.year;
  const big = st.events.filter((e) => e.y >= from && e.y < to && e.imp >= 4).slice(-40).map((e) => e.id);
  return { kind: "era", id, title: ERAS[id]!, subtitle: `${from} — ${next ? next.y : "наши дни"}`, facts: [["Начало", `${from} г.`], ["Первопроходец", start ? civN(st, start.a) : "—"]],
    text: [`${ERAS[id]} — с ${from} года. Главные события эпохи:`], timeline: tl(st, big, 40), links: [] };
}

function eventArticle(st: WorldState, id: number): Article | null {
  const e = st.events[id]; if (!e) return null;
  const chain: HistEvent[] = [];
  let p: HistEvent | undefined = st.events[e.cause];
  while (p && chain.length < 6) { chain.unshift(p); p = st.events[p.cause]; }
  const consequences = st.events.filter((x) => x.cause === id).slice(0, 8);
  const res: Article = { kind: "event", id, title: `${e.y} год`, subtitle: eventIcon(e.t) + " событие", facts: [], text: [eventText(st, e)],
    timeline: [...chain.map((x) => ({ y: x.y, text: "Причина: " + eventText(st, x), icon: "↳", id: x.id })), ...consequences.map((x) => ({ y: x.y, text: "Следствие: " + eventText(st, x), icon: "→", id: x.id }))], links: [] };
  if (st.civs[e.a]) res.links.push({ kind: "civ", id: e.a, name: civN(st, e.a) });
  if (st.settlements[e.s]) res.links.push({ kind: "city", id: e.s, name: st.settlements[e.s]!.name });
  if (canBeLegend(e)) attachLegend(st, res, e);
  return res;
}

function attachLegend(st: WorldState, res: Article, e: HistEvent): void {
  const l = legendOf(st, e);
  if (l.stage === 0) return;
  res.legend = { stage: l.stageName, text: l.legend, forgotten: l.forgotten, keepers: l.keepers, fact: `${e.y} г.: ${l.fact}`, rediscovered: st.ruins.some((r) => r.artifacts.some((a) => a.event === e.id && a.found !== null)) };
}

/** Указатель энциклопедии: списки всех объектов */
export function index(st: WorldState): Record<string, Link[]> {
  return {
    "Государства": st.civs.filter((c) => c.cities > 1 || c.peakCities > 1 || c.fallen === null).sort((a, b) => (a.fallen === null ? 0 : 1) - (b.fallen === null ? 0 : 1) || b.peakPop - a.peakPop).slice(0, 200).map((c) => ({ kind: "civ" as Kind, id: c.id, name: c.title + (c.fallen !== null ? ` (до ${c.fallen})` : "") })),
    "Великие города": st.settlements.filter((s) => s.tier >= 3).sort((a, b) => b.pop - a.pop).slice(0, 120).map((s) => ({ kind: "city" as Kind, id: s.id, name: s.name + (s.alive ? "" : " †") })),
    "Личности": st.characters.filter((c) => c.fame >= 6).sort((a, b) => b.fame - a.fame).slice(0, 150).map((c) => ({ kind: "person" as Kind, id: c.id, name: `${chN(st, c.id)} — ${ROLE_NAMES[c.role].toLowerCase()}` })),
    "Войны": st.wars.filter((w) => w.battles.length > 0).slice(-150).reverse().map((w) => ({ kind: "war" as Kind, id: w.id, name: `${w.name} (${w.start}–${w.end ?? "…"})` })),
    "Веры": st.religions.map((r) => ({ kind: "religion" as Kind, id: r.id, name: r.name + (r.extinct !== null ? " (забыта)" : "") })),
    "Народы": st.cultures.map((c) => ({ kind: "culture" as Kind, id: c.id, name: c.name + (c.extinct !== null ? " (исчез)" : "") })),
    "Руины": st.ruins.filter((r) => r.discovered !== null).map((r) => ({ kind: "ruin" as Kind, id: r.id, name: `Руины ${r.name}` })),
    "Эпохи": ERAS.map((n, i) => ({ kind: "era" as Kind, id: i, name: n })),
  };
}
