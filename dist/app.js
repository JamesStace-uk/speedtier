import { applyRulesetFilter, buildSpeedTiers } from "./speed.js";

const STAGE_VALUES = Array.from({ length: 13 }, (_, i) => i - 6);
const DEFAULT_STAGE_VALUES = new Set([0]);
const SPEED_BLOCK_SIZE = 25;
const NATIONAL_DEX_RULESET_ID = "NationalDex";
const NATIONAL_DEX_LABEL = "National Dex";

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const compareTrayEl = document.getElementById("compareTray");
const comparePokemonListEl = document.getElementById("comparePokemonList");
const compareTierListEl = document.getElementById("compareTierList");
const clearCompareBtn = document.getElementById("clearCompareBtn");
const resultsActionsEl = document.getElementById("resultsActions");
const blockActionBtn = document.getElementById("blockActionBtn");
const tiersEl = document.getElementById("tiers");
const rulesetControlsEl = document.getElementById("rulesetControls");
const stageControlsEl = document.getElementById("stageControls");
const modifierControlsEl = document.getElementById("modifierControls");
const natureControlsEl = document.getElementById("natureControls");
const evControlsEl = document.getElementById("evControls");
const searchInputEl = document.getElementById("pokemonSearch");
const searchSuggestionsEl = document.getElementById("pokemonSearchSuggestions");
const sentinelEl = document.getElementById("loadMoreSentinel");

let allPokemon = [];
let allRulesets = [];
let allTiers = [];
let visibleTiers = [];
let atlasMeta = null;

let activeRulesetId = NATIONAL_DEX_RULESET_ID;
let includeTailwindOnBoxes = false;
let includeScarfBoxes = false;
let searchConfirmedName = "";
const selectedStages = new Set(DEFAULT_STAGE_VALUES);
const selectedNatures = new Set(["positive", "neutral", "negative"]);
const selectedEvs = new Set([0, 252]);

const rulesetAllowedIdsById = new Map();
let searchablePokemonNames = [];
const expandedBlockKeys = new Set();
const expandedTierKeys = new Set();
const expandedBoxKeys = new Set();
const pinnedPokemonKeys = new Set();
const pinnedTierKeys = new Set();
let visibleBlockControllers = [];

function showError(message) {
  if (errorEl) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }
  if (statusEl) {
    statusEl.textContent = "Failed to load data";
  }
}

function setStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
  }
  return response.json();
}

function getRulesetIds(ruleset, pokemonByName) {
  if (Array.isArray(ruleset.pokemonIds)) {
    return new Set(ruleset.pokemonIds);
  }
  const ids = new Set();
  for (const name of ruleset.pokemonNames || []) {
    const id = pokemonByName.get(String(name).toLowerCase());
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

function createToggleButton(label, onClick, isActive = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `filter-btn${isActive ? " active" : ""}`;
  btn.textContent = label;
  btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  btn.addEventListener("click", onClick);
  return btn;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "true");
  temp.style.position = "fixed";
  temp.style.left = "-9999px";
  document.body.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  document.body.removeChild(temp);
}

function stageLabel(stage) {
  return stage > 0 ? `+${stage}` : `${stage}`;
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function boxMatchesSearch(box) {
  if (!searchConfirmedName) {
    return false;
  }
  return box.pokemon.some((p) => String(p.name || "").toLowerCase() === searchConfirmedName);
}

function tierMatchesSearch(tier) {
  if (!searchConfirmedName) {
    return false;
  }
  return tier.boxes.some((box) => boxMatchesSearch(box));
}

function getTierKey(tier) {
  return String(tier.finalSpeed);
}

function getBoxKey(tierFinalSpeed, box) {
  const p = box.preset;
  return [
    tierFinalSpeed,
    p.baseSpeed,
    p.ev,
    p.nature,
    p.stage,
    p.tailwind ? 1 : 0,
    p.choiceScarf ? 1 : 0,
  ].join("|");
}

function getPinnedPokemonKey(pokemon, preset, finalSpeed) {
  return [
    normalizeSearch(pokemon.name),
    finalSpeed,
    preset.baseSpeed,
    preset.ev,
    preset.nature,
    preset.stage,
    preset.tailwind ? 1 : 0,
    preset.choiceScarf ? 1 : 0,
  ].join("|");
}

function parsePinnedPokemonKey(key) {
  const [name, finalSpeed, baseSpeed, ev, nature, stage, tailwind, choiceScarf] = String(key).split("|");
  if (!name) {
    return null;
  }
  return {
    name,
    finalSpeed: Number(finalSpeed),
    preset: {
      baseSpeed: Number(baseSpeed),
      ev: Number(ev),
      nature,
      stage: Number(stage),
      tailwind: tailwind === "1",
      choiceScarf: choiceScarf === "1",
    },
  };
}

function cssEscapeValue(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value));
  }
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sortedNumericValues(values) {
  return Array.from(values).sort((a, b) => a - b);
}

