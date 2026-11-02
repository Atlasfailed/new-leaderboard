import copy
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from .custom_games import build_custom_rankings, classify_replay, load_cache, save_cache
from .local_replay import import_replay, inspect_replay, main


def replay():
    return {
        "id": "8442e76abab6d5932806d2405379b7ae",
        "startTime": "2026-11-01T13:45:40.000Z",
        "Map": {"scriptName": "Raptor_Crater_V2"},
        "durationMs": 1965600,
        "hasBots": False,
        "Spectators": [{"name": "Twig"}],
        "AllyTeams": [
            {
                "winningTeam": False,
                "Players": [{"userId": 1, "name": "King", "handicap": 55, "skill": "[25]", "countryCode": "BE"}],
            },
            {
                "winningTeam": True,
                "Players": [
                    {"userId": i, "name": f"Peasant {i}", "handicap": 0} for i in [2, 3]
                ],
            },
        ],
    }


class LocalReplayTests(unittest.TestCase):
    def test_import_preserves_metadata_deduplicates_and_retains_source_in_output(self):
        value = replay()
        source = {"type": "local", "file": "game.sdfz", "sha256": "a" * 64, "api_available": False}
        cache = {"games": {}, "rejected": ["other"], "scanned_through": "2026-11-01"}
        self.assertEqual(import_replay(value, cache, source)["import_status"], "imported")
        before = copy.deepcopy(cache)
        self.assertEqual(import_replay(value, cache, source)["import_status"], "already_included")
        self.assertEqual(cache, before)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            save_cache(cache, path)
            saved = load_cache(path)
        self.assertEqual(saved["scanned_through"], "2026-11-01")
        self.assertEqual(saved["rejected"], ["other"])
        payload = build_custom_rankings(saved)
        self.assertEqual(len(payload["games"]), 1)
        self.assertEqual(payload["games"][0]["source"], source)
        import_replay(value, cache, source, copy.deepcopy(value))
        self.assertTrue(cache["games"][value["id"]]["source"]["api_available"])

    def test_import_requires_review_for_rejected_ids_and_refuses_conflicts(self):
        value = replay()
        source = {"type": "local", "api_available": False}
        cache = {"games": {}, "rejected": [value["id"], "other"]}
        before = copy.deepcopy(cache)
        with self.assertRaisesRegex(ValueError, "previously rejected"):
            import_replay(value, cache, source)
        self.assertEqual(cache, before)
        import_replay(value, cache, source, allow_rejected=True)
        self.assertEqual(cache["rejected"], ["other"])
        changed = copy.deepcopy(value)
        changed["durationMs"] += 1
        before = copy.deepcopy(cache)
        with self.assertRaisesRegex(ValueError, "differs"):
            import_replay(changed, cache, source)
        with self.assertRaisesRegex(ValueError, "differs"):
            import_replay(value, cache, source, changed)
        self.assertEqual(cache, before)

    def test_import_rejects_ineligible_duration(self):
        value = replay()
        value["durationMs"] = 600000
        cache = {"games": {}, "rejected": []}
        with self.assertRaisesRegex(ValueError, "eligibility"):
            import_replay(value, cache, {"type": "local"})
        self.assertEqual(cache["games"], {})

    def test_cli_batch_failure_does_not_save_partial_import(self):
        first, second = replay(), replay()
        second["id"] = "a" * 32
        second["durationMs"] = 600000
        completed = [Mock(stdout=json.dumps(first)), Mock(stdout=json.dumps(second))]
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "cache.json"
            save_cache({"games": {}, "rejected": []}, cache_path)
            original = cache_path.read_bytes()
            files = [Path(directory) / name for name in ("one.sdfz", "two.sdfz")]
            for file in files:
                file.write_bytes(b"recording")
            args = ["inspect", "--import", "--cache", str(cache_path), *map(str, files)]
            with patch("sys.argv", args), patch(
                "koth.pipeline.local_replay.subprocess.run", side_effect=completed
            ), patch("koth.pipeline.local_replay.requests.get", return_value=Mock(status_code=404)):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    main()
            self.assertEqual(cache_path.read_bytes(), original)

    def test_cli_api_failure_is_not_treated_as_missing_replay(self):
        import requests

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            save_cache({"games": {}, "rejected": []}, path)
            response = Mock(status_code=503)
            response.raise_for_status.side_effect = requests.HTTPError("503 API unavailable")
            with patch("sys.argv", ["inspect", "--import", "--cache", str(path), "game.sdfz"]), patch(
                "koth.pipeline.local_replay.subprocess.run", return_value=Mock(stdout=json.dumps(replay()))
            ), patch("koth.pipeline.local_replay.requests.get", return_value=response):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    main()
            self.assertEqual(load_cache(path)["games"], {})

    def test_exact_comparison_and_duplicate_detection_do_not_modify_cache(self):
        value = replay()
        cache = {"games": {value["id"]: classify_replay(value)}, "rejected": []}
        before = copy.deepcopy(cache)
        report = inspect_replay(value, cache, copy.deepcopy(value))
        self.assertEqual(report["cache_status"], "already_included")
        self.assertEqual(report["cache_differences"], [])
        self.assertEqual(report["api_differences"], [])
        self.assertEqual(cache, before)

    def test_reports_each_changed_compact_field(self):
        local, api = replay(), replay()
        api["AllyTeams"][0]["Players"][0]["skill"] = "[30]"
        api["durationMs"] += 1
        report = inspect_replay(local, {"games": {}}, api)
        self.assertEqual(report["api_differences"], ["duration_ms", "kings"])

    def test_unknown_and_previously_rejected_ids(self):
        value = replay()
        report = inspect_replay(value, {"games": {}, "rejected": []})
        self.assertEqual(report["cache_status"], "not_in_local_cache")
        self.assertNotIn("api_differences", report)
        report = inspect_replay(value, {"games": {}, "rejected": [value["id"]]})
        self.assertEqual(report["cache_status"], "previously_rejected")

    def test_eligibility_and_api_identity_errors_are_explicit(self):
        value = replay()
        value["hasBots"] = True
        with self.assertRaisesRegex(ValueError, "eligibility"):
            inspect_replay(value, {"games": {}})
        api = replay()
        api["id"] = "another-game"
        with self.assertRaisesRegex(ValueError, "different game ID"):
            inspect_replay(replay(), {"games": {}}, api)


if __name__ == "__main__":
    unittest.main()
