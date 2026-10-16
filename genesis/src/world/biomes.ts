/** Природные зоны. Значения хранятся в Uint8Array карты. */
export enum Biome {
  DeepOcean = 0, Ocean = 1, Lake = 2, Beach = 3, Desert = 4, Savanna = 5, Grassland = 6, Forest = 7,
  Rainforest = 8, Taiga = 9, Tundra = 10, Snow = 11, Marsh = 12, Hills = 13, Mountain = 14, Peak = 15,
}
export const BIOME_COUNT = 16;

export interface BiomeInfo {
  name: string;
  color: [number, number, number];
  /** пища (0–1) для поселений */
  food: number;
  /** стоимость прохода (для границ, армий и миграций) */
  move: number;
  water: boolean;
}

export const BIOMES: BiomeInfo[] = [
  { name: "Глубокий океан", color: [26, 58, 96], food: 0, move: 99, water: true },
  { name: "Море", color: [41, 90, 135], food: 0, move: 99, water: true },
  { name: "Озеро", color: [62, 120, 160], food: 0, move: 99, water: true },
  { name: "Побережье", color: [206, 194, 150], food: 0.45, move: 1, water: false },
  { name: "Пустыня", color: [214, 192, 132], food: 0.08, move: 1.6, water: false },
  { name: "Саванна", color: [178, 170, 102], food: 0.45, move: 1.1, water: false },
  { name: "Равнины", color: [118, 152, 82], food: 0.85, move: 1, water: false },
  { name: "Лес", color: [66, 112, 62], food: 0.55, move: 1.5, water: false },
  { name: "Джунгли", color: [46, 100, 58], food: 0.5, move: 2.2, water: false },
  { name: "Тайга", color: [74, 102, 84], food: 0.32, move: 1.6, water: false },
  { name: "Тундра", color: [148, 150, 128], food: 0.12, move: 1.5, water: false },
  { name: "Снега", color: [236, 240, 244], food: 0, move: 3, water: false },
  { name: "Болота", color: [90, 112, 92], food: 0.3, move: 2.4, water: false },
  { name: "Холмы", color: [136, 140, 98], food: 0.45, move: 1.8, water: false },
  { name: "Горы", color: [124, 118, 108], food: 0.06, move: 4, water: false },
  { name: "Вершины", color: [220, 222, 228], food: 0, move: 8, water: false },
];

export const isWater = (b: number): boolean => b <= 2;