function sortedStringValues(values) {
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function setValues(targetSet, values) {
  targetSet.clear();
  for (const value of values) {
    targetSet.add(value);
  }
}

function parseCsvParam(params, key) {
  const raw = params.get(key);
  if (!raw) {
    return [];
  }
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function getSearchSuggestions(inputValue) {
  const term = normalizeSearch(inputValue);
  if (!term) return [];
  return searchablePokemonNames
    .filter((name) => name.includes(term))
    .slice(0, 20);
}

function hideSearchSuggestions() {
  if (!searchSuggestionsEl) return;
  searchSuggestionsEl.hidden = true;
  searchSuggestionsEl.textContent = "";
}

function confirmSearchSelection(name) {
  const normalized = normalizeSearch(name);
  if (!normalized) {
    searchConfirmedName = "";
    if (searchInputEl) searchInputEl.value = "";
    hideSearchSuggestions();
    refreshView();
    return;
  }
  searchConfirmedName = normalized;
  if (searchInputEl) searchInputEl.value = normalized;
  hideSearchSuggestions();
  refreshView();
}

function renderSearchSuggestions(inputValue) {
  if (!searchSuggestionsEl) return;
  const suggestions = getSearchSuggestions(inputValue);
  searchSuggestionsEl.textContent = "";
  if (suggestions.length === 0) {
    searchSuggestionsEl.hidden = true;
    return;
  }
  for (const suggestion of suggestions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-suggestion-item";
    item.textContent = suggestion;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      confirmSearchSelection(suggestion);
    });
    searchSuggestionsEl.appendChild(item);
  }
  searchSuggestionsEl.hidden = false;
}

function isMegaPokemonName(name) {
  return String(name || "").toLowerCase().includes("-mega");
}

function displayStatPointsValue(value) {
  return value === 252 ? 66 : value;
}

function isDefaultStageSelection() {
  return selectedStages.size === DEFAULT_STAGE_VALUES.size
    && sortedNumericValues(selectedStages).every((value, index) => value === sortedNumericValues(DEFAULT_STAGE_VALUES)[index]);
}

function isDefaultNatureSelection() {
  const defaults = ["negative", "neutral", "positive"];
  const current = sortedStringValues(selectedNatures);
  return current.length === defaults.length && current.every((value, index) => value === defaults[index]);
}

function isDefaultStatPointSelection() {
  const current = sortedNumericValues(selectedEvs);
  return current.length === 2 && current[0] === 0 && current[1] === 252;
}

function syncUrlState() {
  const params = new URLSearchParams();

  if (activeRulesetId !== NATIONAL_DEX_RULESET_ID) {
    params.set("ruleset", activeRulesetId);
  }
  if (includeTailwindOnBoxes) {
    params.set("tailwind", "1");
  }
  if (includeScarfBoxes) {
    params.set("choiceScarf", "1");
  }
  if (searchConfirmedName) {
    params.set("search", searchConfirmedName);
  }
  if (!isDefaultStageSelection()) {
    params.set("stages", sortedNumericValues(selectedStages).join(","));
  }
  if (!isDefaultNatureSelection()) {
    params.set("natures", sortedStringValues(selectedNatures).join(","));
  }
  if (!isDefaultStatPointSelection()) {
    params.set("statPoints", sortedNumericValues(selectedEvs).join(","));
  }
  if (expandedBlockKeys.size > 0) {
    params.set("blocks", sortedStringValues(expandedBlockKeys).join(","));
  }
  if (expandedTierKeys.size > 0) {
    params.set("tiers", sortedStringValues(expandedTierKeys).join(","));
  }
  if (expandedBoxKeys.size > 0) {
    params.set("boxes", sortedStringValues(expandedBoxKeys).join(","));
  }
  if (pinnedPokemonKeys.size > 0) {
    params.set("pinnedPokemon", sortedStringValues(pinnedPokemonKeys).join(","));
  }
  if (pinnedTierKeys.size > 0) {
    params.set("pinnedTiers", sortedStringValues(pinnedTierKeys).join(","));
  }

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const rulesetId = params.get("ruleset");
  if (rulesetId) {
    activeRulesetId = rulesetId;
  }

  includeTailwindOnBoxes = params.get("tailwind") === "1";
  includeScarfBoxes = params.get("choiceScarf") === "1";

  const normalizedSearch = normalizeSearch(params.get("search"));
  searchConfirmedName = normalizedSearch;
  if (searchInputEl && normalizedSearch) {
    searchInputEl.value = normalizedSearch;
  }

  const stageValues = parseCsvParam(params, "stages")
    .map((value) => Number(value))
    .filter((value) => STAGE_VALUES.includes(value));
  if (stageValues.length > 0) {
    setValues(selectedStages, stageValues);
  }

  const natureValues = parseCsvParam(params, "natures")
    .filter((value) => ["positive", "neutral", "negative"].includes(value));
  if (natureValues.length > 0) {
    setValues(selectedNatures, natureValues);
  }

  const statPointValues = parseCsvParam(params, "statPoints")
    .map((value) => Number(value))
    .filter((value) => value === 0 || value === 252);
  if (statPointValues.length > 0) {
    setValues(selectedEvs, statPointValues);
  }

  setValues(expandedBlockKeys, parseCsvParam(params, "blocks"));
  setValues(expandedTierKeys, parseCsvParam(params, "tiers"));
  setValues(expandedBoxKeys, parseCsvParam(params, "boxes"));
  setValues(pinnedPokemonKeys, parseCsvParam(params, "pinnedPokemon"));
  setValues(pinnedTierKeys, parseCsvParam(params, "pinnedTiers"));
}

function getPokemonByName(name) {
  const normalized = normalizeSearch(name);
  return allPokemon.find((pokemon) => pokemon.name.toLowerCase() === normalized) || null;
}

function getVisibleTierByKey(tierKey) {
  return visibleTiers.find((tier) => getTierKey(tier) === String(tierKey)) || null;
}

function togglePinnedPokemon(pinKey) {
  const normalized = String(pinKey || "").trim();
  if (!normalized) return;
  if (pinnedPokemonKeys.has(normalized)) {
    pinnedPokemonKeys.delete(normalized);
  } else {
    pinnedPokemonKeys.add(normalized);
  }
  renderTiers(visibleTiers);
}

