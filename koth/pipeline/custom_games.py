"""AllReasonNoLogic KOTH leaderboard (Kings vs Peasants).

Custom king-of-the-hill games are organised on Sundays by a few known hosts. The
small "kings" team gets a handicap bonus and fights a much larger "peasants"
team. Replays come from the BAR replay API and are cached in a compact,
committed JSON file so refreshes only download new games.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

REFERENCE_DIR = Path(__file__).resolve().parent / "reference"

LOGGER = logging.getLogger(__name__)

API_URL = "https://api.bar-rts.com/replays"
ORGANIZERS = ["TANKTOM", "Twig", "Praedyth", "AllReasonNoLogic"]
ORGANIZER_NAMES = {name.lower() for name in ORGANIZERS}
FIRST_DAY = date(2024, 9, 1)
MIN_KINGS = 2
RATIO = 2
RESCAN_DAYS = 14
SUNDAY = 6
MIN_DURATION_MS = 5 * 60 * 1000
START_RATING = 1500
K_NEW = 48
K_SETTLED = 24
PROVISIONAL_GAMES = 8
# Ranking score is a conservative estimate: Elo minus SCORE_K x uncertainty.
# Uncertainty starts at SIGMA_START and shrinks with games played.
SIGMA_START = 350.0
SIGMA_GAMES_SCALE = 5.0
SIGMA_FLOOR_GAMES = 50
SCORE_K = 2.0
CACHE_PATH = REFERENCE_DIR / "custom_games.json"
OUTPUT_NAME = "rankings.json"
WIN_WARMUP = 80
WIN_STEP = 20
ROLES = ("kings", "peasants")


def _get(url: str, **params) -> dict:
    for attempt in range(3):
        try:
            response = requests.get(url, params=params or None, timeout=60)
            response.raise_for_status()
            return response.json()
        except requests.RequestException:
            if attempt == 2:
                raise
    raise RuntimeError("unreachable")


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_cache(path: Path = CACHE_PATH) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"games": {}, "rejected": []}


def save_cache(cache: dict, path: Path = CACHE_PATH) -> None:
    cache["rejected"] = sorted(set(cache["rejected"]))
    games = dict(sorted(cache["games"].items(), key=lambda item: item[1]["start_time"]))
    payload = {
        "organizers": ORGANIZERS,
        "scanned_through": cache.get("scanned_through"),
        "games": games,
        "rejected": cache["rejected"],
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def _sundays(start: date, end: date) -> list[str]:
    days = []
    current = start + timedelta(days=(SUNDAY - start.weekday()) % 7)
    while current <= end:
        days.append(current.isoformat())
        current += timedelta(days=7)
    return days


def _list_day(day: str) -> list[str]:
    """Bot-free two-team replays of one day where one team is at least twice the size of the other."""
    ids: list[str] = []
    page = 1
    while True:
        data = _get(API_URL, page=page, limit=100, date=day, hasBots="false").get("data", [])
        if not data:
            return ids
        for item in data:
            allies = item["AllyTeams"]
            if len(allies) != 2:
                continue
            small, large = sorted(len(ally["Players"]) for ally in allies)
            if small >= MIN_KINGS and large >= RATIO * small:
                ids.append(item["id"])
        page += 1


def _list_candidates(known: set[str], scanned_through: str | None) -> list[str]:
    """Scan every Sunday, so games where an organizer only hosted are found too."""
    today = datetime.now(timezone.utc).date()
    start = date.fromisoformat(scanned_through) - timedelta(days=RESCAN_DAYS) if scanned_through else FIRST_DAY
    days = _sundays(max(start, FIRST_DAY), today)
    LOGGER.info("Scanning %d Sundays from %s", len(days), days[0] if days else "-")
    with ThreadPoolExecutor(max_workers=6) as pool:
        found = [replay_id for ids in pool.map(_list_day, days) for replay_id in ids]
    return [replay_id for replay_id in dict.fromkeys(found) if replay_id not in known]


def _parse_skill(raw) -> float | None:
    """The API returns skill as a string like "[12.43]"."""
    match = re.search(r"-?\d+(?:\.\d+)?", str(raw or ""))
    return float(match.group()) if match else None


def classify_replay(replay: dict) -> dict | None:
    """Return a compact game record, or None if this is not a kings/peasants game."""
    allies = replay.get("AllyTeams", [])
    if len(allies) != 2 or replay.get("hasBots") or any(not ally["Players"] for ally in allies):
        return None
    if replay.get("durationMs", 0) < MIN_DURATION_MS:
        return None
    if sum(bool(ally["winningTeam"]) for ally in allies) != 1:
        return None
    handicapped = [i for i, ally in enumerate(allies) if any(p["handicap"] > 0 for p in ally["Players"])]
    if len(handicapped) != 1:
        return None
    kings_index = handicapped[0]
    if len(allies[kings_index]["Players"]) > len(allies[1 - kings_index]["Players"]):
        return None
    # Organizers usually host from the spectator list, so check both.
    names = {p["name"].lower() for ally in allies for p in ally["Players"]}
    names |= {spectator["name"].lower() for spectator in replay.get("Spectators", [])}
    if not names & ORGANIZER_NAMES:
        return None

    def players(ally: dict) -> list[list]:
        return [
            [p["userId"], p["name"], p.get("countryCode") or "", _parse_skill(p.get("skill"))]
            for p in ally["Players"]
            if p.get("userId")
        ]

    return {
        "start_time": replay["startTime"],
        "map": replay["Map"]["scriptName"],
        "duration_ms": replay["durationMs"],
        "kings_won": bool(allies[kings_index]["winningTeam"]),
        "kings_handicap": max(p["handicap"] for p in allies[kings_index]["Players"]),
        "kings": players(allies[kings_index]),
        "peasants": players(allies[1 - kings_index]),
    }


def refresh_cache(cache: dict) -> dict:
    known = set(cache["games"]) | set(cache["rejected"])
    candidates = _list_candidates(known, cache.get("scanned_through"))
    LOGGER.info("Fetching %d new replays", len(candidates))

    def fetch(replay_id: str) -> tuple[str, dict]:
        return replay_id, _get(f"{API_URL}/{replay_id}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        for replay_id, replay in pool.map(fetch, candidates):
            record = classify_replay(replay)
            if record:
                cache["games"][replay_id] = record
            else:
                cache["rejected"].append(replay_id)
    cache["scanned_through"] = datetime.now(timezone.utc).date().isoformat()
    return cache


def _features(game: dict) -> list[float]:
    ratio = len(game["peasants"]) / len(game["kings"])
    return [1.0, game["kings_handicap"] / 100, math.log(ratio)]


def fit_baseline(games: list[dict]) -> list[float]:
    """Logistic fit of the Kings' win chance from bonus and team size, ignoring players."""
    if not games:
        return [0.0, 0.0, 0.0]
    features = np.array([_features(game) for game in games])
    outcome = np.array([game["kings_won"] for game in games], dtype=float)
    weights = np.zeros(3)
    ridge = 1e-3
    for _ in range(50):
        chance = 1 / (1 + np.exp(-features @ weights))
        hessian = features.T @ (features * (chance * (1 - chance))[:, None]) + ridge * np.eye(3)
        weights += np.linalg.solve(hessian, features.T @ (outcome - chance) - ridge * weights)
    return weights.tolist()


