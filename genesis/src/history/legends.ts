import { hash32 } from "../core/rng";
import type { HistEvent, WorldState } from "../simulation/types";
import { EV, chN, civN, setN, relN, DISASTER_NAMES, DISASTER_CODES, eventText, fmtPop } from "./events";

/**
 * Историческое искажение. Факт хранится один раз, а предание о нём «вырастает» с возрастом события:
 * через века числа раздуваются, герой становится легендарным, через тысячелетия — полубогом и богом.
 * Предание живо, пока жив народ, который его помнит (или его потомки). Иначе оно забыто — пока
 * археологи не найдут предметы, связанные с этим событием.
 */
export type LegendStage = 0 | 1 | 2 | 3 | 4;
export const STAGE_NAMES = ["Свежая память", "Предание", "Героическая легенда", "Миф", "Священное сказание"];

export function legendStage(age: number): LegendStage {
  if (age < 150) return 0;
  if (age < 600) return 1;
  if (age < 1500) return 2;
  if (age < 2500) return 3;
  return 4;
}

/** Кто помнит: культура участника и культуры-потомки, которые ещё живы */
export function rememberedBy(st: WorldState, e: HistEvent): number[] {
  const civ = st.civs[e.a];
  const root = civ ? civ.culture : e.s >= 0 ? st.settlements[e.s]?.culture ?? -1 : -1;
  if (root < 0) return [];
  const out: number[] = [];
  for (const c of st.cultures) {
    if (c.extinct !== null) continue;
    let p = c.id, k = 0;
    while (p >= 0 && k++ < 20) { if (p === root) { out.push(c.id); break; } p = st.cultures[p]!.parent; }
  }
  return out;
}

/** Найдено ли археологами что-то об этом событии */
export function rediscovered(st: WorldState, e: HistEvent): boolean {
  return st.ruins.some((r) => r.artifacts.some((a) => a.event === e.id && a.found !== null));
}

const LEGENDARY = new Set<EV>([EV.Battle, EV.Founded, EV.TribeEmerges, EV.Crowned, EV.ReligionFounded, EV.Disaster, EV.Wonder, EV.Exploration,
  EV.Captured, EV.Razed, EV.Collapse, EV.CivFounded, EV.Plague, EV.Migration, EV.Unification, EV.Deed]);
export const canBeLegend = (e: HistEvent): boolean => LEGENDARY.has(e.t) && e.imp >= 2;

export interface Legend { stage: LegendStage; stageName: string; fact: string; legend: string | null; forgotten: boolean; keepers: string[]; age: number }

export function legendOf(st: WorldState, e: HistEvent): Legend {
  const age = st.year - e.y;
  const stage = legendStage(age);
  const keepers = rememberedBy(st, e);
  const fact = eventText(st, e);
  const forgotten = stage > 0 && keepers.length === 0;
  const text = stage === 0 || forgotten ? null : tell(st, e, stage);
  return { stage, stageName: STAGE_NAMES[stage]!, fact, legend: text, forgotten, keepers: keepers.map((k) => st.cultures[k]!.name), age };
}