function togglePinnedTier(tierKey) {
  const normalized = String(tierKey);
  if (pinnedTierKeys.has(normalized)) {
    pinnedTierKeys.delete(normalized);
  } else {
    pinnedTierKeys.add(normalized);
  }
  renderTiers(visibleTiers);
}

function jumpToVisiblePokemon(pinKey) {
  const selector = `[data-pin-key="${cssEscapeValue(String(pinKey))}"]`;
  const target = document.querySelector(selector);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function jumpToVisibleTier(tierKey) {
  const selector = `[data-tier-key="${cssEscapeValue(String(tierKey))}"]`;
  const target = document.querySelector(selector);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderCompareTray() {
  if (!compareTrayEl || !comparePokemonListEl || !compareTierListEl) return;

  comparePokemonListEl.textContent = "";
  compareTierListEl.textContent = "";

  for (const pinKey of sortedStringValues(pinnedPokemonKeys)) {
    const pinned = parsePinnedPokemonKey(pinKey);
    const pokemon = pinned ? getPokemonByName(pinned.name) : null;
    const item = document.createElement("article");
    item.className = "compare-card";

    const heading = document.createElement("div");
    heading.className = "compare-card-heading";
    heading.textContent = pokemon ? pokemon.name : (pinned?.name || pinKey);
    item.appendChild(heading);

    const meta = document.createElement("div");
    meta.className = "compare-card-meta";
    meta.textContent = pinned
      ? `Speed ${pinned.finalSpeed} | Stat Points ${displayStatPointsValue(pinned.preset.ev)} | ${(pinned.preset.nature.charAt(0).toUpperCase() + pinned.preset.nature.slice(1))} Nature | Stage ${stageLabel(pinned.preset.stage)} | ${pinned.preset.tailwind ? "Tailwind" : "No Tailwind"} | ${pinned.preset.choiceScarf ? "Choice Scarf" : "No Choice Scarf"}`
      : "Not in loaded dataset";
    item.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "compare-card-actions";

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "compare-card-btn";
    jumpBtn.textContent = "Jump";
    jumpBtn.disabled = !document.querySelector(`[data-pin-key="${cssEscapeValue(pinKey)}"]`);
    jumpBtn.addEventListener("click", () => jumpToVisiblePokemon(pinKey));
    actions.appendChild(jumpBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "compare-card-btn compare-card-btn-muted";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => togglePinnedPokemon(pinKey));
    actions.appendChild(removeBtn);

    item.appendChild(actions);
    comparePokemonListEl.appendChild(item);
  }

  for (const tierKey of sortedStringValues(pinnedTierKeys)) {
    const tier = getVisibleTierByKey(tierKey) || allTiers.find((entry) => getTierKey(entry) === tierKey) || null;
    const item = document.createElement("article");
    item.className = "compare-card";

    const heading = document.createElement("div");
    heading.className = "compare-card-heading";
    heading.textContent = tier ? `Speed ${tier.finalSpeed}` : `Speed ${tierKey}`;
    item.appendChild(heading);

    const meta = document.createElement("div");
    meta.className = "compare-card-meta";
    meta.textContent = tier
      ? `Total Count ${getTierTotalCount(tier)}${getVisibleTierByKey(tierKey) ? "" : " | Not in current view"}`
      : "Not in loaded dataset";
    item.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "compare-card-actions";

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "compare-card-btn";
    jumpBtn.textContent = "Jump";
    jumpBtn.disabled = !document.querySelector(`[data-tier-key="${cssEscapeValue(tierKey)}"]`);
    jumpBtn.addEventListener("click", () => jumpToVisibleTier(tierKey));
    actions.appendChild(jumpBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "compare-card-btn compare-card-btn-muted";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => togglePinnedTier(tierKey));
    actions.appendChild(removeBtn);

    item.appendChild(actions);
    compareTierListEl.appendChild(item);
  }

  if (comparePokemonListEl.childElementCount === 0) {
    const empty = document.createElement("div");
    empty.className = "compare-empty";
    empty.textContent = "No pinned Pokémon yet.";
    comparePokemonListEl.appendChild(empty);
  }

  if (compareTierListEl.childElementCount === 0) {
    const empty = document.createElement("div");
    empty.className = "compare-empty";
    empty.textContent = "No pinned speed tiers yet.";
    compareTierListEl.appendChild(empty);
  }

  compareTrayEl.hidden = pinnedPokemonKeys.size === 0 && pinnedTierKeys.size === 0;
}

function summarizePreset(preset) {
  const tailwind = preset.tailwind ? "Tailwind" : "No Tailwind";
  const scarf = preset.choiceScarf ? "Choice Scarf" : "No Choice Scarf";
  const natureMap = {
    positive: "Positive Nature",
    negative: "Negative Nature",
    neutral: "Neutral Nature",
  };
  const natureLabel = natureMap[preset.nature] || `${preset.nature} Nature`;
  return `Base ${preset.baseSpeed} | Stat Points ${displayStatPointsValue(preset.ev)} | ${natureLabel} | Stage ${stageLabel(preset.stage)} | ${tailwind} | ${scarf}`;
}

function createPokemonTile(p, context) {
  const tile = document.createElement("div");
  tile.className = "pokemon-tile";
  tile.dataset.pokemonName = normalizeSearch(p.name);
  const pinKey = getPinnedPokemonKey(p, context.preset, context.finalSpeed);
  tile.dataset.pinKey = pinKey;

  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = `pin-btn${pinnedPokemonKeys.has(pinKey) ? " active" : ""}`;
  pinBtn.textContent = pinnedPokemonKeys.has(pinKey) ? "Pinned" : "Pin";
  pinBtn.setAttribute("aria-pressed", pinnedPokemonKeys.has(pinKey) ? "true" : "false");
  pinBtn.setAttribute("aria-label", `${pinnedPokemonKeys.has(pinKey) ? "Unpin" : "Pin"} ${p.name}`);
  pinBtn.addEventListener("click", () => {
    togglePinnedPokemon(pinKey);
    pinBtn.classList.toggle("active", pinnedPokemonKeys.has(pinKey));
    pinBtn.textContent = pinnedPokemonKeys.has(pinKey) ? "Pinned" : "Pin";
    pinBtn.setAttribute("aria-pressed", pinnedPokemonKeys.has(pinKey) ? "true" : "false");
    pinBtn.setAttribute("aria-label", `${pinnedPokemonKeys.has(pinKey) ? "Unpin" : "Pin"} ${p.name}`);
  });
  tile.appendChild(pinBtn);

  const frame = document.createElement("div");
  frame.className = "sprite-frame";
  if (p.spriteSource === "fallback") {
    frame.classList.add("sprite-frame-fallback");
  }
  tile.appendChild(frame);

  if (atlasMeta && p.spriteAtlas) {
    const sprite = document.createElement("div");
    sprite.className = "sprite sprite-atlas";
    sprite.setAttribute("role", "img");
    sprite.setAttribute("aria-label", p.name);
    const atlasPath = atlasMeta.path;
    const tileSize = p.spriteAtlas.size || atlasMeta.tileSize || 60;
    const bgWidth = atlasMeta.columns * atlasMeta.tileSize;
    const bgHeight = atlasMeta.rows * atlasMeta.tileSize;
    sprite.style.width = `${tileSize}px`;
    sprite.style.height = `${tileSize}px`;
    sprite.style.backgroundImage = `url('${atlasPath}')`;
    sprite.style.backgroundPosition = `-${p.spriteAtlas.x}px -${p.spriteAtlas.y}px`;
    sprite.style.backgroundSize = `${bgWidth}px ${bgHeight}px`;
    frame.appendChild(sprite);
  } else if (p.spriteSource === "fallback") {
    const placeholder = document.createElement("div");
    placeholder.className = "sprite-fallback-placeholder";
    placeholder.setAttribute("aria-label", `${p.name} placeholder`);
    placeholder.textContent = "No Sprite";
    frame.appendChild(placeholder);
  } else {
    const img = document.createElement("img");
    img.className = "sprite";
    if (p.spriteSource) {
      img.classList.add(`sprite-source-${p.spriteSource}`);
    }
    img.src = p.spritePath;
    img.alt = p.name;
    img.addEventListener("error", () => {
      img.removeAttribute("src");
      img.alt = p.name;
    });
    frame.appendChild(img);
  }

  const name = document.createElement("div");
  name.className = "pokemon-name";
  name.textContent = p.name;
  tile.appendChild(name);

  return tile;
}

function createBox(box, tierFinalSpeed, boxKey, onExpandedChange, initiallyExpanded = false) {
  const article = document.createElement("article");
  article.className = "box";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "box-toggle";
  button.setAttribute("aria-expanded", initiallyExpanded ? "true" : "false");
  button.textContent = `${summarizePreset(box.preset)} | Count ${box.pokemon.length}`;

  const details = document.createElement("div");
  details.className = "box-details";
  details.hidden = !initiallyExpanded;
  if (initiallyExpanded) {
    expandedBoxKeys.add(boxKey);
  }

  const grid = document.createElement("div");
  grid.className = "pokemon-grid";
  for (const p of box.pokemon) {
    grid.appendChild(createPokemonTile(p, { finalSpeed: tierFinalSpeed, preset: box.preset }));
  }
  details.appendChild(grid);

  const setExpanded = (expanded) => {
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    details.hidden = !expanded;
    if (expanded) {
      expandedBoxKeys.add(boxKey);
    } else {
      expandedBoxKeys.delete(boxKey);
    }
    if (typeof onExpandedChange === "function") {
      onExpandedChange();
    }
  };

  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    setExpanded(!expanded);
  });

  article.appendChild(button);
  article.appendChild(details);
  return {
    element: article,
    isExpanded: () => button.getAttribute("aria-expanded") === "true",
    setExpanded,
  };
}

