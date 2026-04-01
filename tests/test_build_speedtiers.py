import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import build_speedtiers as bst

ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / ".tmp_tests"


def make_tmp_dir() -> Path:
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    path = TMP_ROOT / f"case_{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    return path


class BuildScriptTests(unittest.TestCase):
    def test_validate_config_accepts_named_default_ruleset(self):
        config = {
            "schemaVersion": "1.0.1",
            "defaultRulesetId": "ChampionsFullDex",
            "includePokemon": {"mode": "all"},
            "rulesets": [
                {
                    "id": "ChampionsFullDex",
                    "label": "Champions Full Dex",
                    "pokemonNames": ["bulbasaur"],
                }
            ],
            "sprites": {
                "download": True,
                "fallbackSpritePath": "sprites/fallback.png",
            },
        }

        bst.validate_config(config)

    def test_validate_config_rejects_unknown_default_ruleset(self):
        config = {
            "schemaVersion": "1.0.1",
            "defaultRulesetId": "MissingRuleset",
            "includePokemon": {"mode": "all"},
            "rulesets": [
                {
                    "id": "ChampionsFullDex",
                    "label": "Champions Full Dex",
                    "pokemonNames": ["bulbasaur"],
                }
            ],
            "sprites": {
                "download": True,
                "fallbackSpritePath": "sprites/fallback.png",
            },
        }

        with self.assertRaises(ValueError):
            bst.validate_config(config)

    def test_normalize_rulesets_includes_default_ruleset_id(self):
        config = {
            "schemaVersion": "1.0.1",
            "defaultRulesetId": "ChampionsFullDex",
            "rulesets": [
                {
                    "id": "ChampionsFullDex",
                    "label": "Champions Full Dex",
                    "pokemonNames": ["Bulbasaur", "bulbasaur"],
                }
            ],
        }

        normalized = bst.normalize_rulesets(config)

        self.assertEqual(normalized["defaultRulesetId"], "ChampionsFullDex")
        self.assertEqual(normalized["rulesets"][0]["pokemonNames"], ["bulbasaur"])

    def test_validate_rulesets_against_dataset_accepts_matching_names(self):
        config = {
            "rulesets": [
                {
                    "id": "ChampionsFullDex",
                    "label": "Champions Full Dex",
                    "pokemonNames": ["Bulbasaur", "venusaur-mega"],
                }
            ]
        }
        pokemon_entries = [
            {"id": 1, "name": "bulbasaur"},
            {"id": 2, "name": "venusaur-mega"},
        ]

        bst.validate_rulesets_against_dataset(config, pokemon_entries)

    def test_validate_rulesets_against_dataset_reports_missing_names(self):
        config = {
            "rulesets": [
                {
                    "id": "ChampionsFullDex",
                    "label": "Champions Full Dex",
                    "pokemonNames": ["Bulbasaur", "Not-A-Real-Mon"],
                }
            ]
        }
        pokemon_entries = [{"id": 1, "name": "bulbasaur"}]

        with patch.object(bst, "fail") as fail_mock:
            with self.assertRaises(ValueError):
                bst.validate_rulesets_against_dataset(config, pokemon_entries)

        logged = "\n".join(call.args[0] for call in fail_mock.call_args_list)
        self.assertIn("ChampionsFullDex", logged)
        self.assertIn("not-a-real-mon", logged)

    def test_resolve_sprite_priority(self):
        data = {
            "sprites": {
                "front_default": "front.png",
                "other": {
                    "home": {"front_default": "home.png"},
                    "bdsp": {"front_default": "bdsp.png"},
                    "official-artwork": {"front_default": "oa.png"},
                },
                "versions": {
                    "generation-ix": {
                        "scarlet-violet": {"front_default": "sv.png"},
                    },
                    "generation-iii": {
                        "emerald": {"front_default": "emerald.png"},
                    }
                },
            }
        }
        url, source = bst.resolve_sprite(data)
        self.assertEqual(url, "home.png")
        self.assertEqual(source, "home")

        data["sprites"]["other"]["home"]["front_default"] = None
        url, source = bst.resolve_sprite(data)
        self.assertEqual(url, "sv.png")
        self.assertEqual(source, "scarlet-violet")

        data["sprites"]["versions"]["generation-ix"]["scarlet-violet"]["front_default"] = None
        url, source = bst.resolve_sprite(data)
        self.assertEqual(url, "emerald.png")
        self.assertEqual(source, "emerald")

        data["sprites"]["versions"]["generation-iii"]["emerald"]["front_default"] = None
        url, source = bst.resolve_sprite(data)
        self.assertEqual(url, "bdsp.png")
        self.assertEqual(source, "bdsp")

        data["sprites"]["other"]["bdsp"]["front_default"] = None
        url, source = bst.resolve_sprite(data)
        self.assertEqual(url, "front.png")
        self.assertEqual(source, "front_default")

        data["sprites"]["front_default"] = None
        url, source = bst.resolve_sprite(data)
        self.assertIsNone(url)
        self.assertEqual(source, "fallback")

    def test_validate_pokemon_dataset_schema_failure(self):
        out_dir = make_tmp_dir()
        try:
            (out_dir / "sprites").mkdir()
            rows = [
                {
                    "id": "25",
                    "name": "pikachu",
                    "baseSpeed": 90,
                    "spritePath": "sprites/25.png",
                    "spriteSource": "bdsp",
                }
            ]
            with self.assertRaises(ValueError):
                bst.validate_pokemon_dataset(rows, out_dir)
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_validate_pokemon_dataset_ordering(self):
        out_dir = make_tmp_dir()
        try:
            (out_dir / "sprites").mkdir()
            (out_dir / "sprites/2.png").write_bytes(b"x")
            (out_dir / "sprites/1.png").write_bytes(b"x")

            rows = [
                {
                    "id": 2,
                    "name": "ivysaur",
                    "baseSpeed": 60,
                    "spritePath": "sprites/2.png",
                    "spriteSource": "bdsp",
                },
                {
                    "id": 1,
                    "name": "bulbasaur",
                    "baseSpeed": 45,
                    "spritePath": "sprites/1.png",
                    "spriteSource": "bdsp",
                },
            ]

            with self.assertRaises(ValueError):
                bst.validate_pokemon_dataset(rows, out_dir)
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_build_dataset_uses_fallback_on_sprite_download_failure(self):
        config = {
            "schemaVersion": "1.0.1",
            "defaultRulesetId": "all-a",
            "includePokemon": {"mode": "all"},
            "rulesets": [
                {
                    "id": "all-a",
                    "label": "All A",
                    "pokemonIds": [1],
                }
            ],
            "sprites": {
                "download": True,
                "fallbackSpritePath": "sprites/fallback.png",
                "requestTimeoutSeconds": 2,
                "maxConcurrentDownloads": 2,
                "buildAtlas": False,
            },
        }

        fake_index = [{"name": "bulbasaur", "url": "https://pokeapi.co/api/v2/pokemon/1/"}]
        fake_pokemon = {
            "id": 1,
            "name": "bulbasaur",
            "stats": [{"base_stat": 45, "stat": {"name": "speed"}}],
            "sprites": {
                "front_default": "https://img.example/1.png",
                "other": {"bdsp": {"front_default": None}, "official-artwork": {"front_default": None}},
            },
        }

        out_dir = make_tmp_dir()
        try:
            def fake_fetch(url, _timeout, _limiter):
                if "pokemon?limit" in url:
                    return {"results": fake_index, "next": None}
                if url.endswith("/pokemon/1"):
                    return fake_pokemon
                raise AssertionError(f"unexpected url: {url}")

            with patch.object(bst, "fetch_json", side_effect=fake_fetch), patch.object(
                bst, "download_sprite", side_effect=RuntimeError("boom")
            ):
                data = bst.build_dataset(out_dir, config)

            self.assertEqual(data["manifest"]["missingSpriteCount"], 1)
            self.assertEqual(data["pokemon"]["pokemon"][0]["spriteSource"], "fallback")
            self.assertEqual(data["rulesets"]["defaultRulesetId"], "all-a")
            self.assertTrue((out_dir / "sprites/fallback.png").exists())
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
