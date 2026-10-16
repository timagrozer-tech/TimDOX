/** Природные ресурсы клеток. 0 — нет ресурса. */
export enum Res {
  None = 0, Wheat, Fish, Horses, Wood, Stone, Copper, Iron, Gold, Salt, Spices, Gems, Incense, Furs, Coal,
}
export interface ResInfo { name: string; icon: string; food: number; wealth: number; strategic: boolean }
export const RESOURCES: ResInfo[] = [
  { name: "—", icon: "", food: 0, wealth: 0, strategic: false },
  { name: "Пшеница", icon: "🌾", food: 0.5, wealth: 0.1, strategic: false },
  { name: "Рыба", icon: "🐟", food: 0.45, wealth: 0.1, strategic: false },
  { name: "Лошади", icon: "🐎", food: 0.1, wealth: 0.3, strategic: true },
  { name: "Строевой лес", icon: "🪵", food: 0, wealth: 0.25, strategic: false },
  { name: "Камень", icon: "🪨", food: 0, wealth: 0.2, strategic: false },
  { name: "Медь", icon: "🟠", food: 0, wealth: 0.5, strategic: true },
  { name: "Железо", icon: "⛏", food: 0, wealth: 0.5, strategic: true },
  { name: "Золото", icon: "🪙", food: 0, wealth: 1.2, strategic: false },
  { name: "Соль", icon: "🧂", food: 0.1, wealth: 0.7, strategic: false },
  { name: "Пряности", icon: "🌶", food: 0.05, wealth: 1, strategic: false },
  { name: "Самоцветы", icon: "💎", food: 0, wealth: 1.3, strategic: false },
  { name: "Благовония", icon: "🕯", food: 0, wealth: 0.9, strategic: false },
  { name: "Меха", icon: "🦊", food: 0.05, wealth: 0.6, strategic: false },
  { name: "Уголь", icon: "⚫", food: 0, wealth: 0.4, strategic: true },
];