def _skill_gap(game: dict) -> float:
    """Mean OpenSkill of the Kings minus the Peasants, in units of 5 points."""
    means = []
    for role in ROLES:
        values = [player[3] for player in game[role] if len(player) > 3 and player[3] is not None]
        means.append(sum(values) / len(values) if values else None)
    if means[0] is None or means[1] is None:
        return 0.0
    return (means[0] - means[1]) / 5


def _win_features(game: dict) -> list[float]:
    return [*_features(game), _skill_gap(game)]


def _fit_logistic(features: np.ndarray, outcome: np.ndarray) -> np.ndarray:
    weights = np.zeros(features.shape[1])
    ridge = 1e-2
    for _ in range(50):
        chance = 1 / (1 + np.exp(-features @ weights))
        hessian = features.T @ (features * (chance * (1 - chance))[:, None]) + ridge * np.eye(len(weights))
        weights += np.linalg.solve(hessian, features.T @ (outcome - chance) - ridge * weights)
    return weights


def fit_win_model(games: list[dict]) -> tuple[list[float], dict]:
    """Win chance from bonus, team-size ratio and mean OpenSkill gap, plus a walk-forward backtest."""
    if len(games) < WIN_WARMUP:
        return [0.0, 0.0, 0.0, 0.0], {"games": 0, "accuracy": None}
    features = np.array([_win_features(game) for game in games])
    outcome = np.array([game["kings_won"] for game in games], dtype=float)
    hits = tested = 0
    bands = [{"name": name, "games": 0, "hits": 0} for name in ("toss_up", "peasants", "kings")]
    for start in range(WIN_WARMUP, len(games), WIN_STEP):
        weights = _fit_logistic(features[:start], outcome[:start])
        chance = 1 / (1 + np.exp(-features[start : start + WIN_STEP] @ weights))
        hits += int(np.sum((chance > 0.5) == (outcome[start : start + WIN_STEP] > 0.5)))
        tested += len(chance)
        favourite = np.maximum(chance, 1 - chance)
        correct = (chance > 0.5) == (outcome[start : start + WIN_STEP] > 0.5)
        masks = [favourite < 0.6, (favourite >= 0.6) & (chance < 0.5), (favourite >= 0.6) & (chance > 0.5)]
        for band, inside in zip(bands, masks):
            band["games"] += int(inside.sum())
            band["hits"] += int(correct[inside].sum())
    weights = _fit_logistic(features, outcome)
    bands = [{"name": b["name"], "games": b["games"], "accuracy": round(b["hits"] / b["games"], 3) if b["games"] else None} for b in bands]
    return weights.tolist(), {"games": tested, "accuracy": round(hits / tested, 3), "bands": bands}


