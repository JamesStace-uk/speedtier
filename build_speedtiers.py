#!/usr/bin/env python3
import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    from PIL import Image
    from PIL import UnidentifiedImageError
except ImportError:  # pragma: no cover - depends on local environment
    Image = None
    UnidentifiedImageError = Exception

API_BASE = "https://pokeapi.co/api/v2"
DEFAULT_TIMEOUT_SECONDS = 15
DEFAULT_MAX_CONCURRENT_DOWNLOADS = 8
DEFAULT_MAX_REQUESTS_PER_SECOND = 5.0
POKEMON_PAGE_SIZE = 200
DATASET_SCHEMA_VERSION = "1.0.0"
DEFAULT_ATLAS_TILE_SIZE = 60
DEFAULT_ATLAS_FILENAME = "sprites/sprite_atlas.png"
NATIONAL_DEX_RULESET_ID = "NationalDex"
HTTP_HEADERS = {
    "User-Agent": "SpeedTierToolBuilder/1.0 (+https://pokeapi.co)",
    "Accept": "application/json,image/*,*/*",
}

# 1x1 transparent PNG
DEFAULT_FALLBACK_PNG = bytes(
    [
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        8,
        6,
        0,
        0,
        0,
        31,
        21,
        196,
        137,
        0,
        0,
        0,
        13,
        73,
        68,
        65,
        84,
        120,
        156,
        99,
        0,
        1,
        0,
        0,
        5,
        0,
        1,
        13,
        10,
        45,
        180,
        0,
        0,
        0,
        0,
        73,
        69,
        78,
        68,
        174,
        66,
        96,
        130,
    ]
)


@dataclass(frozen=True)
class PokemonRecord:
    id: int
    name: str
    base_speed: int
    sprite_url: Optional[str]
    sprite_source_hint: str


class RateLimiter:
    def __init__(self, max_requests_per_second: float) -> None:
        self.interval_seconds = 1.0 / max(0.1, max_requests_per_second)
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            wait_for = self._next_allowed - now
            if wait_for > 0:
                time.sleep(wait_for)
                now = time.monotonic()
            self._next_allowed = now + self.interval_seconds


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)


