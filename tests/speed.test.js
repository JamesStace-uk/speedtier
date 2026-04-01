import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRulesetFilter,
  applyStage,
  buildSpeedTiers,
  computeFinalSpeed,
  computeRawSpeed,
} from "../web/speed.js";

test("raw speed formula at level 50", () => {
  assert.equal(computeRawSpeed(100, 31, 252, "neutral"), 152);
  assert.equal(computeRawSpeed(100, 31, 252, "positive"), 167);
  assert.equal(computeRawSpeed(100, 31, 252, "negative"), 136);
});

test("stage/tailwind/scarf and flooring", () => {
  const raw = 152;
  assert.equal(applyStage(raw, 1), 228);
  assert.equal(applyStage(raw, -1), 101);
  assert.equal(computeFinalSpeed(raw, 0, true, true), 456);
});

test("filtering removes non-members and prunes empties", () => {
  const pokemon = [
    { id: 1, name: "a", baseSpeed: 50, spritePath: "sprites/1.png" },
    { id: 2, name: "b", baseSpeed: 50, spritePath: "sprites/2.png" },
  ];

  const tiers = buildSpeedTiers(pokemon);
  const allowed = new Set([2]);
  const filtered = applyRulesetFilter(tiers, allowed);

  assert.ok(filtered.length > 0);
  for (const tier of filtered) {
    for (const box of tier.boxes) {
      assert.deepEqual(box.pokemon.map((p) => p.id), [2]);
    }
  }
});

test("render model order is deterministic", () => {
  const pokemon = [
    { id: 2, name: "b", baseSpeed: 90, spritePath: "sprites/2.png" },
    { id: 1, name: "a", baseSpeed: 90, spritePath: "sprites/1.png" },
  ];
  const tiers = buildSpeedTiers(pokemon);

  for (let i = 1; i < tiers.length; i += 1) {
    assert.ok(tiers[i - 1].finalSpeed >= tiers[i].finalSpeed);
  }

  const firstBox = tiers[0].boxes[0];
  assert.deepEqual(firstBox.pokemon.map((p) => p.id), [1, 2]);
});