def _kings_chance(game: dict, baseline: list[float], kings_avg: float, peasants_avg: float) -> float:
    logit = sum(w * f for w, f in zip(baseline, _features(game)))
    logit += (kings_avg - peasants_avg) * math.log(10) / 400
    return 1 / (1 + math.exp(-logit))


def run_elo(games: list[dict], baseline: list[float]) -> tuple[list[dict], dict]:
    """Play all games in order. Each player has a separate Kings and Peasants rating.

    The expected result starts from the bonus/size baseline, then shifts by the
    difference between the two team average ratings.
    """
    ratings = {role: defaultdict(lambda: START_RATING) for role in ROLES}
    played = {role: defaultdict(int) for role in ROLES}
    details = []
    for game in games:
        average = {
            role: sum(ratings[role][user_id] for user_id, *_ in game[role]) / max(len(game[role]), 1)
            for role in ROLES
        }
        expected = _kings_chance(game, baseline, average["kings"], average["peasants"])
        surprise = float(game["kings_won"]) - expected
        deltas = {}
        for role, sign in (("kings", 1), ("peasants", -1)):
            deltas[role] = {}
            for user_id, *_ in game[role]:
                k_factor = K_NEW if played[role][user_id] < PROVISIONAL_GAMES else K_SETTLED
                delta = sign * k_factor * surprise
                ratings[role][user_id] += delta
                played[role][user_id] += 1
                deltas[role][user_id] = (delta, ratings[role][user_id])
        details.append({"expected": expected, "deltas": deltas})
    return details, ratings


def _sigma(games: int) -> float:
    return SIGMA_START / math.sqrt(1 + min(games, SIGMA_FLOOR_GAMES) / SIGMA_GAMES_SCALE)


def _score(rating: float, games: int) -> float:
    return rating - SCORE_K * _sigma(games)


def _build_role(games: list[dict], details: list[dict], role: str) -> list[dict]:
    stats: dict[int, dict] = {}
    for game, detail in zip(games, details):
        won = game["kings_won"] == (role == "kings")
        for user_id, name, country, *_ in game[role]:
            entry = stats.setdefault(
                user_id,
                {"name": "", "country": "", "games": 0, "wins": 0, "first": game["start_time"], "results": [], "peak": 0.0},
            )
            rating_after = detail["deltas"][role][user_id][1]
            entry["name"], entry["country"] = name, country or entry["country"]
            entry["games"] += 1
            entry["wins"] += won
            entry["last"] = game["start_time"]
            entry["rating"] = rating_after
            entry["peak"] = max(entry["peak"], _score(rating_after, entry["games"]))
            entry["results"].append(won)

    rows = []
    for user_id, entry in stats.items():
        streak = 0
        for won in reversed(entry["results"]):
            if won != entry["results"][-1]:
                break
            streak += 1
        rows.append(
            {
                "user_id": user_id,
                "name": entry["name"],
                "country": entry["country"],
                "games": entry["games"],
                "wins": entry["wins"],
                "losses": entry["games"] - entry["wins"],
                "win_rate": entry["wins"] / entry["games"],
                "rating": round(entry["rating"], 1),
                "score": round(_score(entry["rating"], entry["games"]), 1),
                "peak": round(entry["peak"], 1),
                "streak": streak if entry["results"][-1] else -streak,
                "first_played": entry["first"],
                "last_played": entry["last"],
            }
        )
    rows.sort(key=lambda row: (-row["score"], -row["games"], row["name"].lower()))
    for rank, row in enumerate(rows, start=1):
        row["rank"] = rank
    return rows


