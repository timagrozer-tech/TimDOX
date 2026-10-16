import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, tick, intervene, DEFAULT_SETTINGS } from "../src/simulation/sim";
import { EV } from "../src/history/events";
import { legendOf, legendStage } from "../src/history/legends";
import { article, index } from "../src/encyclopedia/articles";
import { toJSON, fromJSON } from "../src/storage/saveFormat";
import type { WorldState } from "../src/simulation/types";
import { computeTerritory } from "../src/simulation/territory";

const S = { ...DEFAULT_SETTINGS, seed: "test-sim", size: "small" as const, tribes: 10 };
const run = (years: number, st = createWorld(S)): WorldState => { for (let i = 0; i < years; i++) tick(st); return st; };
const digest = (st: WorldState) => JSON.stringify([st.year, st.events.length, st.settlements.length, st.civs.map((c) => [c.title, Math.round(c.pop), c.fallen]), st.rng]);

test("симуляция детерминирована: тот же мир → та же история", () => {
  assert.equal(digest(run(300)), digest(run(300)));
});

test("через 800 лет мир живёт: поселения, государства, история, техника, личности", () => {
  const st = run(800);
  const alive = st.settlements.filter((s) => s.alive);
  assert.ok(alive.length > 40, "поселений " + alive.length);
  assert.ok(st.civs.filter((c) => c.fallen === null).length >= 3);
  assert.ok(st.events.length > 500);
  assert.ok(st.characters.length > 50);
  assert.ok(st.civs.some((c) => c.techs.length >= 4), "технологии изучаются");
  // каждое живое поселение стоит на земле своего государства (границы без «дыр»)
  computeTerritory(st);
  for (const s of alive) assert.equal(st.owner[s.y * st.map.w + s.x], s.civ, `поселение ${s.name}`);
  // причины событий указывают на реальные прошлые события
  for (const e of st.events) if (e.cause >= 0) { assert.ok(e.cause < e.id, "причина раньше следствия"); assert.ok(st.events[e.cause]!.y <= e.y); }
  // у войн есть причина-мотив
  for (const w of st.wars) assert.ok(w.cause.length > 3);
});

test("сохранение → файл → загрузка: продолжение истории совпадает", () => {
  const st = run(200);
  const copy = fromJSON(toJSON(st));
  assert.ok(copy.map.elevation instanceof Float32Array);
  assert.equal(copy.owner.length, st.owner.length);
  run(50, st); run(50, copy);
  assert.equal(digest(copy), digest(st));
});

test("легенды: факт со временем становится преданием, мифом и сказанием", () => {
  assert.equal(legendStage(50), 0);
  assert.equal(legendStage(400), 1);
  assert.equal(legendStage(1000), 2);
  assert.equal(legendStage(2000), 3);
  assert.equal(legendStage(3000), 4);
  const st = run(300);
  const e = st.events.find((x) => x.t === EV.TribeEmerges)!;
  st.year = e.y + 1000;
  const l = legendOf(st, e);
  assert.equal(l.stage, 2);
  assert.ok(l.fact.length > 10);
  if (!l.forgotten) assert.ok(l.legend && l.legend !== l.fact);
});

test("энциклопедия: статьи для всех видов объектов собираются без ошибок", () => {
  const st = run(700);
  const idx = index(st);
  let n = 0;
  for (const links of Object.values(idx)) for (const l of links.slice(0, 15)) { const a = article(st, l.kind, l.id); assert.ok(a && a.title, `${l.kind} ${l.id}`); n++; }
  assert.ok(n > 20);
  for (const e of st.events.slice(0, 50)) assert.ok(article(st, "event", e.id));
});

test("режим Творца: новое племя и небесный огонь меняют мир", () => {
  const st = run(100);
  const land = st.settlements[0]!;
  const before = st.civs.length;
  intervene(st, "tribe", land.x + 6, land.y + 6);
  assert.ok(st.civs.length >= before);
  const target = st.settlements.find((s) => s.alive)!;
  intervene(st, "meteor", target.x, target.y);
  assert.equal(target.alive, false);
  assert.ok(st.ruins.some((r) => r.settlement === target.id) || target.tier === 0);
  run(20, st);
});
