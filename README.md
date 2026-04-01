# SpeedTier

SpeedTier is a static Pokemon speed-tier site generator and browser. It pulls Pokemon data from PokeAPI, builds a local dataset and sprite bundle, then outputs a deployable `dist/` directory containing JSON data, frontend assets, and generated sprites.

The UI is designed for Level 50 speed comparison. It groups Pokemon by final Speed across common competitive presets and lets users filter by ruleset, stat stage, nature, EV spread, Tailwind, Choice Scarf, and Pokemon search.

## What It Does

- Builds a full dataset from PokeAPI into `dist/pokemon.json`
- Builds named rulesets from `build_config.json` into `dist/rulesets.json`
- Emits deployment metadata into `dist/manifest.json`
- Downloads sprites and can pack them into a single sprite atlas
- Serves a built-in full-dataset mode called `National Dex`
- Allows one configured ruleset to be the default selection on page load
- Validates configured rulesets against the actual built dataset before deployment output is written

## Current Speed Model

The frontend speed logic is in [web/speed.js](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/web/speed.js).

Current assumptions:

- Level is fixed at 50
- IV is fixed at 31
- EV presets are `0` and `252`
- Nature presets are `positive`, `neutral`, and `negative`
- Stat stages run from `-6` to `+6`
- Tailwind and Choice Scarf are both modeled
- Mega forms are excluded from Choice Scarf boxes in the UI

This means the tool is intentionally a compact reference, not a full arbitrary-stat calculator.

## Repository Layout

- [build_speedtiers.py](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/build_speedtiers.py): build script for data, sprites, validation, and static output
- [build_config.json](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/build_config.json): deployment/build configuration
- [web/index.html](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/web/index.html): static app shell
- [web/app.js](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/web/app.js): UI logic and filtering
- [web/speed.js](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/web/speed.js): speed formulas and tier construction
- [web/styles.css](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/web/styles.css): static styling
- [tests/test_build_speedtiers.py](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/tests/test_build_speedtiers.py): Python tests for builder behavior
- [tests/speed.test.js](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/tests/speed.test.js): Node tests for frontend speed logic
- [tests/speed_check.mjs](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/tests/speed_check.mjs): lightweight direct check script for speed logic
- [dist/](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/dist): generated deployable output

## Requirements

- Python 3
- Pillow if sprite atlas generation is enabled
- Node.js only if you want to run the web tests
- Network access for full data builds from PokeAPI

Install Pillow if needed:

```powershell
pip install pillow
```

## Build Configuration

The build is controlled by [build_config.json](/abs/path/c:/Users/james/OneDrive/Documents/06%20Leisure%20and%20Personal%20Projects/Personal%20Projects/2026/SpeedTier/build_config.json).

Key fields:

- `schemaVersion`: config schema version string
- `includePokemon`: controls which Pokemon are pulled into the built dataset
- `defaultRulesetId`: default selected ruleset in the UI
- `rulesets`: named ruleset filters
- `sprites`: sprite download, atlas, timeout, and rate-limit settings

### `includePokemon`

Supported modes:

- `{"mode": "all"}`: pull the full available Pokemon dataset from PokeAPI
- `{"mode": "byList", "pokemonIds": [...]}`: build only specific numeric Pokemon ids

If you want a full National Dex deployment, use `mode: "all"`.

### `defaultRulesetId`

`defaultRulesetId` can be:

- `NationalDex` for the built-in full dataset mode
- The `id` of one configured ruleset

`NationalDex` is reserved and cannot be reused as a custom ruleset id.

### Rulesets

Each ruleset must contain exactly one of:

- `pokemonIds`
- `pokemonNames`

Name-based rulesets are normalized to lowercase during output. The frontend resolves them against the built dataset by exact name match.

## Build Commands

Full rebuild:

```powershell
python build_speedtiers.py --out dist --config build_config.json
```

Clean rebuild:

```powershell
python build_speedtiers.py --out dist --config build_config.json --clean
```

Reuse an existing local dataset and sprites while still rebuilding rulesets, manifest, and static assets:

```powershell
python build_speedtiers.py --out dist --config build_config.json --reuse-existing
```

Notes:

- `--clean` and `--reuse-existing` cannot be combined
- `--reuse-existing` still validates the existing dataset and rulesets
- On Windows/OneDrive, the build script includes retry logic for output-folder cleanup

## Output Files

### `dist/pokemon.json`

Contains:

- generated timestamp
- full built Pokemon dataset
- base Speed per entry
- sprite path and sprite source
- optional sprite atlas metadata

This file is the full source of truth for the built `National Dex` mode.

### `dist/rulesets.json`

Contains:

- `defaultRulesetId`
- normalized named rulesets

The built-in `National Dex` option is not stored as a normal ruleset entry. It is injected by the frontend as an always-available unfiltered mode.