def build_custom_rankings(cache: dict) -> dict:
    games_with_ids = sorted(cache["games"].items(), key=lambda item: item[1]["start_time"])
    games = [game for _, game in games_with_ids]
    baseline = fit_baseline(games)
    details, _ = run_elo(games, baseline)
    win_weights, backtest = fit_win_model(games)
    years = sorted({game["start_time"][:4] for game in games}, reverse=True)
    periods = [{"id": "all", "label": "All time"}] + [{"id": year, "label": year} for year in years]

    rankings = {role: {} for role in ROLES}
    summary = {}
    for period in periods:
        picked = [
            (game, detail)
            for game, detail in zip(games, details)
            if period["id"] == "all" or game["start_time"].startswith(period["id"])
        ]
        subset = [game for game, _ in picked]
        subset_details = [detail for _, detail in picked]
        for role in ROLES:
            rankings[role][period["id"]] = _build_role(subset, subset_details, role)
        kings_wins = sum(g["kings_won"] for g in subset)
        summary[period["id"]] = {
            "games": len(subset),
            "kings_wins": kings_wins,
            "peasants_wins": len(subset) - kings_wins,
        }

    # Score after every game per player and role, in play order: [id, name, score, score change].
    seen = {role: defaultdict(int) for role in ROLES}
    last_score = {role: defaultdict(lambda: _score(START_RATING, 0)) for role in ROLES}
    rosters = []
    for (_, game), detail in zip(games_with_ids, details):
        per_role = {}
        for role in ROLES:
            rows = []
            for user_id, name, *_ in game[role]:
                seen[role][user_id] += 1
                score = _score(detail["deltas"][role][user_id][1], seen[role][user_id])
                rows.append([user_id, name, round(score, 1), round(score - last_score[role][user_id], 1)])
                last_score[role][user_id] = score
            per_role[role] = rows
        rosters.append(per_role)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "organizers": ORGANIZERS,
        "startRating": START_RATING,
        "model": {"winWeights": [round(w, 4) for w in win_weights], "backtest": backtest, "baseline": [round(w, 4) for w in baseline], "kNew": K_NEW, "kSettled": K_SETTLED, "provisionalGames": PROVISIONAL_GAMES},
        "periods": periods,
        "summary": summary,
        "rankings": rankings,
        "games": [
            {
                "id": replay_id,
                "start_time": game["start_time"],
                "map": game["map"],
                "duration_ms": game["duration_ms"],
                "kings_handicap": game["kings_handicap"],
                "kings_expected": round(1 / (1 + math.exp(-float(np.dot(win_weights, _win_features(game))))), 3),
                "winner": "kings" if game["kings_won"] else "peasants",
                "kings": rosters[index]["kings"],
                "peasants": rosters[index]["peasants"],
            }
            for index, (replay_id, game) in reversed(list(enumerate(games_with_ids)))
        ],
    }


def main() -> None:
    """Scan for new games, save the cache when it changed and write the site data."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("site/data"))
    parser.add_argument("--no-refresh", action="store_true", help="Build from the cache without scanning")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    cache = load_cache()
    before = (len(cache["games"]), len(cache["rejected"]))
    if not args.no_refresh:
        cache = refresh_cache(cache)
        # Only write when something new was seen, so quiet weeks produce no commit.
        if (len(cache["games"]), len(cache["rejected"])) != before:
            save_cache(cache)
    payload = build_custom_rankings(cache)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / OUTPUT_NAME).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Games: {before[0]} -> {len(cache['games'])}")


if __name__ == "__main__":
    main()
