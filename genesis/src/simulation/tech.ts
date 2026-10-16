/** Технологии и эпохи. Изучение зависит от населения, учёных, торговли; соседи и торговые партнёры перенимают знания. */
export interface Tech {
  name: string;
  era: number;
  cost: number;
  req: number[];
  /** что даёт — для энциклопедии */
  gives: string;
}

export const ERAS = ["Каменный век", "Бронзовый век", "Железный век", "Античность", "Средневековье", "Возрождение", "Промышленная эпоха"];

export const T = {
  Agriculture: 0, Husbandry: 1, Pottery: 2, Mysticism: 3, Bronze: 4, Writing: 5, Wheel: 6, Sailing: 7, Iron: 8,
  Mathematics: 9, Irrigation: 10, Currency: 11, Philosophy: 12, Engineering: 13, Law: 14, Astronomy: 15, Steel: 16,
  Printing: 17, Gunpowder: 18, Navigation: 19, Science: 20, Archaeology: 21, Medicine: 22, Steam: 23, Railroad: 24,
} as const;

export const TECHS: Tech[] = [
  { name: "Земледелие", era: 0, cost: 90, req: [], gives: "больше еды с равнин и пойм" },
  { name: "Скотоводство", era: 0, cost: 105, req: [], gives: "еда в степях и саваннах, конница" },
  { name: "Гончарство", era: 0, cost: 120, req: [0], gives: "запасы зерна — голод не так страшен" },
  { name: "Мистицизм", era: 0, cost: 135, req: [], gives: "храмы и первые религии" },
  { name: "Бронза", era: 1, cost: 270, req: [0], gives: "бронзовое оружие" },
  { name: "Письменность", era: 1, cost: 300, req: [2], gives: "летописи, надписи, библиотеки" },
  { name: "Колесо", era: 1, cost: 270, req: [1], gives: "дороги и торговля дальше" },
  { name: "Мореходство", era: 1, cost: 330, req: [0], gives: "колонии за морем, порты" },
  { name: "Железо", era: 2, cost: 600, req: [4], gives: "сильные армии" },
  { name: "Математика", era: 2, cost: 630, req: [5], gives: "наука быстрее" },
  { name: "Орошение", era: 2, cost: 570, req: [0, 6], gives: "урожаи в пустынях и у рек" },
  { name: "Монета", era: 2, cost: 660, req: [5, 6], gives: "богатая торговля, рынки" },
  { name: "Философия", era: 3, cost: 1140, req: [9, 3], gives: "философы, устойчивость, республики" },
  { name: "Инженерия", era: 3, cost: 1200, req: [9, 8], gives: "крепости, дороги, чудеса света" },
  { name: "Право", era: 3, cost: 1140, req: [11, 5], gives: "большие державы не так легко распадаются" },
  { name: "Астрономия", era: 3, cost: 1260, req: [9, 7], gives: "дальние плавания" },
  { name: "Сталь", era: 4, cost: 2100, req: [13], gives: "рыцари и крепкие стены" },
  { name: "Книгопечатание", era: 4, cost: 2280, req: [14, 12], gives: "наука и культура распространяются быстро" },
  { name: "Порох", era: 4, cost: 2460, req: [16], gives: "стены больше не спасают" },
  { name: "Навигация", era: 5, cost: 3300, req: [15, 17], gives: "колонизация других материков" },
  { name: "Научный метод", era: 5, cost: 3600, req: [17], gives: "великие открытия" },
  { name: "Археология", era: 5, cost: 3150, req: [20], gives: "раскопки руин древних народов" },
  { name: "Медицина", era: 5, cost: 3450, req: [20], gives: "эпидемии слабее" },
  { name: "Паровая машина", era: 6, cost: 5400, req: [20, 18], gives: "мануфактуры и промышленность" },
  { name: "Железные дороги", era: 6, cost: 6300, req: [23], gives: "огромные государства держатся вместе" },
];

export const has = (techs: number[], t: number): boolean => techs.includes(t);
export const civEra = (techs: number[]): number => techs.reduce((m, t) => Math.max(m, TECHS[t]!.era), 0);

/** Какие технологии можно изучать сейчас */
export function available(techs: number[]): number[] {
  const out: number[] = [];
  TECHS.forEach((t, i) => { if (!techs.includes(i) && t.req.every((r) => techs.includes(r))) out.push(i); });
  return out;
}

/** Военная сила от технологий */
export function techMilitary(techs: number[]): number {
  let m = 1;
  if (has(techs, T.Bronze)) m += 0.35;
  if (has(techs, T.Iron)) m += 0.45;
  if (has(techs, T.Husbandry)) m += 0.1;
  if (has(techs, T.Steel)) m += 0.6;
  if (has(techs, T.Gunpowder)) m += 1.0;
  if (has(techs, T.Steam)) m += 0.8;
  if (has(techs, T.Railroad)) m += 0.6;
  return m;
}