### `dist/manifest.json`

Contains:

- generated timestamp
- `defaultRulesetId`
- Pokemon count
- fallback sprite count
- sprite source counts
- fallback sprite path
- atlas repair count when relevant

## Validation and Deployment Safety

The build performs several validations before finishing:

- config structure validation
- dataset shape and sprite-path validation
- ruleset validation against the actual built dataset

Ruleset validation is especially important for deployment. If a ruleset references Pokemon that are not present in the built dataset, the build:

- prints all missing ids and/or names to stderr
- reports them across all affected rulesets
- fails the build after listing the full set of errors

This prevents silent omissions caused by misspellings, wrong form names, or non-PokeAPI-compliant naming.

## Frontend Behavior

The frontend loads only:

- `pokemon.json`
- `rulesets.json`

It then computes tiers client-side and renders:

- the built-in `National Dex` button
- configured ruleset buttons
- stat-stage, modifier, nature, EV, and search controls

The status line shows:

- visible Pokemon count
- visible speed tier count
- visible speed block count

The UI also supports:

- click-to-expand tier and block sections
- expand/collapse all boxes within a tier
- right-click copy of a tier summary to clipboard
- sprite atlas rendering when atlas metadata is present

## Sprites

Sprite source priority in the builder is:

1. Pokemon Home
2. Scarlet/Violet
3. Emerald
4. BDSP
5. `front_default`
6. fallback image

If atlas generation is enabled:

- sprites are resized into square tiles
- a combined atlas is generated
- temporary individual sprite files are removed
- unreadable sprite files are repaired with the fallback image

## Testing

Python builder tests:

```powershell
python -m unittest tests.test_build_speedtiers
```

Node frontend logic tests:

```powershell
npm run test:web
```

Optional direct speed check:

```powershell
node tests/speed_check.mjs
```

## Deployment

Deploy the contents of `dist/` as a static site. No server-side runtime is required.

Typical deployment flow:

1. Update `build_config.json`
2. Run the build
3. Confirm validation passes
4. Publish `dist/`

## Current Default Configuration

At the time of writing:

- `includePokemon.mode` is `all`
- the built-in full dataset mode is `National Dex`
- `defaultRulesetId` is `ChampionsFullDex`

If you want the site to open on the full dataset instead, set:

```json
{
  "defaultRulesetId": "NationalDex"
}
```

## Sources and Licenses

### Data Source

- Primary Pokemon data source: [PokeAPI](https://pokeapi.co/)
- PokeAPI API repository: [PokeAPI/pokeapi](https://github.com/PokeAPI/pokeapi)
- Static PokeAPI data repository: [PokeAPI/api-data](https://github.com/PokeAPI/api-data)
- Reported repository license for both `pokeapi` and `api-data`: BSD 3-Clause

### Sprite and Asset Sources

Pokemon sprites are resolved from the sprite URLs exposed by PokeAPI metadata. In this project, the builder prefers the following sources in order:

1. Pokemon Home
2. Scarlet/Violet
3. Emerald
4. Brilliant Diamond / Shining Pearl
5. PokeAPI `front_default`
6. locally generated fallback image

Relevant upstream sprite repository:

- [PokeAPI/sprites](https://github.com/PokeAPI/sprites)

Important licensing / provenance note:

- The `PokeAPI/sprites` repository contains a mixed-provenance sprite collection and ships its own `LICENCE.txt`
- The upstream README documents that some sprite folders include community-created work, including Smogon community sprite contributions in certain sprite sets
- The upstream README also explicitly notes custom shiny official-artwork contributors and community-created Black/White-style sprites for later generations

Additional upstream reference for Smogon sprite provenance:

- [smogon/sprites](https://github.com/smogon/sprites)
- The repository code is MIT-licensed
- Its README states that the sprites themselves are property of Nintendo / Game Freak / The Pokemon Company, with some community-created sprite licensing still being determined

### Favicon

- Favicon asset: Poke Ball item sprite from `PokeAPI/sprites`
- Current favicon path used by the site: `sprites/items/poke-ball.png`

### Local Fallback Assets

- The fallback sprite used by this project is generated locally by the build script as a 1x1 transparent PNG
- This fallback image is not downloaded from an external source

### Code Method

- Primary external data provider: PokeAPI
- Development method for this project: vibecoding / AI-assisted iterative development

This section is intended as a practical attribution and disclosure summary for deployment. If you need stricter legal review, check the linked upstream repositories and license files directly before publishing.

## Known Operational Notes

- The build relies on PokeAPI availability unless `--reuse-existing` is used
- Atlas generation requires Pillow
- PowerShell environments may block `npm.ps1`; if so, use `npm.cmd run test:web`
- Because the project stores generated assets in `dist/`, remember to rebuild after changing config or frontend files