/** Сказитель: детали зависят от номера события и стадии — одно и то же предание при каждом показе */
function tell(st: WorldState, e: HistEvent, stage: LegendStage): string {
  const h = (k: number) => hash32(e.id, stage, k);
  const pick = <T>(arr: T[], k: number): T => arr[h(k) % arr.length]!;
  const hero = e.d >= 0 ? chN(st, e.d) : e.b >= 0 && st.characters[e.b] ? chN(st, e.b) : null;
  const people = st.cultures[st.civs[e.a]?.culture ?? 0]?.name ?? "предки";
  const place = setN(st, e.s);
  const deity = (() => { const c = st.civs[e.a]; const r = c ? st.religions[c.religion] : undefined; return r ? r.deity : "Небо"; })();
  const mult = [1, 3, 10, 100, 1000][stage]!;
  const many = (n: number) => fmtPop(Math.max(n, 100) * mult);
  switch (e.t as EV) {
    case EV.Battle: {
      const foe = civN(st, e.b);
      if (stage === 1) return `Говорят, у ${place} ${hero ?? "наши воины"} разбили войско втрое больше своего. Враг — ${foe} — бежал, оставив ${many(e.n)} павших.`;
      if (stage === 2) return `${hero ?? "Безымянный герой"} с ${pick(["тремя сотнями", "горсткой", "семью десятками"], 1)} воинов ${pick(["три дня и три ночи держал", "одним ударом опрокинул", "в тумане обошёл"], 2)} несметную рать. Земля у ${place} до сих пор красная от крови ${many(e.n)} врагов.`;
      if (stage === 3) return `${hero ?? "Сын бури"}, рождённый от ${deity}, сразил у ${place} войско теней. Боги смотрели с небес, а ${pick(["горы", "реки", "звёзды"], 3)} сражались на его стороне.`;
      return `В начале времён ${deity} в облике ${hero ?? "воина"} победил Хаос у священного места ${place}. ${people} молятся ему перед каждой битвой.`;
    }
    case EV.Founded: case EV.TribeEmerges: case EV.CivFounded: {
      if (stage === 1) return `${place} основали ${hero ?? "первые люди"}, пришедшие с ${pick(["запада", "гор", "моря", "севера"], 1)} за ${pick(["белым оленем", "звездой", "рекой"], 2)}.`;
      if (stage === 2) return `Первопредок ${hero ?? "Отец народа"} вбил посох в землю — и на этом месте забил источник, вокруг которого вырос ${place}.`;
      if (stage === 3) return `${deity} вылепил первых людей из глины у ${place} и сказал им: «Здесь будет ваш дом навеки».`;
      return `${place} — пуп мира. Здесь небо касается земли, и отсюда ${deity} начал творение.`;
    }
    case EV.Crowned: {
      if (stage === 1) return `${hero} был мудрейшим из правителей: при нём ${pick(["не знали голода", "не было войн", "реки текли мёдом"], 1)}.`;
      if (stage === 2) return `${hero} правил ${pick(["сто", "двести", "триста"], 2)} лет и ни разу не проиграл ни одного спора, ни одной битвы.`;
      if (stage === 3) return `${hero} был сыном ${deity}; когда пришёл его час, он не умер, а ушёл на небо по радуге.`;
      return `${hero} и есть ${deity}. ${people} верят, что однажды он вернётся.`;
    }
    case EV.ReligionFounded: {
      const r = relN(st, e.a);
      if (stage === 1) return `Пророк ${hero} исцелял больных и предсказывал будущее. Так началась ${r}.`;
      if (stage === 2) return `${hero} сорок дней постился в пустыне, и ${deity} явился ему в огне, открыв истину.`;
      return `${hero} не родился, а сошёл с небес, чтобы научить людей. ${r} — это слово самого ${deity}.`;
    }
    case EV.Disaster: case EV.Plague: {
      const dn = DISASTER_NAMES[DISASTER_CODES[e.n] ?? "drought"] ?? "Беда";
      if (stage === 1) return `${dn} пришла как наказание за гордыню правителей ${place}.`;
      if (stage === 2) return `Разгневанный ${deity} наслал на мир ${dn.toLowerCase()}; спаслись лишь праведники, укрывшиеся у ${place}.`;
      return `Когда-то мир уже погибал: ${deity} стёр всё живое, и только у ${place} уцелела одна семья — от неё пошли все люди.`;
    }
    case EV.Wonder: {
      const s = st.settlements[e.s];
      if (stage <= 2) return `${s?.wonder ?? "Чудо"} в ${place} строили не люди, а ${pick(["великаны", "духи", "ученики богов"], 1)} — за одну ночь.`;
      return `${s?.wonder ?? "Чудо"} — это лестница, по которой ${deity} спускается на землю.`;
    }
    case EV.Exploration:
      if (stage <= 2) return `${hero} доплыл до края мира и видел, как солнце ночует в море.`;
      return `${hero} — сын моря; он и сейчас плавает между звёздами.`;
    case EV.Captured: case EV.Razed: case EV.Collapse:
      if (stage === 1) return `${place} пал из-за предательства: кто-то открыл ворота ночью.`;
      if (stage === 2) return `${place} был так богат, что боги позавидовали и стёрли его с лица земли.`;
      return `Где-то под землёй спит великий ${place}, золотой город, где не знали смерти. Кто найдёт его — станет бессмертным.`;
    case EV.Migration:
      if (stage <= 2) return `Предки шли ${pick(["сорок", "сто", "тысячу"], 1)} дней, ведомые ${pick(["птицей", "огнём", "звездой"], 2)}, пока не нашли новую землю.`;
      return `${deity} сам вёл народ через пустоту, раздвигая перед ним горы и моря.`;
    case EV.Unification:
      return stage <= 2 ? `${hero ?? "Мудрый правитель"} соединил два народа узами крови, и с тех пор они — одна семья.` : `Два брата-бога поделили мир, а потом снова соединили его в одно царство.`;
    case EV.Deed:
      return stage <= 2 ? `${hero} знал язык зверей и звёзд; все науки — от него.` : `${hero} принёс людям огонь знания, украв его у ${deity}.`;
    default: return eventText(st, e);
  }
}
