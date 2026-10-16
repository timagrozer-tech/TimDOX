import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorld } from "../src/world/generate";
import { DEFAULT_SETTINGS } from "../src/simulation/sim";
import { isWater } from "../src/world/biomes";

const S = { ...DEFAULT_SETTINGS, seed: "test-world", size: "small" as const };

test("одинаковый seed и настройки — одинаковая карта", () => {
  const a = generateWorld(S), b = generateWorld(S);
  assert.deepEqual(a.biome, b.biome);
  assert.deepEqual(a.river, b.river);
  assert.notDeepEqual(generateWorld({ ...S, seed: "other" }).biome, a.biome);
});

test("доля суши близка к настройке, есть реки, горы и ресурсы, края — океан", () => {
  const m = generateWorld({ ...S, landRatio: 0.4 });
  let land = 0, rivers = 0, res = 0, mountains = 0;
  for (let i = 0; i < m.w * m.h; i++) { if (!isWater(m.biome[i]!)) land++; if (m.river[i]) rivers++; if (m.resource[i]) res++; if (m.biome[i] === 14 || m.biome[i] === 15) mountains++; }
  const ratio = land / (m.w * m.h);
  assert.ok(ratio > 0.3 && ratio < 0.5, "суша " + ratio);
  assert.ok(rivers > 100, "реки " + rivers);
  assert.ok(res > 50, "ресурсы " + res);
  assert.ok(mountains > 50, "горы " + mountains);
  for (let x = 0; x < m.w; x++) assert.ok(isWater(m.biome[x]!), "верхний край — вода");
});
