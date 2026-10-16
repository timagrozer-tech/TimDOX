import type { WorldSettings, WorldState } from "../simulation/types";
import type { Tool } from "../simulation/sim";
import type { Article, Link } from "../encyclopedia/articles";

/** Сообщения между интерфейсом и потоком симуляции */
export type ToWorker =
  | { type: "new"; settings: WorldSettings }
  | { type: "load"; state: WorldState }
  | { type: "speed"; yearsPerSec: number }
  | { type: "intervene"; tool: Tool; x: number; y: number }
  | { type: "article"; req: number; kind: Article["kind"]; id: number }
  | { type: "index"; req: number }
  | { type: "chronicle"; req: number; minImp: number; limit: number; query?: string; before?: number }
  | { type: "save"; req: number }
  | { type: "pick"; req: number; x: number; y: number };

export interface StaticWorld {
  w: number; h: number; seaLevel: number;
  elevation: Float32Array; biome: Uint8Array; river: Uint8Array; resource: Uint8Array; temperature: Float32Array; moisture: Float32Array;
  name: string; seed: string;
}

export interface SnapSettlement { id: number; x: number; y: number; pop: number; tier: number; civ: number; cap: boolean; walls: number; wonder: boolean; plague: boolean; name: string; harbor: boolean }
export interface SnapCiv { id: number; title: string; color: [number, number, number]; pop: number; cities: number; lx: number; ly: number; area: number; war: boolean; gov: number }
export interface SnapEvent { id: number; y: number; text: string; icon: string; imp: number; x: number; py: number }

export interface Snapshot {
  year: number;
  era: number;
  eraName: string;
  speed: number;
  owner?: Int16Array;       // только если границы изменились
  road?: Uint8Array;
  fertility?: Float32Array;
  settlements: SnapSettlement[];
  civs: SnapCiv[];
  armies: { id: number; x: number; y: number; tx: number; ty: number; civ: number; strength: number; siege: boolean }[];
  routes: number[];         // ax, ay, bx, by, объём, море(0/1) …
  ruins: { id: number; x: number; y: number; name: string; found: boolean; tier: number }[];
  disasters: { type: string; x: number; y: number; r: number }[];
  events: SnapEvent[];
  stats: { pop: number; states: number; cities: number; wars: number; religions: number; people: number };
  tickMs: number;
}

export type FromWorker =
  | { type: "world"; world: StaticWorld }
  | { type: "snap"; snap: Snapshot }
  | { type: "article"; req: number; article: Article | null }
  | { type: "index"; req: number; index: Record<string, Link[]> }
  | { type: "chronicle"; req: number; items: SnapEvent[] }
  | { type: "save"; req: number; state: WorldState }
  | { type: "pick"; req: number; hit: { kind: Article["kind"]; id: number; name: string } | null }
  | { type: "toast"; text: string }
  | { type: "error"; message: string };