function getTierTotalCount(tier) {
  return tier.boxes.reduce((sum, box) => sum + box.pokemon.length, 0);
}

function getVisiblePokemonCount(tiers) {
  const ids = new Set();
  for (const tier of tiers) {
    for (const box of tier.boxes) {
      for (const pokemon of box.pokemon) {
        ids.add(pokemon.id);
      }
    }
  }
  return ids.size;
}

function buildTierClipboardText(tier) {
  const lines = [];
  for (const box of tier.boxes) {
    const pokemonLine = box.pokemon.map((p) => p.name).join(", ");
    lines.push(
      `Speed ${tier.finalSpeed} | ${summarizePreset(box.preset)} | Count ${box.pokemon.length} | Pokemon: ${pokemonLine}`,
    );
  }

  return lines.join("\n");
}

function createTierSection(tier, onExpandedStateChange = null, options = {}) {
  const tierSection = document.createElement("section");
  tierSection.className = "tier";

  const tierTotalCount = getTierTotalCount(tier);
  const tierKey = getTierKey(tier);
  tierSection.dataset.tierKey = tierKey;
  const hasSingleBox = tier.boxes.length === 1;
  const initiallyExpanded = options.forceCollapsedDefault
    ? tierMatchesSearch(tier)
    : expandedTierKeys.has(tierKey) || tierMatchesSearch(tier);

  const headerRow = document.createElement("div");
  headerRow.className = "speed-tier-header";
  tierSection.appendChild(headerRow);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "speed-tier-toggle";
  toggle.setAttribute("aria-expanded", initiallyExpanded ? "true" : "false");
  toggle.textContent = `Speed ${tier.finalSpeed} | Total Count ${tierTotalCount}`;
  headerRow.appendChild(toggle);

  const details = document.createElement("div");
  details.className = "speed-tier-details";
  details.hidden = !initiallyExpanded;
  tierSection.appendChild(details);

  let rendered = false;
  let boxControllers = [];
  const actionGroup = document.createElement("div");
  actionGroup.className = "speed-tier-actions";
  headerRow.appendChild(actionGroup);

  const pinTierBtn = document.createElement("button");
  pinTierBtn.type = "button";
  pinTierBtn.className = `speed-tier-pin${pinnedTierKeys.has(tierKey) ? " active" : ""}`;
  pinTierBtn.textContent = pinnedTierKeys.has(tierKey) ? "Pinned Tier" : "Pin Tier";
  pinTierBtn.setAttribute("aria-pressed", pinnedTierKeys.has(tierKey) ? "true" : "false");
  pinTierBtn.addEventListener("click", () => {
    togglePinnedTier(tierKey);
    pinTierBtn.classList.toggle("active", pinnedTierKeys.has(tierKey));
    pinTierBtn.textContent = pinnedTierKeys.has(tierKey) ? "Pinned Tier" : "Pin Tier";
    pinTierBtn.setAttribute("aria-pressed", pinnedTierKeys.has(tierKey) ? "true" : "false");
  });
  actionGroup.appendChild(pinTierBtn);

  const tierActionBtn = document.createElement("button");
  tierActionBtn.type = "button";
  tierActionBtn.className = "speed-tier-action";
  actionGroup.appendChild(tierActionBtn);

  const updateTierActionLabel = () => {
    if (boxControllers.length === 0) {
      tierActionBtn.textContent = "Expand All Boxes";
      return;
    }
    const allExpanded = boxControllers.every((controller) => controller.isExpanded());
    tierActionBtn.textContent = allExpanded ? "Collapse All Boxes" : "Expand All Boxes";
  };

  const notifyExpandedStateChange = () => {
    updateTierActionLabel();
    if (typeof onExpandedStateChange === "function") {
      onExpandedStateChange();
    }
    syncUrlState();
  };

  const renderBoxes = () => {
    if (rendered) return;
    const boxes = document.createElement("div");
    boxes.className = "tier-boxes";
    for (const box of tier.boxes) {
      const boxKey = getBoxKey(tier.finalSpeed, box);
      const initialBoxExpanded = expandedBoxKeys.has(boxKey) || boxMatchesSearch(box);
      const controller = createBox(box, tier.finalSpeed, boxKey, notifyExpandedStateChange, initialBoxExpanded);
      boxControllers.push(controller);
      boxes.appendChild(controller.element);
    }
    details.appendChild(boxes);
    updateTierActionLabel();
    rendered = true;
  };

  tierActionBtn.addEventListener("click", () => {
    const tierExpanded = toggle.getAttribute("aria-expanded") === "true";
    if (!tierExpanded) {
      toggle.setAttribute("aria-expanded", "true");
      details.hidden = false;
    }
    renderBoxes();
    const allExpanded = boxControllers.every((controller) => controller.isExpanded());
    const targetExpandedState = !allExpanded;
    for (const controller of boxControllers) {
      controller.setExpanded(targetExpandedState);
    }
    notifyExpandedStateChange();
  });
  updateTierActionLabel();

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    const nextExpanded = !expanded;
    toggle.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    details.hidden = !nextExpanded;
    if (nextExpanded) {
      expandedTierKeys.add(tierKey);
    } else {
      expandedTierKeys.delete(tierKey);
    }
    syncUrlState();
    if (nextExpanded) {
      renderBoxes();
      if (hasSingleBox && boxControllers.length === 1) {
        boxControllers[0].setExpanded(true);
      }
    } else if (rendered) {
      for (const controller of boxControllers) {
        controller.setExpanded(false);
      }
    }
  });

  if (initiallyExpanded) {
    expandedTierKeys.add(tierKey);
    renderBoxes();
    if (hasSingleBox && boxControllers.length === 1) {
      boxControllers[0].setExpanded(true);
    }
  }

  const onTierContextMenu = async (event) => {
    event.preventDefault();
    try {
      await copyTextToClipboard(buildTierClipboardText(tier));
      setStatus(`Copied Speed ${tier.finalSpeed} details to clipboard.`);
    } catch (_err) {
      setStatus("Clipboard copy failed for this speed tier.");
    }
  };

  toggle.addEventListener("contextmenu", onTierContextMenu);
  tierSection.addEventListener("contextmenu", (event) => {
    if (event.target === toggle || toggle.contains(event.target)) {
      return;
    }
    onTierContextMenu(event);
  });

  return {
    element: tierSection,
    isExpanded: () => toggle.getAttribute("aria-expanded") === "true",
    setExpanded: (expanded) => {
      const currentlyExpanded = toggle.getAttribute("aria-expanded") === "true";
      if (currentlyExpanded === expanded) {
        if (expanded) {
          renderBoxes();
        }
        return;
      }
      toggle.click();
    },
    areAllBoxesExpanded: () => boxControllers.length > 0 && boxControllers.every((controller) => controller.isExpanded()),
    setAllBoxesExpanded: (expanded) => {
      if (!rendered) {
        renderBoxes();
      }
      for (const controller of boxControllers) {
        controller.setExpanded(expanded);
      }
      notifyExpandedStateChange();
    },
  };
}