def info(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def load_json(path: Path) -> Dict[str, Any]:
    # Accept UTF-8 with or without BOM for Windows-edited config files.
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")


def build_manifest_from_existing(
    pokemon_entries: List[Dict[str, Any]],
    fallback_rel: str,
    generated_at: str,
    default_ruleset_id: str,
) -> Dict[str, Any]:
    counts = {
        "home": 0,
        "scarlet-violet": 0,
        "emerald": 0,
        "bdsp": 0,
        "official-artwork": 0,
        "front_default": 0,
        "fallback": 0,
    }
    for p in pokemon_entries:
        source = p.get("spriteSource")
        if source in counts:
            counts[source] += 1
    return {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "defaultRulesetId": default_ruleset_id,
        "pokemonCount": len(pokemon_entries),
        "missingSpriteCount": counts["fallback"],
        "spriteSourceCounts": counts,
        "fallbackSpritePath": fallback_rel,
    }


def ensure_clean_output(out_dir: Path, clean: bool) -> None:
    if clean and out_dir.exists():
        remove_tree_with_retries(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)


def _rmtree_onerror(func: Any, path: str, _exc_info: Any) -> None:
    # Windows/OneDrive can leave files read-only; clear that bit and retry once.
    os.chmod(path, 0o700)
    func(path)


def remove_tree_with_retries(path: Path, retries: int = 5, base_delay: float = 0.25) -> None:
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            shutil.rmtree(path, onerror=_rmtree_onerror)
            return
        except FileNotFoundError:
            return
        except PermissionError as exc:
            last_error = exc
            # Allow OneDrive/AV/file indexers time to release handles.
            time.sleep(base_delay * (2**attempt))
    if last_error is not None:
        raise PermissionError(
            f"Could not remove '{path}' after {retries} attempts. "
            "Close file explorer/windows using that folder and pause OneDrive sync, then retry."
        ) from last_error


def validate_config(config: Dict[str, Any]) -> None:
    if not isinstance(config.get("schemaVersion"), str):
        raise ValueError("config.schemaVersion must be a string")

    rulesets = config.get("rulesets")
    if not isinstance(rulesets, list):
        raise ValueError("config.rulesets must be an array")

    seen_ruleset_ids = set()
    for idx, ruleset in enumerate(rulesets):
        if not isinstance(ruleset, dict):
            raise ValueError(f"rulesets[{idx}] must be an object")
        rid = ruleset.get("id")
        label = ruleset.get("label")
        if not isinstance(rid, str) or not rid:
            raise ValueError(f"rulesets[{idx}].id must be a non-empty string")
        if rid == NATIONAL_DEX_RULESET_ID:
            raise ValueError(
                f"rulesets[{idx}].id cannot be {NATIONAL_DEX_RULESET_ID}; it is reserved for the built-in National Dex ruleset"
            )
        if rid in seen_ruleset_ids:
            raise ValueError(f"duplicate ruleset id: {rid}")
        seen_ruleset_ids.add(rid)
        if not isinstance(label, str) or not label:
            raise ValueError(f"rulesets[{idx}].label must be a non-empty string")

        has_ids = "pokemonIds" in ruleset
        has_names = "pokemonNames" in ruleset
        if has_ids == has_names:
            raise ValueError(
                f"rulesets[{idx}] must include exactly one of pokemonIds or pokemonNames"
            )
        if has_ids and not (
            isinstance(ruleset["pokemonIds"], list)
            and all(isinstance(v, int) for v in ruleset["pokemonIds"])
        ):
            raise ValueError(f"rulesets[{idx}].pokemonIds must be int[]")
        if has_names and not (
            isinstance(ruleset["pokemonNames"], list)
            and all(isinstance(v, str) for v in ruleset["pokemonNames"])
        ):
            raise ValueError(f"rulesets[{idx}].pokemonNames must be string[]")

    default_ruleset_id = config.get("defaultRulesetId", NATIONAL_DEX_RULESET_ID)
    if not isinstance(default_ruleset_id, str) or not default_ruleset_id:
        raise ValueError("config.defaultRulesetId must be a non-empty string when provided")
    if default_ruleset_id != NATIONAL_DEX_RULESET_ID and default_ruleset_id not in seen_ruleset_ids:
        raise ValueError(
            "config.defaultRulesetId must be NationalDex or match one of config.rulesets[].id"
        )

    sprites = config.get("sprites")
    if not isinstance(sprites, dict):
        raise ValueError("config.sprites must be an object")
    if sprites.get("download") is not True:
        raise ValueError("config.sprites.download must be true")
    if not isinstance(sprites.get("fallbackSpritePath"), str):
        raise ValueError("config.sprites.fallbackSpritePath must be a string")
    if "maxRequestsPerSecond" in sprites:
        value = sprites["maxRequestsPerSecond"]
        if not isinstance(value, (int, float)) or value <= 0:
            raise ValueError("config.sprites.maxRequestsPerSecond must be > 0")
    if "buildAtlas" in sprites and not isinstance(sprites["buildAtlas"], bool):
        raise ValueError("config.sprites.buildAtlas must be a boolean")
    if "atlasTileSize" in sprites:
        value = sprites["atlasTileSize"]
        if not isinstance(value, int) or value <= 0:
            raise ValueError("config.sprites.atlasTileSize must be a positive integer")
    if "atlasFilename" in sprites and not isinstance(sprites["atlasFilename"], str):
        raise ValueError("config.sprites.atlasFilename must be a string")

    include = config.get("includePokemon", {"mode": "all"})
    if not isinstance(include, dict):
        raise ValueError("config.includePokemon must be an object")
    mode = include.get("mode", "all")
    if mode not in {"all", "byList"}:
        raise ValueError("config.includePokemon.mode must be all or byList")
    if mode == "byList":
        ids = include.get("pokemonIds")
        if not isinstance(ids, list) or not all(isinstance(v, int) for v in ids):
            raise ValueError("config.includePokemon.pokemonIds must be int[] in byList mode")


def normalize_rulesets(config: Dict[str, Any]) -> Dict[str, Any]:
    normalized = []
    for ruleset in config["rulesets"]:
        entry = {
            "id": ruleset["id"],
            "label": ruleset["label"],
        }
        if "description" in ruleset and isinstance(ruleset["description"], str):
            entry["description"] = ruleset["description"]
        if "pokemonIds" in ruleset:
            entry["pokemonIds"] = sorted(set(ruleset["pokemonIds"]))
        else:
            entry["pokemonNames"] = sorted({name.strip().lower() for name in ruleset["pokemonNames"]})
        normalized.append(entry)

    return {
        "schemaVersion": config["schemaVersion"],
        "defaultRulesetId": config.get("defaultRulesetId", NATIONAL_DEX_RULESET_ID),
        "rulesets": normalized,
    }


def validate_rulesets_against_dataset(
    config: Dict[str, Any],
    pokemon_entries: List[Dict[str, Any]],
) -> None:
    dataset_ids = set()
    dataset_names = set()
    for entry in pokemon_entries:
        pid = entry.get("id")
        name = entry.get("name")
        if isinstance(pid, int):
            dataset_ids.add(pid)
        if isinstance(name, str):
            dataset_names.add(name.strip().lower())

    missing_lines: List[str] = []
    for ruleset in config["rulesets"]:
        missing_ids = []
        missing_names = []
        if "pokemonIds" in ruleset:
            missing_ids = [pid for pid in sorted(set(ruleset["pokemonIds"])) if pid not in dataset_ids]
        if "pokemonNames" in ruleset:
            normalized_names = sorted({name.strip().lower() for name in ruleset["pokemonNames"]})
            missing_names = [name for name in normalized_names if name not in dataset_names]

        if missing_ids or missing_names:
            missing_lines.append(f"Ruleset '{ruleset['id']}' has entries missing from the built dataset:")
            if missing_ids:
                missing_lines.append(f"  Missing ids: {', '.join(str(pid) for pid in missing_ids)}")
            if missing_names:
                missing_lines.append(f"  Missing names: {', '.join(missing_names)}")

    if missing_lines:
        for line in missing_lines:
            fail(line)
        raise ValueError(
            "Ruleset validation failed: one or more rulesets reference Pokemon not present in the built dataset."
        )


def fetch_bytes(url: str, timeout_seconds: float, limiter: RateLimiter) -> bytes:
    limiter.wait()
    req = Request(url, headers=HTTP_HEADERS)
    max_attempts = 5
    last_error: Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            with urlopen(req, timeout=timeout_seconds) as resp:
                return resp.read()
        except HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < max_attempts - 1:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    delay = float(retry_after) if retry_after else (0.5 * (2 ** attempt))
                except ValueError:
                    delay = 0.5 * (2 ** attempt)
                time.sleep(min(delay, 20.0))
                continue
            last_error = exc
            break
        except URLError as exc:
            if attempt < max_attempts - 1:
                time.sleep(0.5 * (2 ** attempt))
                continue
            last_error = exc
            break
    if last_error is None:
        raise RuntimeError("Unexpected network failure without error details")
    raise last_error


def fetch_json(url: str, timeout_seconds: float, limiter: RateLimiter) -> Dict[str, Any]:
    return json.loads(fetch_bytes(url, timeout_seconds, limiter).decode("utf-8"))


def fetch_pokemon_index(timeout_seconds: float, limiter: RateLimiter) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    offset = 0
    while True:
        url = f"{API_BASE}/pokemon?limit={POKEMON_PAGE_SIZE}&offset={offset}"
        payload = fetch_json(url, timeout_seconds, limiter)
        results = payload.get("results", [])
        if not isinstance(results, list):
            raise ValueError("PokeAPI returned unexpected pokemon index shape")
        entries.extend(results)
        if not payload.get("next"):
            break
        offset += POKEMON_PAGE_SIZE
    return entries


def extract_base_speed(stats: Iterable[Dict[str, Any]]) -> int:
    for stat in stats:
        try:
            if stat["stat"]["name"] == "speed":
                value = int(stat["base_stat"])
                if value < 1:
                    raise ValueError("base speed must be >= 1")
                return value
        except Exception as exc:  # pragma: no cover - defensive for malformed payloads
            raise ValueError(f"invalid stats payload: {exc}") from exc
    raise ValueError("speed stat not found")


def resolve_sprite(data: Dict[str, Any]) -> Tuple[Optional[str], str]:
    sprites = data.get("sprites") or {}
    other = sprites.get("other") or {}
    versions = sprites.get("versions") or {}

    home = (other.get("home") or {}).get("front_default")
    if home:
        return home, "home"

    scarlet_violet = (
        ((versions.get("generation-ix") or {}).get("scarlet-violet") or {}).get("front_default")
    )
    if scarlet_violet:
        return scarlet_violet, "scarlet-violet"

    emerald = (
        ((versions.get("generation-iii") or {}).get("emerald") or {}).get("front_default")
    )
    if emerald:
        return emerald, "emerald"

    bdsp = ((other.get("bdsp") or {}).get("front_default"))
    if bdsp:
        return bdsp, "bdsp"

    front_default = sprites.get("front_default")
    if front_default:
        return front_default, "front_default"

    return None, "fallback"


def sanitize_sprite_extension(url: str) -> str:
    path = urlparse(url).path.lower()
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        if path.endswith(ext):
            return ext
    return ".png"


def ensure_fallback_sprite(out_dir: Path, fallback_rel: str) -> Path:
    fallback_path = out_dir / fallback_rel
    fallback_path.parent.mkdir(parents=True, exist_ok=True)
    if not fallback_path.exists():
        fallback_path.write_bytes(DEFAULT_FALLBACK_PNG)
    return fallback_path


def download_sprite(
    url: str,
    dest: Path,
    timeout_seconds: float,
    limiter: RateLimiter,
) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"unsupported sprite URL scheme: {url}")

    body = fetch_bytes(url, timeout_seconds, limiter)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)


