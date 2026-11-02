"""Inspect local replays, or explicitly import validated records into the cache."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
from pathlib import Path

import requests

from .custom_games import API_URL, CACHE_PATH, _get, classify_replay, load_cache, save_cache


def inspect_replay(replay: dict, cache: dict, api_replay: dict | None = None) -> dict:
    record = classify_replay(replay)
    if record is None:
        raise ValueError("Replay does not meet the existing KOTH eligibility rules.")
    replay_id = replay["id"]
    report = {
        "id": replay_id,
        "game": record,
        "cache_status": (
            "already_included" if replay_id in cache["games"]
            else "previously_rejected" if replay_id in cache.get("rejected", [])
            else "not_in_local_cache"
        ),
    }
    if replay_id in cache["games"]:
        report["cache_differences"] = [
            key for key in record if record[key] != cache["games"][replay_id].get(key)
        ]
    if api_replay is not None:
        if api_replay["id"] != replay_id:
            raise ValueError("API returned a different game ID.")
        api_record = classify_replay(api_replay)
        if api_record is None:
            raise ValueError("API version does not meet the existing KOTH eligibility rules.")
        report["api_differences"] = [key for key in record if record[key] != api_record[key]]
    return report


def import_replay(
    replay: dict, cache: dict, source: dict, api_replay: dict | None = None,
    allow_rejected: bool = False,
) -> dict:
    report = inspect_replay(replay, cache, api_replay)
    if report.get("cache_differences") or report.get("api_differences"):
        raise ValueError(f"Replay {replay['id']} differs from the cache or API; refusing to overwrite.")
    if report["cache_status"] == "previously_rejected" and not allow_rejected:
        raise ValueError(f"Replay {replay['id']} was previously rejected; review it and use --allow-rejected.")
    replay_id = report["id"]
    if report["cache_status"] != "already_included":
        cache["games"][replay_id] = {**report["game"], "source": source}
        cache["rejected"] = [gid for gid in cache.get("rejected", []) if gid != replay_id]
        report["import_status"] = "imported"
    else:
        existing = cache["games"][replay_id]
        if existing.get("source", {}).get("type") == "local" and api_replay is not None:
            existing["source"]["api_available"] = True
        report["import_status"] = "already_included"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("replay", type=Path, nargs="+")
    parser.add_argument("--cache", type=Path, default=CACHE_PATH)
    parser.add_argument("--compare-api", action="store_true", help="Compare against the live API by game ID")
    parser.add_argument("--import", dest="import_games", action="store_true", help="Import validated games into the cache")
    parser.add_argument("--allow-rejected", action="store_true", help="Explicitly allow importing a previously rejected ID")
    args = parser.parse_args()
    if args.allow_rejected and not args.import_games:
        parser.error("--allow-rejected requires --import")
    bridge = Path(__file__).with_name("parse_local_replay.cjs")
    reports = []
    try:
        cache = load_cache(args.cache)
        original = copy.deepcopy(cache)
        for file in args.replay:
            result = subprocess.run(
                ["node", str(bridge), str(file.resolve())],
                capture_output=True, text=True, check=True,
            )
            replay = json.loads(result.stdout)
            api_replay = None
            if args.import_games:
                response = requests.get(f"{API_URL}/{replay['id']}", timeout=60)
                if response.status_code != 404:
                    response.raise_for_status()
                    api_replay = response.json()
            elif args.compare_api:
                api_replay = _get(f"{API_URL}/{replay['id']}")
            if args.import_games:
                source = {
                    "type": "local", "file": file.name,
                    "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                    "api_available": api_replay is not None,
                }
                report = import_replay(replay, cache, source, api_replay, args.allow_rejected)
            else:
                report = inspect_replay(replay, cache, api_replay)
            reports.append(report)
        if args.import_games and cache != original:
            save_cache(cache, args.cache)
    except FileNotFoundError:
        parser.error("Node.js, replay files and the cache directory must be available.")
    except subprocess.CalledProcessError as error:
        parser.error(error.stderr.strip() or f"Replay parser exited with status {error.returncode}")
    except (ValueError, OSError, requests.RequestException) as error:
        parser.error(str(error))
    print(json.dumps(reports[0] if len(reports) == 1 else reports, indent=2))
    if any(report.get("api_differences") or report.get("cache_differences") for report in reports):
        parser.exit(1, "Local replay differs from the API or cache; review the reported fields.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