function getBlockRangeForSpeed(finalSpeed) {
  if (finalSpeed <= SPEED_BLOCK_SIZE) {
    return { start: 0, end: SPEED_BLOCK_SIZE };
  }
  const start = Math.floor((finalSpeed - 1) / SPEED_BLOCK_SIZE) * SPEED_BLOCK_SIZE + 1;
  return { start, end: start + (SPEED_BLOCK_SIZE - 1) };
}

function groupTiersIntoSpeedBlocks(tiers) {
  const blockMap = new Map();

  for (const tier of tiers) {
    const range = getBlockRangeForSpeed(tier.finalSpeed);
    const key = `${range.start}-${range.end}`;
    if (!blockMap.has(key)) {
      blockMap.set(key, {
        key,
        start: range.start,
        end: range.end,
        tiers: [],
        totalCount: 0,
      });
    }

    const block = blockMap.get(key);
    block.tiers.push(tier);
    block.totalCount += getTierTotalCount(tier);
  }

  const blocks = Array.from(blockMap.values());
  blocks.sort((a, b) => b.end - a.end);
  for (const block of blocks) {
    block.tiers.sort((a, b) => b.finalSpeed - a.finalSpeed);
  }
  return blocks;
}

function isBlockExpandedByDefault(block) {
  return block.tiers.length === 1;
}