def validate_pokemon_dataset(pokemon_entries: List[Dict[str, Any]], out_dir: Path) -> None:
    previous_id = -1
    seen_ids = set()
    for idx, item in enumerate(pokemon_entries):
        if not isinstance(item, dict):
            raise ValueError(f"pokemon[{idx}] must be object")

        pid = item.get("id")
        name = item.get("name")
        base_speed = item.get("baseSpeed")
        sprite_path = item.get("spritePath")
        sprite_source = item.get("spriteSource")

        if not isinstance(pid, int):
            raise ValueError(f"pokemon[{idx}].id must be int")
        if pid in seen_ids:
            raise ValueError(f"duplicate pokemon id: {pid}")
        if pid < previous_id:
            raise ValueError("pokemon entries are not sorted by id ascending")
        previous_id = pid
        seen_ids.add(pid)

        if not isinstance(name, str) or not name:
            raise ValueError(f"pokemon[{idx}].name must be non-empty string")
        if not isinstance(base_speed, int) or base_speed < 1:
            raise ValueError(f"pokemon[{idx}].baseSpeed must be int >= 1")
        if not isinstance(sprite_path, str) or not sprite_path:
            raise ValueError(f"pokemon[{idx}].spritePath must be non-empty string")
        if sprite_source not in {
            "home",
            "scarlet-violet",
            "emerald",
            "bdsp",
            "official-artwork",
            "front_default",
            "fallback",
        }:
            raise ValueError(f"pokemon[{idx}].spriteSource invalid: {sprite_source}")

        resolved = out_dir / sprite_path
        if not resolved.exists():
            raise ValueError(f"sprite path does not exist: {sprite_path}")


