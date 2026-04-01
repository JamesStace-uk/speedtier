export const LEVEL = 50;
export const NATURES = ["positive", "neutral", "negative"];
export const PRESETS = [
  { iv: 31, ev: 0, label: "31/0" },
  { iv: 31, ev: 252, label: "31/252" },
];
export const STAGES = Array.from({ length: 13 }, (_, i) => i - 6);

const NATURE_MULTIPLIERS = {
  positive: 1.1,
  neutral: 1.0,
  negative: 0.9,
};

export function computeRawSpeed(base, iv, ev, nature, level = LEVEL) {
  const natureMultiplier = NATURE_MULTIPLIERS[nature];
  if (!natureMultiplier) {
    throw new Error(`Unsupported nature category: ${nature}`);
  }
  const inner = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  return Math.floor((inner + 5) * natureMultiplier);
}

export function applyStage(raw, stage) {
  if (stage >= 0) {
    return Math.floor((raw * (2 + stage)) / 2);
  }
  return Math.floor((raw * 2) / (2 + Math.abs(stage)));
}

export function computeFinalSpeed(raw, stage, tailwind, choiceScarf) {
  const stageSpeed = applyStage(raw, stage);
  const tw = tailwind ? 2.0 : 1.0;
  const scarf = choiceScarf ? 1.5 : 1.0;
  return Math.floor(stageSpeed * tw * scarf);
}

export function buildSpeedTiers(pokemon) {
  const byBase = new Map();
  for (const p of pokemon) {
    if (!byBase.has(p.baseSpeed)) {
      byBase.set(p.baseSpeed, []);
    }
    byBase.get(p.baseSpeed).push(p);
  }

  for (const group of byBase.values()) {
    group.sort((a, b) => a.id - b.id);
  }

  const tierMap = new Map();
  for (const [baseSpeed, members] of byBase.entries()) {
    for (const preset of PRESETS) {
      for (const nature of NATURES) {
        const raw = computeRawSpeed(baseSpeed, preset.iv, preset.ev, nature, LEVEL);
        for (const stage of STAGES) {
          for (const tailwind of [false, true]) {
            for (const choiceScarf of [false, true]) {
              const finalSpeed = computeFinalSpeed(raw, stage, tailwind, choiceScarf);
              const box = {
                finalSpeed,
                preset: {
                  baseSpeed,
                  iv: preset.iv,
                  ev: preset.ev,
                  nature,
                  stage,
                  tailwind,
                  choiceScarf,
                },
                pokemon: members,
              };

              if (!tierMap.has(finalSpeed)) {
                tierMap.set(finalSpeed, []);
              }
              tierMap.get(finalSpeed).push(box);
            }
          }
        }
      }
    }
  }

  const tiers = Array.from(tierMap.entries())
    .map(([finalSpeed, boxes]) => ({ finalSpeed, boxes }))
    .sort((a, b) => b.finalSpeed - a.finalSpeed);

  for (const tier of tiers) {
    tier.boxes.sort((a, b) => {
      if (a.preset.baseSpeed !== b.preset.baseSpeed) return b.preset.baseSpeed - a.preset.baseSpeed;
      if (a.preset.iv !== b.preset.iv) return b.preset.iv - a.preset.iv;
      if (a.preset.ev !== b.preset.ev) return b.preset.ev - a.preset.ev;
      if (a.preset.nature !== b.preset.nature) return a.preset.nature.localeCompare(b.preset.nature);
      if (a.preset.stage !== b.preset.stage) return b.preset.stage - a.preset.stage;
      if (a.preset.tailwind !== b.preset.tailwind) return a.preset.tailwind ? -1 : 1;
      if (a.preset.choiceScarf !== b.preset.choiceScarf) return a.preset.choiceScarf ? -1 : 1;
      return 0;
    });
  }

  return tiers;
}

export function applyRulesetFilter(tiers, allowedIds) {
  if (!allowedIds) {
    return tiers;
  }

  const filtered = [];
  for (const tier of tiers) {
    const boxes = [];
    for (const box of tier.boxes) {
      const members = box.pokemon.filter((p) => allowedIds.has(p.id));
      if (members.length > 0) {
        boxes.push({ ...box, pokemon: members });
      }
    }
    if (boxes.length > 0) {
      filtered.push({ finalSpeed: tier.finalSpeed, boxes });
    }
  }
  return filtered;
}
