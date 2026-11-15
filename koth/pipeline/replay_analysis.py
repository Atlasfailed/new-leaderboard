"""Extract participation and compact team statistics from replay recordings."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

import requests

from .custom_games import API_URL, _get, load_cache, save_cache

LOGGER = logging.getLogger(__name__)
STORAGE = "https://storage.uk.cloud.ovh.net/v1/AUTH_10286efc0d334efd917d476d7183232e/BAR/demos/"
EXTRACT_DIR = Path(__file__).resolve().parents[1] / "analysis/replay-dataset/data/extracts"
LOCAL_DIR = Path(__file__).resolve().parents[1] / "local replays"
BRIDGE = Path(__file__).with_suffix(".cjs")


def analyze_file(path: Path, replay_id: str, game: dict, extract_dir: Path | None = None) -> list[int]:
    try:
        result = subprocess.run(
            ["node", str(BRIDGE), str(path)], capture_output=True, text=True, check=True, timeout=300,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError(f"Cannot analyze {replay_id}: {error.stderr.strip()}") from error
    analysis = json.loads(result.stdout)
    if analysis["id"] != replay_id:
        raise ValueError(f"Recording ID does not match {replay_id}")
    expected = {p[0] for role in ("kings", "peasants") for p in game[role]}
    if set(analysis["players"]) != expected:
        raise ValueError(f"Recording roster does not match cached game {replay_id}")
    excluded = analysis["excluded"]
    if not set(excluded) <= expected:
        raise ValueError(f"Unknown excluded players in {replay_id}")
    if extract_dir is not None:
        extract_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(analysis["extract"], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(payload) >= 500000:
            raise ValueError(f"Replay extract exceeds the 500,000-byte limit: {replay_id}")
        destination = extract_dir / f"{replay_id}.json"
        if destination.exists() and destination.read_bytes() != payload:
            raise ValueError(f"Existing extract differs; refusing to overwrite {destination}")
        destination.write_bytes(payload)
    return excluded


def analyze_online(replay: dict, game: dict, extract_dir: Path | None = None) -> list[int]:
    replay_id = replay["id"]
    filename = replay["fileName"]
    if not isinstance(filename, str) or not filename:
        raise ValueError(f"Replay {replay_id} has no recording filename")
    with tempfile.TemporaryDirectory(prefix="koth-replay-") as directory:
        path = Path(directory) / "recording.sdfz"
        with requests.get(STORAGE + quote(filename, safe=""), stream=True, timeout=90) as response:
            response.raise_for_status()
            size = 0
            with path.open("wb") as file:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    size += len(chunk)
                    if size > 200 * 1024 * 1024:
                        raise ValueError(f"Recording exceeds 200 MiB: {replay_id}")
                    file.write(chunk)
        return analyze_file(path, replay_id, game, extract_dir)


def analyze_cached(replay_id: str, game: dict, extract_dir: Path) -> list[int]:
    source = game.get("source", {})
    if source.get("type") == "local" and not source.get("api_available"):
        filename = source["file"]
        if Path(filename).name != filename:
            raise ValueError(f"Invalid local recording filename for {replay_id}")
        path = LOCAL_DIR / filename
        if hashlib.sha256(path.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError(f"Local recording hash mismatch for {replay_id}")
        return analyze_file(path, replay_id, game, extract_dir)
    replay = _get(f"{API_URL}/{replay_id}")
    if replay.get("id") != replay_id:
        raise ValueError(f"API returned the wrong replay for {replay_id}")
    return analyze_online(replay, game, extract_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=2, choices=range(1, 5))
    parser.add_argument("--extract-dir", type=Path, default=EXTRACT_DIR)
    parser.add_argument("--extract-missing", action="store_true",
                        help="Also generate missing local extracts for already analyzed games")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    cache = load_cache()
    pending = [(replay_id, game) for replay_id, game in cache["games"].items()
               if "excluded_user_ids" not in game
               or (args.extract_missing and not (args.extract_dir / f"{replay_id}.json").exists())]
    LOGGER.info("Analyzing %d recordings", len(pending))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(analyze_cached, replay_id, game, args.extract_dir): replay_id
                   for replay_id, game in pending}
        try:
            for future in as_completed(futures):
                replay_id = futures[future]
                excluded = future.result()
                prior = cache["games"][replay_id].get("excluded_user_ids")
                if prior is not None and prior != excluded:
                    raise ValueError(f"Participation differs from the cache for {replay_id}")
                cache["games"][replay_id]["excluded_user_ids"] = excluded
                save_cache(cache)
                LOGGER.info("Analyzed %s (%d remaining)", replay_id,
                            sum("excluded_user_ids" not in game for game in cache["games"].values()))
        except (OSError, ValueError, subprocess.SubprocessError, requests.RequestException):
            for future in futures:
                future.cancel()
            raise


if __name__ == "__main__":
    main()
