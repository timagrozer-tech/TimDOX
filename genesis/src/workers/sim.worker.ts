/// <reference lib="webworker" />
import { createWorld, intervene, tick } from "../simulation/sim";
import { computeTerritory, territoryVersion } from "../simulation/territory";
import { article, index } from "../encyclopedia/articles";
import { eventIcon, eventText } from "../history/events";
import { ERAS } from "../simulation/tech";
import { BLD, type WorldState } from "../simulation/types";
import type { FromWorker, Snapshot, SnapEvent, ToWorker } from "./protocol";

/**
 * Поток симуляции. Вся тяжёлая работа — здесь: интерфейс не подвисает даже на скорости «столетие в секунду».
 * Шаг симуляции фиксированный (1 год); за кадр выполняется столько лет, сколько успевает в бюджет времени.
 */
declare const self: DedicatedWorkerGlobalScope;
let st: WorldState | null = null;
let yearsPerSec = 2;
let acc = 0;
let last = performance.now();
let sentOwner = -2, lastEvent = 0, lastRoadYear = -100;
let tickMs = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function sendWorld(): void {
  if (!st) return;
  const m = st.map;
  post({ type: "world", world: { w: m.w, h: m.h, seaLevel: m.seaLevel, elevation: m.elevation.slice(), biome: m.biome.slice(), river: m.river.slice(), resource: m.resource.slice(), temperature: m.temperature.slice(), moisture: m.moisture.slice(), name: st.settings.name, seed: st.settings.seed } });
  sentOwner = -2; lastEvent = Math.max(0, st.events.length - 30); lastRoadYear = -100;
}

function centroids(s: WorldState): Map<number, { x: number; y: number; n: number }> {
  const out = new Map<number, { x: number; y: number; n: number }>();
  const { w } = s.map, o = s.owner;
  for (let i = 0; i < o.length; i += 2) {
    const c = o[i]!;
    if (c < 0) continue;
    let e = out.get(c);
    if (!e) { e = { x: 0, y: 0, n: 0 }; out.set(c, e); }
    e.x += i % w; e.y += (i / w) | 0; e.n++;
  }
  return out;
}
let cent = new Map<number, { x: number; y: number; n: number }>();

function snapshot(): Snapshot {
  const s = st!;
  const snap: Snapshot = {
    year: s.year, era: s.era, eraName: ERAS[s.era]!, speed: yearsPerSec,
    settlements: [], civs: [], armies: [], routes: [], ruins: [], disasters: [], events: [],
    stats: { pop: 0, states: 0, cities: 0, wars: 0, religions: 0, people: 0 }, tickMs,
  };
  if (territoryVersion !== sentOwner) { snap.owner = s.owner.slice(); snap.fertility = s.map.fertility.slice(); sentOwner = territoryVersion; cent = centroids(s); }
  if (s.year - lastRoadYear >= 10) { snap.road = s.road.slice(); lastRoadYear = s.year; }
  for (const t of s.settlements) {
    if (!t.alive) continue;
    const c = s.civs[t.civ];
    snap.settlements.push({ id: t.id, x: t.x, y: t.y, pop: Math.round(t.pop), tier: t.tier, civ: t.civ, cap: !!c && c.capital === t.id, walls: t.walls, wonder: !!t.wonder, plague: t.plague > s.year, name: t.name, harbor: !!(t.buildings & BLD.Harbor) });
    snap.stats.pop += t.pop; snap.stats.cities++;
  }
  for (const c of s.civs) {
    if (c.fallen !== null) continue;
    const ce = cent.get(c.id);
    snap.civs.push({ id: c.id, title: c.title, color: c.color, pop: Math.round(c.pop), cities: c.cities, lx: ce ? ce.x / ce.n : -1, ly: ce ? ce.y / ce.n : -1, area: ce ? ce.n * 2 : 0, war: Object.values(c.relations).some((r) => r.war >= 0), gov: c.gov });
    snap.stats.states++;
  }
  for (const a of s.armies) {
    const t = s.settlements[a.target];
    if (t) snap.armies.push({ id: a.id, x: a.x, y: a.y, tx: t.x, ty: t.y, civ: a.civ, strength: a.strength, siege: a.state === "siege" });
  }
  for (const r of s.routes) { const a = s.settlements[r.a]!, b = s.settlements[r.b]!; if (a.alive && b.alive) snap.routes.push(a.x, a.y, b.x, b.y, r.volume, r.sea ? 1 : 0); }
  for (const r of s.ruins) snap.ruins.push({ id: r.id, x: r.x, y: r.y, name: r.name, found: r.discovered !== null, tier: r.tier });
  for (const d of s.disasters) if (d.until >= s.year) snap.disasters.push({ type: d.type, x: d.x, y: d.y, r: d.r });
  snap.stats.wars = s.wars.filter((w) => w.end === null).length;
  snap.stats.religions = s.religions.filter((r) => r.extinct === null).length;
  snap.stats.people = s.characters.filter((c) => c.died === null && c.fame >= 5).length;
  for (let i = lastEvent; i < s.events.length; i++) { const e = s.events[i]!; if (e.imp >= 2) snap.events.push(evOut(e)); }
  lastEvent = s.events.length;
  if (snap.events.length > 60) snap.events = snap.events.filter((e) => e.imp >= 3).slice(-60);
  return snap;
}
function evOut(e: WorldState["events"][number]): SnapEvent {
  return { id: e.id, y: e.y, text: eventText(st!, e), icon: eventIcon(e.t), imp: e.imp, x: e.x, py: e.y2 };
}