function updateGlobalBlockActionLabel() {
  if (!blockActionBtn) return;
  const allExpanded = visibleBlockControllers.length > 0
    && visibleBlockControllers.every((controller) => controller.isExpanded());
  blockActionBtn.textContent = allExpanded ? "Collapse All Speed Blocks" : "Expand All Speed Blocks";
}

function createSpeedBlockSection(block, onBlockExpandedStateChange = null) {
  const blockSection = document.createElement("section");
  blockSection.className = "speed-block";
  const hasSingleTier = block.tiers.length === 1;

  const blockMatchedBySearch = searchConfirmedName
    ? block.tiers.some((tier) => tierMatchesSearch(tier))
    : false;
  const expandedFromStoredState = expandedBlockKeys.has(block.key);
  const expandedByDefault = !blockMatchedBySearch && !expandedFromStoredState && isBlockExpandedByDefault(block);
  const initiallyExpanded = expandedFromStoredState || blockMatchedBySearch || expandedByDefault;

  const headerRow = document.createElement("div");
  headerRow.className = "speed-block-header";
  blockSection.appendChild(headerRow);

  const blockToggle = document.createElement("button");
  blockToggle.type = "button";
  blockToggle.className = "speed-block-toggle";
  blockToggle.setAttribute("aria-expanded", initiallyExpanded ? "true" : "false");
  blockToggle.textContent = `${block.start}-${block.end} | Total Count ${block.totalCount}`;
  headerRow.appendChild(blockToggle);

  const blockTierActionBtn = document.createElement("button");
  blockTierActionBtn.type = "button";
  blockTierActionBtn.className = "speed-block-action";
  headerRow.appendChild(blockTierActionBtn);

  const blockDetails = document.createElement("div");
  blockDetails.className = "speed-block-details";
  blockDetails.hidden = !initiallyExpanded;
  blockSection.appendChild(blockDetails);

  let rendered = false;
  let tierControllers = [];

  const updateBlockTierActionLabel = () => {
    if (tierControllers.length === 0) {
      blockTierActionBtn.textContent = "Expand All Boxes";
      return;
    }
    const allExpanded = tierControllers.every((controller) => controller.areAllBoxesExpanded());
    blockTierActionBtn.textContent = allExpanded ? "Collapse All Boxes" : "Expand All Boxes";
  };

  const notifyBlockExpandedStateChange = () => {
    updateGlobalBlockActionLabel();
    if (typeof onBlockExpandedStateChange === "function") {
      onBlockExpandedStateChange();
    }
    syncUrlState();
  };

  const renderTiers = () => {
    if (rendered) return;
    for (const tier of block.tiers) {
      const controller = createTierSection(
        tier,
        updateBlockTierActionLabel,
        { forceCollapsedDefault: expandedByDefault },
      );
      tierControllers.push(controller);
      blockDetails.appendChild(controller.element);
    }
    updateBlockTierActionLabel();
    rendered = true;
  };

  const syncSinglePathWithBlock = (expanded) => {
    if (!hasSingleTier) {
      return;
    }
    if (!rendered) {
      renderTiers();
    }
    if (tierControllers.length === 1) {
      tierControllers[0].setExpanded(expanded);
    }
  };

  if (initiallyExpanded) {
    renderTiers();
    syncSinglePathWithBlock(true);
  }

  blockTierActionBtn.addEventListener("click", () => {
    if (!rendered) {
      renderTiers();
    }
    const expanded = blockToggle.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      blockToggle.setAttribute("aria-expanded", "true");
      blockDetails.hidden = false;
      expandedBlockKeys.add(block.key);
      notifyBlockExpandedStateChange();
    }
    const allExpanded = tierControllers.length > 0
      && tierControllers.every((controller) => controller.areAllBoxesExpanded());
    const targetExpandedState = !allExpanded;
    for (const controller of tierControllers) {
      controller.setAllBoxesExpanded(targetExpandedState);
    }
    updateBlockTierActionLabel();
  });
  updateBlockTierActionLabel();

  blockToggle.addEventListener("click", () => {
    const expanded = blockToggle.getAttribute("aria-expanded") === "true";
    const nextExpanded = !expanded;
    blockToggle.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    blockDetails.hidden = !nextExpanded;
    if (nextExpanded) {
      expandedBlockKeys.add(block.key);
    } else {
      expandedBlockKeys.delete(block.key);
    }
    notifyBlockExpandedStateChange();
    if (nextExpanded) {
      renderTiers();
    }
    syncSinglePathWithBlock(nextExpanded);
  });

  if (initiallyExpanded) {
    expandedBlockKeys.add(block.key);
  }

  return {
    element: blockSection,
    isExpanded: () => blockToggle.getAttribute("aria-expanded") === "true",
    setExpanded: (expanded) => {
      const currentlyExpanded = blockToggle.getAttribute("aria-expanded") === "true";
      if (currentlyExpanded === expanded) {
        if (expanded) {
          renderTiers();
        }
        return;
      }
      blockToggle.click();
    },
  };
}