def parse_id_from_pokemon_url(url: str) -> int:
    parts = [p for p in urlparse(url).path.split("/") if p]
    if not parts:
        raise ValueError(f"invalid pokemon url: {url}")
    return int(parts[-1])


def _fit_image_to_square(img: Any, tile_size: int) -> Any:
    rgba = img.convert("RGBA")
    rgba.thumbnail((tile_size, tile_size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
    x = (tile_size - rgba.width) // 2
    y = (tile_size - rgba.height) // 2
    canvas.paste(rgba, (x, y), rgba)
    return canvas


def build_sprite_atlas(
    out_dir: Path,
    dataset_rows: List[Dict[str, Any]],
    fallback_rel: str,
    atlas_rel: str,
    tile_size: int,
) -> Dict[str, Any]:
    if Image is None:
        raise RuntimeError(
            "Pillow is required for atlas generation. Install with: pip install pillow"
        )
    if not dataset_rows:
        raise ValueError("Cannot build sprite atlas with empty dataset")

    count = len(dataset_rows)
    columns = int(math.ceil(math.sqrt(count)))
    rows = int(math.ceil(count / columns))
    atlas = Image.new("RGBA", (columns * tile_size, rows * tile_size), (0, 0, 0, 0))

    tile_cache: Dict[str, Any] = {}
    repaired_with_fallback = 0
    fallback_abs = out_dir / fallback_rel
    with Image.open(fallback_abs) as fallback_img:
        fallback_tile = _fit_image_to_square(fallback_img, tile_size)
    for idx, row in enumerate(dataset_rows):
        src_rel = str(row["spritePath"])
        src_abs = out_dir / src_rel
        if src_rel not in tile_cache:
            try:
                with Image.open(src_abs) as sprite:
                    tile_cache[src_rel] = _fit_image_to_square(sprite, tile_size)
            except (FileNotFoundError, OSError, UnidentifiedImageError):
                # If a downloaded sprite is corrupted/non-image, repair by using fallback tile.
                tile_cache[src_rel] = fallback_tile
                row["spriteSource"] = "fallback"
                repaired_with_fallback += 1
        tile = tile_cache[src_rel]
        x = (idx % columns) * tile_size
        y = (idx // columns) * tile_size
        atlas.paste(tile, (x, y), tile)
        row["spriteAtlas"] = {"x": x, "y": y, "size": tile_size}
        row["spritePath"] = atlas_rel

    atlas_abs = out_dir / atlas_rel
    atlas_abs.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(atlas_abs, format="PNG", optimize=True)

    keep = {fallback_rel, atlas_rel}
    sprites_dir = out_dir / "sprites"
    if sprites_dir.exists():
        for file in sprites_dir.iterdir():
            if not file.is_file():
                continue
            rel = str(file.relative_to(out_dir)).replace("\\", "/")
            if rel not in keep:
                file.unlink(missing_ok=True)

    return {
        "path": atlas_rel,
        "tileSize": tile_size,
        "columns": columns,
        "rows": rows,
        "count": count,
        "repairedWithFallback": repaired_with_fallback,
    }


def build_dataset(out_dir: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    timeout_seconds = float(config.get("sprites", {}).get("requestTimeoutSeconds", DEFAULT_TIMEOUT_SECONDS))
    max_workers = int(config.get("sprites", {}).get("maxConcurrentDownloads", DEFAULT_MAX_CONCURRENT_DOWNLOADS))
    max_rps = float(config.get("sprites", {}).get("maxRequestsPerSecond", DEFAULT_MAX_REQUESTS_PER_SECOND))
    build_atlas = bool(config.get("sprites", {}).get("buildAtlas", True))
    atlas_tile_size = int(config.get("sprites", {}).get("atlasTileSize", DEFAULT_ATLAS_TILE_SIZE))
    atlas_filename = str(config.get("sprites", {}).get("atlasFilename", DEFAULT_ATLAS_FILENAME))
    limiter = RateLimiter(max_rps)
    include = config.get("includePokemon", {"mode": "all"})
    include_mode = include.get("mode", "all")
    include_ids = set(include.get("pokemonIds", [])) if include_mode == "byList" else None

    fallback_rel = config["sprites"]["fallbackSpritePath"]
    fallback_path = ensure_fallback_sprite(out_dir, fallback_rel)
    info(f"Fallback sprite ready at '{fallback_rel}'")

    pokemon_records: List[PokemonRecord] = []
    info("Fetching Pokemon index from PokeAPI...")
    index_entries = fetch_pokemon_index(timeout_seconds, limiter)
    info(f"Fetched pokemon index entries: {len(index_entries)}")

    indexed_refs: List[Tuple[int, str]] = []
    for e in index_entries:
        url = e.get("url")
        name = e.get("name")
        if not isinstance(url, str) or not isinstance(name, str):
            continue
        pid = parse_id_from_pokemon_url(url)
        if include_ids is not None and pid not in include_ids:
            continue
        indexed_refs.append((pid, name))

    indexed_refs.sort(key=lambda x: x[0])
    info(f"Pokemon selected for build: {len(indexed_refs)}")

    info("Fetching per-pokemon metadata (id, name, speed, sprite URL)...")
    for pid, _name in indexed_refs:
        data = fetch_json(f"{API_BASE}/pokemon/{pid}", timeout_seconds, limiter)
        base_speed = extract_base_speed(data.get("stats", []))
        sprite_url, sprite_source = resolve_sprite(data)
        pokemon_records.append(
            PokemonRecord(
                id=int(data["id"]),
                name=str(data["name"]),
                base_speed=base_speed,
                sprite_url=sprite_url,
                sprite_source_hint=sprite_source,
            )
        )
        if len(pokemon_records) % 100 == 0 or len(pokemon_records) == len(indexed_refs):
            info(f"Metadata fetched: {len(pokemon_records)}/{len(indexed_refs)}")
    # Phase 1 complete: all pokemon metadata fetched and normalized.
    # Phase 2 (final network step): fetch sprites.
    pokemon_records.sort(key=lambda r: r.id)
    info("Metadata phase complete. Starting sprite download phase...")

    sprites_dir = out_dir / "sprites"
    sprites_dir.mkdir(parents=True, exist_ok=True)

    sprite_source_counts = {
        "home": 0,
        "scarlet-violet": 0,
        "emerald": 0,
        "bdsp": 0,
        "official-artwork": 0,
        "front_default": 0,
        "fallback": 0,
    }
    missing_sprite_count = 0

    dataset_rows: List[Dict[str, Any]] = []

    futures: Dict[concurrent.futures.Future[None], Tuple[PokemonRecord, Path, str]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, max_workers)) as executor:
        queued_downloads = 0
        for record in pokemon_records:
            if record.sprite_url:
                ext = sanitize_sprite_extension(record.sprite_url)
                rel_path = f"sprites/{record.id}{ext}"
                abs_path = out_dir / rel_path
                fut = executor.submit(download_sprite, record.sprite_url, abs_path, timeout_seconds, limiter)
                futures[fut] = (record, abs_path, rel_path)
                queued_downloads += 1
            else:
                missing_sprite_count += 1
                sprite_source_counts["fallback"] += 1
                dataset_rows.append(
                    {
                        "id": record.id,
                        "name": record.name,
                        "baseSpeed": record.base_speed,
                        "spritePath": fallback_rel,
                        "spriteSource": "fallback",
                    }
                )
        info(
            "Sprite tasks queued: "
            f"{queued_downloads} downloads, {missing_sprite_count} immediate fallback entries"
        )

        completed_downloads = 0
        for fut in concurrent.futures.as_completed(futures):
            record, _abs_path, rel_path = futures[fut]
            try:
                fut.result()
                source = record.sprite_source_hint
                sprite_source_counts[source] += 1
                dataset_rows.append(
                    {
                        "id": record.id,
                        "name": record.name,
                        "baseSpeed": record.base_speed,
                        "spritePath": rel_path,
                        "spriteSource": source,
                    }
                )
            except Exception:
                missing_sprite_count += 1
                sprite_source_counts["fallback"] += 1
                dataset_rows.append(
                    {
                        "id": record.id,
                        "name": record.name,
                        "baseSpeed": record.base_speed,
                        "spritePath": fallback_rel,
                        "spriteSource": "fallback",
                    }
                )
            completed_downloads += 1
            if completed_downloads % 100 == 0 or completed_downloads == queued_downloads:
                info(
                    f"Sprite downloads processed: {completed_downloads}/{queued_downloads} "
                    f"(fallback so far: {missing_sprite_count})"
                )

    dataset_rows.sort(key=lambda r: r["id"])

    atlas_meta = None
    if build_atlas:
        info("Building sprite atlas...")
        atlas_meta = build_sprite_atlas(
            out_dir=out_dir,
            dataset_rows=dataset_rows,
            fallback_rel=fallback_rel,
            atlas_rel=atlas_filename,
            tile_size=atlas_tile_size,
        )
        info(
            f"Sprite atlas generated: {atlas_meta['path']} "
            f"({atlas_meta['columns']}x{atlas_meta['rows']} tiles @ {atlas_meta['tileSize']}px)"
        )
        if atlas_meta.get("repairedWithFallback", 0) > 0:
            info(
                "Atlas repair: "
                f"{atlas_meta['repairedWithFallback']} unreadable sprite files replaced with fallback."
            )

    # Guarantee the fallback exists, even if every sprite downloaded successfully.
    if not fallback_path.exists():
        fallback_path.write_bytes(DEFAULT_FALLBACK_PNG)

    validate_pokemon_dataset(dataset_rows, out_dir)
    info("Dataset validation completed.")
    validate_rulesets_against_dataset(config, dataset_rows)
    info("Ruleset validation completed.")

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    pokemon_json = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "pokemon": dataset_rows,
    }
    if atlas_meta is not None:
        pokemon_json["spriteAtlas"] = atlas_meta
    rulesets_json = normalize_rulesets(config)
    manifest_json = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "defaultRulesetId": config.get("defaultRulesetId", NATIONAL_DEX_RULESET_ID),
        "pokemonCount": len(dataset_rows),
        "missingSpriteCount": 0,
        "spriteSourceCounts": {},
        "fallbackSpritePath": fallback_rel,
    }
    final_source_counts = {
        "home": 0,
        "scarlet-violet": 0,
        "emerald": 0,
        "bdsp": 0,
        "official-artwork": 0,
        "front_default": 0,
        "fallback": 0,
    }
    for row in dataset_rows:
        source = row.get("spriteSource")
        if source in final_source_counts:
            final_source_counts[source] += 1
    manifest_json["spriteSourceCounts"] = final_source_counts
    manifest_json["missingSpriteCount"] = final_source_counts["fallback"]
    if atlas_meta is not None and atlas_meta.get("repairedWithFallback", 0) > 0:
        manifest_json["atlasRepairedWithFallback"] = atlas_meta["repairedWithFallback"]

    return {
        "pokemon": pokemon_json,
        "rulesets": rulesets_json,
        "manifest": manifest_json,
    }


def reuse_existing_dataset(out_dir: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    pokemon_path = out_dir / "pokemon.json"
    if not pokemon_path.exists():
        raise FileNotFoundError(
            f"--reuse-existing requires existing dataset file: {pokemon_path}"
        )
    payload = load_json(pokemon_path)
    pokemon_entries = payload.get("pokemon")
    if not isinstance(pokemon_entries, list):
        raise ValueError("Existing pokemon.json is invalid: missing pokemon[]")

    validate_pokemon_dataset(pokemon_entries, out_dir)
    validate_rulesets_against_dataset(config, pokemon_entries)
    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    fallback_rel = config["sprites"]["fallbackSpritePath"]
    rulesets_json = normalize_rulesets(config)
    manifest_json = build_manifest_from_existing(
        pokemon_entries,
        fallback_rel,
        generated_at,
        config.get("defaultRulesetId", NATIONAL_DEX_RULESET_ID),
    )

    return {
        "pokemon": payload,
        "rulesets": rulesets_json,
        "manifest": manifest_json,
    }


def copy_static_site_assets(out_dir: Path) -> None:
    source_dir = Path(__file__).resolve().parent / "web"
    for filename in ("index.html", "app.js", "speed.js", "styles.css"):
        src = source_dir / filename
        if not src.exists():
            raise FileNotFoundError(f"missing web asset: {src}")
        shutil.copy2(src, out_dir / filename)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static Speed Tier Tool dataset and assets")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--config", required=True, help="Path to build config JSON")
    parser.add_argument("--clean", action="store_true", help="Clean output directory first")
    parser.add_argument(
        "--reuse-existing",
        action="store_true",
        help="Reuse existing pokemon.json and local sprites in --out (skip PokeAPI and sprite downloads)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    out_dir = Path(args.out).resolve()
    config_path = Path(args.config).resolve()

    if not config_path.exists():
        fail(f"Config not found: {config_path}")
        return 1

    try:
        info(f"Loading config: {config_path}")
        config = load_json(config_path)
        validate_config(config)
        info("Config validation completed.")
        if args.clean and args.reuse_existing:
            raise ValueError("Cannot combine --clean with --reuse-existing.")
        ensure_clean_output(out_dir, clean=args.clean)
        info(f"Output directory ready: {out_dir}")

        if args.reuse_existing:
            info("Reusing existing local dataset and sprites (network skipped).")
            data = reuse_existing_dataset(out_dir, config)
        else:
            data = build_dataset(out_dir, config)
        info("Writing output JSON files...")
        write_json(out_dir / "pokemon.json", data["pokemon"])
        write_json(out_dir / "rulesets.json", data["rulesets"])
        write_json(out_dir / "manifest.json", data["manifest"])
        info("Copying static web assets...")
        copy_static_site_assets(out_dir)
        info("Build completed successfully.")

        return 0
    except (HTTPError, URLError, TimeoutError) as exc:
        fail(f"Network failure while fetching PokeAPI data: {exc}")
        return 1
    except Exception as exc:
        fail(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