function loop(): void {
  const now = performance.now();
  const dt = Math.min(0.5, (now - last) / 1000);
  last = now;
  if (!st) return;
  if (yearsPerSec > 0) {
    acc += dt * yearsPerSec;
    const budget = 28; // мс на кадр симуляции
    const t0 = performance.now();
    let n = 0;
    while (acc >= 1 && performance.now() - t0 < budget) {
      tick(st); n++; acc -= 1;
    }
    if (n) tickMs = (performance.now() - t0) / n;
    if (acc > 20) acc = 20; // не копим «долг», если не успеваем
    if (n) post({ type: "snap", snap: snapshot() });
  }
}
setInterval(loop, 50);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case "new": st = createWorld(m.settings); sendWorld(); post({ type: "snap", snap: snapshot() }); break;
      case "load":
        st = m.state;
        computeTerritory(st);
        sendWorld(); post({ type: "snap", snap: snapshot() }); break;
      case "speed": yearsPerSec = m.yearsPerSec; acc = 0; break;
      case "intervene": if (st) { const text = intervene(st, m.tool, m.x, m.y); computeTerritory(st); post({ type: "toast", text }); post({ type: "snap", snap: snapshot() }); } break;
      case "article": post({ type: "article", req: m.req, article: st ? article(st, m.kind, m.id) : null }); break;
      case "index": post({ type: "index", req: m.req, index: st ? index(st) : {} }); break;
      case "chronicle": {
        if (!st) break;
        const q = (m.query ?? "").toLowerCase();
        const out: SnapEvent[] = [];
        for (let i = Math.min(st.events.length, m.before ?? st.events.length) - 1; i >= 0 && out.length < m.limit; i--) {
          const e = st.events[i]!;
          if (e.imp < m.minImp) continue;
          const o = evOut(e);
          if (q && !o.text.toLowerCase().includes(q) && String(e.y) !== q) continue;
          out.push(o);
        }
        post({ type: "chronicle", req: m.req, items: out });
        break;
      }
      case "save": if (st) post({ type: "save", req: m.req, state: st }); break;
      case "pick": post({ type: "pick", req: m.req, hit: st ? pick(st, m.x, m.y) : null }); break;
    }
  } catch (e) {
    post({ type: "error", message: String((e as Error)?.stack ?? e) });
  }
};

function pick(s: WorldState, x: number, y: number): { kind: "city" | "ruin" | "civ"; id: number; name: string } | null {
  let best: { kind: "city" | "ruin" | "civ"; id: number; name: string } | null = null, bd = 2.2;
  for (const t of s.settlements) if (t.alive) { const d = Math.hypot(t.x - x, t.y - y); if (d < bd) { bd = d; best = { kind: "city", id: t.id, name: t.name }; } }
  if (!best) for (const r of s.ruins) { const d = Math.hypot(r.x - x, r.y - y); if (d < 1.6 && r.discovered !== null) { best = { kind: "ruin", id: r.id, name: r.name }; break; } }
  if (!best) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < s.map.w && yi < s.map.h) { const o = s.owner[yi * s.map.w + xi]!; if (o >= 0) best = { kind: "civ", id: o, name: s.civs[o]!.title }; }
  }
  return best;
}