function clearTiers() {
  if (tiersEl) {
    tiersEl.textContent = "";
  }
}

function renderTiers(tiers) {
  clearTiers();
  if (sentinelEl) {
    sentinelEl.hidden = true;
  }
  visibleBlockControllers = [];

  if (tiers.length === 0) {
    if (resultsActionsEl) {
      resultsActionsEl.hidden = true;
    }
    setStatus("No tiers to display for current filters.");
    renderCompareTray();
    syncUrlState();
    return;
  }

  const blocks = groupTiersIntoSpeedBlocks(tiers);
  const pokemonCount = getVisiblePokemonCount(tiers);
  const searchSuffix = searchConfirmedName ? ` | Search: "${searchConfirmedName}"` : "";
  setStatus(`Showing ${pokemonCount} Pokémon across ${tiers.length} speed tiers in ${blocks.length} blocks${searchSuffix}`);
  if (resultsActionsEl) {
    resultsActionsEl.hidden = false;
  }

  for (const block of blocks) {
    if (tiersEl) {
      const controller = createSpeedBlockSection(block, updateGlobalBlockActionLabel);
      visibleBlockControllers.push(controller);
      tiersEl.appendChild(controller.element);
    }
  }
  updateGlobalBlockActionLabel();
  renderCompareTray();
  syncUrlState();
}

