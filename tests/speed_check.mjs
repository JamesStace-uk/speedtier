import assert from "node:assert/strict";

import {
  applyRulesetFilter,
  applyStage,
  buildSpeedTiers,
  computeFinalSpeed,
  computeRawSpeed,
} from "../web/speed.js";

assert.equal(computeRawSpeed(100, 31, 252, "neutral"), 152);
assert.equal(computeRawSpeed(100, 31, 252, "positive"), 167);
assert.equal(computeRawSpeed(100, 31, 252, "negative"), 136);

const raw = 152;
assert.equal(applyStage(raw, 1), 228);
assert.equal(applyStage(raw, -1), 101);
assert.equal(computeFinalSpeed(raw, 0, true, true), 456);

const pokemon = [
  { id: 1, name: "a", baseSpeed: 50, spritePath: "sprites/1.png" },
  { id: 2, name: "b", baseSpeed: 50, spritePath: "sprites/2.png" },
];
const tiers = buildSpeedTiers(pokemon);
const filtered = applyRulesetFilter(tiers, new Set([2]));
for (const tier of filtered) {
  for (const box of tier.boxes) {
    assert.deepEqual(box.pokemon.map((p) => p.id), [2]);
  }
}

const ordered = buildSpeedTiers([
  { id: 2, name: "b", baseSpeed: 90, spritePath: "sprites/2.png" },
  { id: 1, name: "a", baseSpeed: 90, spritePath: "sprites/1.png" },
]);
for (let i = 1; i < ordered.length; i += 1) {
  assert.ok(ordered[i - 1].finalSpeed >= ordered[i].finalSpeed);
}
assert.deepEqual(ordered[0].boxes[0].pokemon.map((p) => p.id), [1, 2]);

console.log("speed logic checks passed");
