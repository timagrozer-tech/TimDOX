import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/core/rng";
import { Simplex2 } from "../src/core/noise";
import { MinHeap } from "../src/core/heap";
import { makeLanguage, cityName, adjective } from "../src/core/names";

test("ГСЧ детерминирован и продолжается после сохранения состояния", () => {
  const a = new Rng("seed"), b = new Rng("seed");
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  const c = new Rng(a.state());
  assert.equal(c.next(), a.next());
  assert.notEqual(new Rng("x").next(), new Rng("y").next());
});

test("симплекс-шум в пределах [-1, 1]", () => {
  const n = new Simplex2(new Rng(1));
  for (let i = 0; i < 2000; i++) { const v = n.fbm(i * 0.37, i * 0.11); assert.ok(v >= -1 && v <= 1, String(v)); }
});

test("куча выдаёт по возрастанию", () => {
  const h = new MinHeap(2), r = new Rng(3), keys: number[] = [];
  for (let i = 0; i < 500; i++) { const k = r.next(); keys.push(k); h.push(k, i); }
  let prev = -1;
  while (h.size) { const k = h.peekKey(); h.pop(); assert.ok(k >= prev); prev = k; }
});

test("имена: язык народа даёт читаемые названия", () => {
  const r = new Rng("lang");
  for (let i = 0; i < 20; i++) {
    const l = makeLanguage(r);
    const n = cityName(l, r);
    assert.match(n, /^[А-ЯЁ][а-яё]{3,10}$/);
    assert.match(adjective(n), /ская$/);
  }
});