function applyLocalBoxFilters(tiers) {
  const filtered = [];
  for (const tier of tiers) {
    const boxes = [];
    for (const box of tier.boxes) {
      if (!selectedStages.has(box.preset.stage)) {
        continue;
      }
      if (!includeTailwindOnBoxes && box.preset.tailwind) {
        continue;
      }
      if (!includeScarfBoxes && box.preset.choiceScarf) {
        continue;
      }
      if (!selectedNatures.has(box.preset.nature)) {
        continue;
      }
      if (!selectedEvs.has(box.preset.ev)) {
        continue;
      }

      let members = box.pokemon;
      // Mega forms cannot hold Choice Scarf.
      if (box.preset.choiceScarf) {
        members = members.filter((p) => !isMegaPokemonName(p.name));
      }

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

function refreshView() {
  let tiers = applyLocalBoxFilters(allTiers);
  if (activeRulesetId !== NATIONAL_DEX_RULESET_ID) {
    const ids = rulesetAllowedIdsById.get(activeRulesetId) || new Set();
    tiers = applyRulesetFilter(tiers, ids);
  }
  visibleTiers = tiers;
  renderTiers(visibleTiers);
}

function renderRulesetControls() {
  if (!rulesetControlsEl) return;
  rulesetControlsEl.textContent = "";

  const allBtn = createToggleButton(NATIONAL_DEX_LABEL, () => {
    activeRulesetId = NATIONAL_DEX_RULESET_ID;
    renderRulesetControls();
    refreshView();
  }, activeRulesetId === NATIONAL_DEX_RULESET_ID);
  rulesetControlsEl.appendChild(allBtn);

  for (const ruleset of allRulesets) {
    const btn = createToggleButton(
      ruleset.label,
      () => {
        activeRulesetId = ruleset.id;
        renderRulesetControls();
        refreshView();
      },
      activeRulesetId === ruleset.id,
    );
    rulesetControlsEl.appendChild(btn);
  }
}

function renderStageControls() {
  if (!stageControlsEl) return;
  stageControlsEl.textContent = "";

  stageControlsEl.classList.add("stage-controls");

  const createStageButton = (stage) => createToggleButton(stageLabel(stage), () => {
    if (selectedStages.has(stage)) {
      selectedStages.delete(stage);
    } else {
      selectedStages.add(stage);
    }
    renderStageControls();
    refreshView();
  }, selectedStages.has(stage));

  const negativeRow = document.createElement("div");
  negativeRow.className = "stage-row";
  for (const stage of [-6, -5, -4, -3, -2, -1]) {
    negativeRow.appendChild(createStageButton(stage));
  }

  const positiveRow = document.createElement("div");
  positiveRow.className = "stage-row";
  for (const stage of [0, 1, 2, 3, 4, 5, 6]) {
    positiveRow.appendChild(createStageButton(stage));
  }

  stageControlsEl.appendChild(negativeRow);
  stageControlsEl.appendChild(positiveRow);
}

function renderModifierControls() {
  if (!modifierControlsEl) return;
  modifierControlsEl.textContent = "";

  modifierControlsEl.appendChild(
    createToggleButton(
      "Tailwind",
      () => {
        includeTailwindOnBoxes = !includeTailwindOnBoxes;
        renderModifierControls();
        refreshView();
      },
      includeTailwindOnBoxes,
    ),
  );

  modifierControlsEl.appendChild(
    createToggleButton(
      "Choice Scarf",
      () => {
        includeScarfBoxes = !includeScarfBoxes;
        renderModifierControls();
        refreshView();
      },
      includeScarfBoxes,
    ),
  );
}

function renderNatureControls() {
  if (!natureControlsEl) return;
  natureControlsEl.textContent = "";
  const options = [
    { label: "Positive", value: "positive" },
    { label: "Neutral", value: "neutral" },
    { label: "Negative", value: "negative" },
  ];

  for (const option of options) {
    natureControlsEl.appendChild(
      createToggleButton(
        option.label,
        () => {
          if (selectedNatures.has(option.value)) {
            selectedNatures.delete(option.value);
          } else {
            selectedNatures.add(option.value);
          }
          renderNatureControls();
          refreshView();
        },
        selectedNatures.has(option.value),
      ),
    );
  }
}

function renderEvControls() {
  if (!evControlsEl) return;
  evControlsEl.textContent = "";
  for (const value of [0, 252]) {
    evControlsEl.appendChild(
      createToggleButton(
        `${displayStatPointsValue(value)} Points`,
        () => {
          if (selectedEvs.has(value)) {
            selectedEvs.delete(value);
          } else {
            selectedEvs.add(value);
          }
          renderEvControls();
          refreshView();
        },
        selectedEvs.has(value),
      ),
    );
  }
}

function validateData(pokemonPayload, rulesetsPayload) {
  if (!pokemonPayload || !Array.isArray(pokemonPayload.pokemon)) {
    throw new Error("Invalid pokemon.json: missing pokemon[]");
  }
  if (!rulesetsPayload || !Array.isArray(rulesetsPayload.rulesets)) {
    throw new Error("Invalid rulesets.json: missing rulesets[]");
  }
  if (
    "defaultRulesetId" in rulesetsPayload
    && typeof rulesetsPayload.defaultRulesetId !== "string"
  ) {
    throw new Error("Invalid rulesets.json: defaultRulesetId must be a string");
  }

  for (const p of pokemonPayload.pokemon) {
    if (typeof p.id !== "number" || typeof p.name !== "string" || typeof p.baseSpeed !== "number" || typeof p.spritePath !== "string") {
      throw new Error("Invalid pokemon.json entry shape");
    }
  }
}

async function init() {
  try {
    const [pokemonPayload, rulesetsPayload] = await Promise.all([
      loadJson("./pokemon.json"),
      loadJson("./rulesets.json"),
    ]);

    validateData(pokemonPayload, rulesetsPayload);

    allPokemon = pokemonPayload.pokemon.slice().sort((a, b) => a.id - b.id);
    atlasMeta = pokemonPayload.spriteAtlas || null;
    allRulesets = rulesetsPayload.rulesets;
    activeRulesetId = rulesetsPayload.defaultRulesetId || NATIONAL_DEX_RULESET_ID;

    const pokemonByName = new Map(allPokemon.map((p) => [p.name.toLowerCase(), p.id]));
    rulesetAllowedIdsById.clear();
    for (const ruleset of allRulesets) {
      rulesetAllowedIdsById.set(ruleset.id, getRulesetIds(ruleset, pokemonByName));
    }
    applyUrlState();
    if (
      activeRulesetId !== NATIONAL_DEX_RULESET_ID
      && !rulesetAllowedIdsById.has(activeRulesetId)
    ) {
      activeRulesetId = rulesetsPayload.defaultRulesetId || NATIONAL_DEX_RULESET_ID;
    }

    setStatus("Computing speed tiers...");
    allTiers = buildSpeedTiers(allPokemon);

    renderRulesetControls();
    renderStageControls();
    renderModifierControls();
    renderNatureControls();
    renderEvControls();
    searchablePokemonNames = Array.from(
      new Set(allPokemon.map((p) => String(p.name || "").toLowerCase())),
    ).sort((a, b) => a.localeCompare(b));
    if (searchInputEl) {
      searchInputEl.addEventListener("input", () => {
        const typed = normalizeSearch(searchInputEl.value);
        if (!typed) {
          searchConfirmedName = "";
          hideSearchSuggestions();
          refreshView();
          return;
        }
        if (typed !== searchConfirmedName) {
          searchConfirmedName = "";
          refreshView();
        }
        renderSearchSuggestions(typed);
      });
      searchInputEl.addEventListener("keydown", (event) => {
        const typed = normalizeSearch(searchInputEl.value);
        const suggestions = getSearchSuggestions(typed);
        if ((event.key === "Tab" || event.key === "Enter") && suggestions.length > 0) {
          event.preventDefault();
          const exact = suggestions.find((s) => s === typed);
          confirmSearchSelection(exact || suggestions[0]);
        }
        if (event.key === "Escape") {
          hideSearchSuggestions();
        }
      });
      searchInputEl.addEventListener("blur", () => {
        setTimeout(() => hideSearchSuggestions(), 120);
      });
    }
    refreshView();
  } catch (err) {
    showError(String(err.message || err));
  }
}

if (clearCompareBtn) {
  clearCompareBtn.addEventListener("click", () => {
    pinnedPokemonKeys.clear();
    pinnedTierKeys.clear();
    renderTiers(visibleTiers);
  });
}

if (blockActionBtn) {
  blockActionBtn.addEventListener("click", () => {
    const allExpanded = visibleBlockControllers.length > 0
      && visibleBlockControllers.every((controller) => controller.isExpanded());
    const targetExpandedState = !allExpanded;
    for (const controller of visibleBlockControllers) {
      controller.setExpanded(targetExpandedState);
    }
    updateGlobalBlockActionLabel();
  });
}

init();
