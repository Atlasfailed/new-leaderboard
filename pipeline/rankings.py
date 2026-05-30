from __future__ import annotations

from collections import defaultdict
import numpy as np
import pandas as pd

from .config import (
    DEFAULT_CURRENT_WINDOW_DAYS,
    DEFAULT_MIN_NATION_PLAYER_GAMES,
    DEFAULT_MIN_PLAYER_GAMES,
    DEFAULT_MIN_TEAM_GAMES,
    DEFAULT_TEAM_ROSTER_SIZES,
    ENERGY_EFFICIENCY_PATH,
    TEAM_MODES,
)
from .clean import PreparedData

TEAM_RATING_SCORE_WEIGHT = 70
TEAM_DIFFICULTY_SCORE_WEIGHT = 35
TEAM_PERFORMANCE_SCORE_WEIGHT = 2000
TEAM_EXPECTED_WIN_RATE_SCALE = 12
TEAM_WIN_RATE_PRIOR_GAMES = 16


def _rank_within_group(frame: pd.DataFrame, group_cols: list[str], score_col: str, rank_col: str) -> pd.Series:
    return frame.groupby(group_cols)[score_col].rank(method="dense", ascending=False).astype(int).rename(rank_col)


def _expected_win_rate(team_rating: float, opponent_rating: float) -> float:
    rating_gap = np.clip((team_rating - opponent_rating) / TEAM_EXPECTED_WIN_RATE_SCALE, -6, 6)
    return float(1 / (1 + np.exp(-rating_gap)))


def _adjusted_win_rate(wins: int, decided_games: int) -> float:
    if decided_games <= 0:
        return 0.5
    return float((wins + TEAM_WIN_RATE_PRIOR_GAMES * 0.5) / (decided_games + TEAM_WIN_RATE_PRIOR_GAMES))


def team_size_label(size: int) -> str:
    labels = {
        2: "Duo",
        3: "Triple",
        4: "Quad",
    }
    return labels.get(size, f"{size}-stack")


def build_periods(prepared: PreparedData, current_window_days: int = DEFAULT_CURRENT_WINDOW_DAYS) -> list[dict[str, object]]:
    data = prepared.ranked.dropna(subset=["start_time"])
    if data.empty:
        return []

    latest = data["start_time"].max()
    current_start = latest - pd.Timedelta(days=current_window_days)
    periods: list[dict[str, object]] = [
        {
            "id": "current",
            "label": "Current",
            "description": f"Last {current_window_days} days",
            "type": "current",
            "from": current_start,
            "to": latest,
        }
    ]

    years = sorted(data["start_time"].dt.year.dropna().astype(int).unique(), reverse=True)
    for year in years:
        periods.append(
            {
                "id": str(year),
                "label": str(year),
                "description": f"Games played in {year}",
                "type": "year",
                "year": int(year),
                "from": pd.Timestamp(year=year, month=1, day=1, tz="UTC"),
                "to": pd.Timestamp(year=year, month=12, day=31, hour=23, minute=59, second=59, tz="UTC"),
            }
        )

    return periods


def _period_data(data: pd.DataFrame, period: dict[str, object]) -> pd.DataFrame:
    if period["type"] == "current":
        return data[(data["start_time"] >= period["from"]) & (data["start_time"] <= period["to"])].copy()
    return data[data["start_time"].dt.year == int(period["year"])].copy()


def _with_period(frame: pd.DataFrame, period: dict[str, object]) -> pd.DataFrame:
    frame = frame.copy()
    frame["period"] = period["id"]
    frame["period_label"] = period["label"]
    return frame


def _build_player_rankings_for_data(data: pd.DataFrame, min_games: int) -> pd.DataFrame:
    stats = (
        data.groupby(["game_mode", "user_id"], as_index=False)
        .agg(
            games=("match_id", "nunique"),
            decided_games=("won", "count"),
            wins=("won", "sum"),
            last_played=("start_time", "max"),
        )
    )
    latest = (
        data.sort_values("start_time")
        .groupby(["game_mode", "user_id"], as_index=False)
        .tail(1)[
            [
                "game_mode",
                "user_id",
                "name",
                "country",
                "country_name",
                "region",
                "new_skill",
                "new_uncertainty",
            ]
        ]
    )
    ranking = latest.merge(stats, on=["game_mode", "user_id"], how="inner")
    ranking = ranking[ranking["games"] >= min_games].copy()
    if ranking.empty:
        return ranking

    ranking["rating"] = ranking["new_skill"] - ranking["new_uncertainty"]
    ranking["losses"] = ranking["decided_games"] - ranking["wins"]
    ranking["win_rate"] = np.where(ranking["decided_games"] > 0, ranking["wins"] / ranking["decided_games"], np.nan)
    ranking["rank"] = _rank_within_group(ranking, ["game_mode"], "rating", "rank")
    ranking["country_rank"] = _rank_within_group(ranking, ["game_mode", "country"], "rating", "country_rank")
    ranking = ranking.sort_values(["game_mode", "rank", "name"])

    return ranking[
        [
            "game_mode",
            "rank",
            "country_rank",
            "user_id",
            "name",
            "country",
            "country_name",
            "region",
            "rating",
            "new_skill",
            "new_uncertainty",
            "games",
            "decided_games",
            "wins",
            "losses",
            "win_rate",
            "last_played",
        ]
    ]


def build_player_rankings(
    prepared: PreparedData,
    periods: list[dict[str, object]],
    min_games: int = DEFAULT_MIN_PLAYER_GAMES,
) -> pd.DataFrame:
    data = prepared.ranked.dropna(subset=["new_skill", "new_uncertainty"]).copy()
    if data.empty:
        return pd.DataFrame()

    rankings = []
    for period in periods:
        period_rows = _period_data(data, period)
        if period_rows.empty:
            continue
        ranking = _build_player_rankings_for_data(period_rows, min_games)
        if not ranking.empty:
            rankings.append(_with_period(ranking, period))

    return pd.concat(rankings, ignore_index=True) if rankings else pd.DataFrame()


def _build_nation_rankings_for_data(data: pd.DataFrame, min_player_games: int) -> pd.DataFrame:
    data = data[data["country"].fillna("") != ""]
    if data.empty:
        return pd.DataFrame()

    stats = (
        data.groupby(["game_mode", "user_id"], as_index=False)
        .agg(total_games=("match_id", "nunique"), last_played=("start_time", "max"))
    )
    latest = (
        data.sort_values("start_time")
        .groupby(["game_mode", "user_id"], as_index=False)
        .tail(1)[["game_mode", "user_id", "name", "country", "country_name", "new_skill", "new_uncertainty"]]
    )
    player_stats = latest.merge(stats, on=["game_mode", "user_id"], how="inner")
    player_stats = player_stats[player_stats["total_games"] >= min_player_games].copy()
    if player_stats.empty:
        return pd.DataFrame()

    player_stats["rating"] = player_stats["new_skill"] - player_stats["new_uncertainty"]

    nation = (
        player_stats.groupby(["game_mode", "country", "country_name"], as_index=False)
        .agg(
            total_games=("total_games", "sum"),
            player_count=("user_id", "nunique"),
            avg_rating=("rating", "mean"),
            median_rating=("rating", "median"),
        )
    )
    nation = nation[nation["player_count"] >= 3].copy()
    if nation.empty:
        return pd.DataFrame()

    top_ratings = (
        player_stats.sort_values(["game_mode", "country", "rating"], ascending=[True, True, False])
        .groupby(["game_mode", "country"])
        .head(10)
        .groupby(["game_mode", "country"])["rating"]
        .mean()
        .rename("top10_rating")
        .reset_index()
    )
    nation = nation.merge(top_ratings, on=["game_mode", "country"], how="left")
    nation["raw_score"] = ((nation["top10_rating"] * 0.7 + nation["avg_rating"] * 0.3) * 100).round()
    nation["confidence_factor"] = np.minimum(1.0, np.log1p(nation["player_count"]) / np.log1p(10))
    nation["adjusted_score"] = (nation["raw_score"] * nation["confidence_factor"]).round()
    nation["score"] = nation["adjusted_score"]
    nation["wins"] = np.nan
    nation["losses"] = np.nan
    nation["win_rate"] = np.nan

    contributors: dict[tuple[str, str], list[dict[str, object]]] = {}
    for (mode, country), group in player_stats.groupby(["game_mode", "country"]):
        top = group.sort_values(["rating", "total_games"], ascending=False).head(5)
        contributors[(mode, country)] = [
            {
                "name": row.name,
                "score": round(float(row.rating), 2),
                "games": int(row.total_games),
            }
            for row in top.itertuples(index=False)
        ]

    nation["top_contributors"] = [
        contributors.get((row.game_mode, row.country), []) for row in nation.itertuples(index=False)
    ]
    nation = nation.sort_values(["game_mode", "adjusted_score", "total_games"], ascending=[True, False, False])
    nation["rank"] = _rank_within_group(nation, ["game_mode"], "adjusted_score", "rank")

    return nation[
        [
            "game_mode",
            "rank",
            "country",
            "country_name",
            "adjusted_score",
            "raw_score",
            "score",
            "wins",
            "losses",
            "total_games",
            "player_count",
            "win_rate",
            "avg_rating",
            "median_rating",
            "top10_rating",
            "confidence_factor",
            "top_contributors",
        ]
    ].sort_values(["game_mode", "rank"])


def build_nation_rankings(
    prepared: PreparedData,
    periods: list[dict[str, object]],
    min_player_games: int = DEFAULT_MIN_NATION_PLAYER_GAMES,
) -> pd.DataFrame:
    data = prepared.ranked.dropna(subset=["new_skill", "new_uncertainty"]).copy()
    if data.empty:
        return pd.DataFrame()

    rankings = []
    for period in periods:
        period_rows = _period_data(data, period)
        if period_rows.empty:
            continue
        ranking = _build_nation_rankings_for_data(period_rows, min_player_games)
        if not ranking.empty:
            rankings.append(_with_period(ranking, period))

    return pd.concat(rankings, ignore_index=True) if rankings else pd.DataFrame()


def _build_matchup_lookup(data: pd.DataFrame) -> dict[tuple[int, int], dict[str, float]]:
    required = {"match_id", "team_id", "old_skill", "old_uncertainty", "new_skill", "new_uncertainty"}
    if not required.issubset(data.columns):
        return {}

    ratings = data[["match_id", "team_id", "old_skill", "old_uncertainty", "new_skill", "new_uncertainty"]].copy()
    pre_match_rating = ratings["old_skill"] - ratings["old_uncertainty"]
    post_match_rating = ratings["new_skill"] - ratings["new_uncertainty"]
    ratings["player_match_rating"] = pre_match_rating.where(pre_match_rating.notna(), post_match_rating)
    ratings = ratings.dropna(subset=["player_match_rating"])
    if ratings.empty:
        return {}

    team_ratings = (
        ratings.groupby(["match_id", "team_id"], as_index=False)["player_match_rating"]
        .mean()
        .rename(columns={"player_match_rating": "team_match_rating"})
    )
    match_totals = (
        team_ratings.groupby("match_id")["team_match_rating"]
        .agg(match_rating_sum="sum", team_count="count")
        .reset_index()
    )
    team_ratings = team_ratings.merge(match_totals, on="match_id", how="left")
    team_ratings = team_ratings[team_ratings["team_count"] > 1].copy()
    if team_ratings.empty:
        return {}

    team_ratings["opponent_difficulty"] = (
        team_ratings["match_rating_sum"] - team_ratings["team_match_rating"]
    ) / (team_ratings["team_count"] - 1)
    rating_gap = np.clip(
        (team_ratings["team_match_rating"] - team_ratings["opponent_difficulty"]) / TEAM_EXPECTED_WIN_RATE_SCALE,
        -6,
        6,
    )
    team_ratings["expected_win_rate"] = 1 / (1 + np.exp(-rating_gap))
    return {
        (int(row.match_id), int(row.team_id)): {
            "opponent_difficulty": float(row.opponent_difficulty),
            "expected_win_rate": float(row.expected_win_rate),
        }
        for row in team_ratings.itertuples(index=False)
        if not pd.isna(row.opponent_difficulty) and not pd.isna(row.expected_win_rate)
    }


def _build_team_rankings_for_data(
    data: pd.DataFrame,
    player_lookup: dict[int, dict[str, object]],
    min_games: int,
    roster_sizes: list[int],
    top_per_mode: int,
) -> pd.DataFrame:
    latest_ratings = (
        data.dropna(subset=["new_skill", "new_uncertainty"])
        .sort_values("start_time")
        .groupby(["game_mode", "user_id"], as_index=False)
        .tail(1)
    )
    rating_lookup = {
        (str(row.game_mode), int(row.user_id)): float(row.new_skill - row.new_uncertainty)
        for row in latest_ratings.itertuples(index=False)
    }

    stats: dict[tuple[str, int, tuple[int, ...]], dict[str, object]] = defaultdict(
        lambda: {
            "games": 0,
            "decided_games": 0,
            "wins": 0,
            "opponent_difficulty_sum": 0.0,
            "opponent_difficulty_count": 0,
            "expected_win_rate_sum": 0.0,
            "expected_win_rate_count": 0,
            "last_played": pd.Timestamp.min.tz_localize("UTC"),
            "maps": defaultdict(int),
        }
    )

    party_rows = data.dropna(subset=["party_id"]).copy()
    party_rows["party_id"] = party_rows["party_id"].astype(str).str.strip()
    party_rows = party_rows[party_rows["party_id"] != ""]
    if party_rows.empty:
        return pd.DataFrame()

    matchup_lookup = _build_matchup_lookup(data)
    grouped = party_rows[
        ["match_id", "team_id", "party_id", "game_mode", "start_time", "map", "user_id", "won"]
    ].drop_duplicates()
    for (match_id, team_id, _party_id, mode), team in grouped.groupby(
        ["match_id", "team_id", "party_id", "game_mode"], sort=False
    ):
        players = sorted(set(int(value) for value in team["user_id"].dropna()))
        roster_size = len(players)
        if roster_size not in roster_sizes:
            continue

        last_played = team["start_time"].max()
        map_name = str(team["map"].iloc[0] or "")
        roster_ids = tuple(players)
        key = (str(mode), roster_size, roster_ids)
        item = stats[key]
        item["games"] += 1
        won_values = team["won"].dropna()
        if not won_values.empty:
            item["decided_games"] += 1
            item["wins"] += int(float(won_values.iloc[0]) > 0)
        matchup = matchup_lookup.get((int(match_id), int(team_id)))
        if matchup is not None:
            item["opponent_difficulty_sum"] += matchup["opponent_difficulty"]
            item["opponent_difficulty_count"] += 1
            item["expected_win_rate_sum"] += matchup["expected_win_rate"]
            item["expected_win_rate_count"] += 1
        if last_played > item["last_played"]:
            item["last_played"] = last_played
        if map_name:
            item["maps"][map_name] += 1

    records: list[dict[str, object]] = []
    for (mode, roster_size, roster_ids), item in stats.items():
        games = int(item["games"])
        if games < min_games:
            continue
        decided_games = int(item["decided_games"])
        wins = int(item["wins"])
        losses = decided_games - wins
        win_rate = wins / decided_games if decided_games else np.nan
        player_ratings = [rating_lookup.get((mode, user_id)) for user_id in roster_ids]
        known_ratings = [rating for rating in player_ratings if rating is not None]
        avg_rating = float(np.mean(known_ratings)) if known_ratings else 0.0
        avg_opponent_rating = (
            float(item["opponent_difficulty_sum"]) / int(item["opponent_difficulty_count"])
            if int(item["opponent_difficulty_count"])
            else np.nan
        )
        difficulty_for_score = avg_opponent_rating if not np.isnan(avg_opponent_rating) else avg_rating
        expected_win_rate = (
            float(item["expected_win_rate_sum"]) / int(item["expected_win_rate_count"])
            if int(item["expected_win_rate_count"])
            else _expected_win_rate(avg_rating, difficulty_for_score)
        )
        adjusted_win_rate = _adjusted_win_rate(wins, decided_games)
        performance_vs_expected = adjusted_win_rate - expected_win_rate
        score = round(
            avg_rating * TEAM_RATING_SCORE_WEIGHT
            + difficulty_for_score * TEAM_DIFFICULTY_SCORE_WEIGHT
            + performance_vs_expected * TEAM_PERFORMANCE_SCORE_WEIGHT
        )
        roster = []
        for user_id in roster_ids:
            player = player_lookup.get(user_id, {})
            roster.append(
                {
                    "userId": user_id,
                    "name": player.get("name", f"Player_{user_id}"),
                    "countryCode": player.get("country", ""),
                    "countryName": player.get("country_name", ""),
                }
            )
        maps = sorted(item["maps"].items(), key=lambda pair: pair[1], reverse=True)
        records.append(
            {
                "game_mode": mode,
                "roster_size": roster_size,
                "roster_label": team_size_label(roster_size),
                "roster": roster,
                "games": games,
                "wins": wins if decided_games else np.nan,
                "losses": losses if decided_games else np.nan,
                "win_rate": win_rate,
                "avg_rating": round(avg_rating, 2),
                "avg_opponent_rating": round(avg_opponent_rating, 2) if not np.isnan(avg_opponent_rating) else np.nan,
                "expected_win_rate": expected_win_rate,
                "adjusted_win_rate": adjusted_win_rate,
                "performance_vs_expected": performance_vs_expected,
                "score": score,
                "last_played": item["last_played"],
                "top_map": maps[0][0] if maps else "",
            }
        )

    if not records:
        return pd.DataFrame()

    ranking = pd.DataFrame(records)
    ranking = ranking.sort_values(
        ["game_mode", "roster_size", "score", "performance_vs_expected", "win_rate", "avg_opponent_rating", "games"],
        ascending=[True, True, False, False, False, False, False],
    )
    ranking["rank"] = _rank_within_group(ranking, ["game_mode", "roster_size"], "score", "rank")
    ranking = (
        ranking.sort_values(["game_mode", "roster_size", "rank"])
        .groupby(["game_mode", "roster_size"], as_index=False)
        .head(top_per_mode)
    )
    return ranking[
        [
            "game_mode",
            "roster_size",
            "roster_label",
            "rank",
            "roster",
            "games",
            "wins",
            "losses",
            "win_rate",
            "avg_rating",
            "avg_opponent_rating",
            "expected_win_rate",
            "adjusted_win_rate",
            "performance_vs_expected",
            "score",
            "last_played",
            "top_map",
        ]
    ]


def build_team_rankings(
    prepared: PreparedData,
    periods: list[dict[str, object]],
    min_games: int = DEFAULT_MIN_TEAM_GAMES,
    roster_sizes: list[int] | None = None,
    top_per_mode: int = 500,
) -> pd.DataFrame:
    data = prepared.ranked[prepared.ranked["game_mode"].isin(TEAM_MODES)].copy()
    if data.empty:
        return pd.DataFrame()

    roster_sizes = sorted(set(roster_sizes or DEFAULT_TEAM_ROSTER_SIZES))
    player_lookup = prepared.players.set_index("user_id").to_dict("index")
    rankings = []
    for period in periods:
        period_rows = _period_data(data, period)
        if period_rows.empty:
            continue
        ranking = _build_team_rankings_for_data(period_rows, player_lookup, min_games, roster_sizes, top_per_mode)
        if not ranking.empty:
            rankings.append(_with_period(ranking, period))

    return pd.concat(rankings, ignore_index=True) if rankings else pd.DataFrame()


def build_efficiency_analysis(path=ENERGY_EFFICIENCY_PATH) -> pd.DataFrame:
    data = pd.read_csv(path)
    data["faction"] = data["faction"].astype(str).str.upper()
    data["is_variable_energy"] = data["is_variable_energy"].astype(str).str.lower().isin(["true", "1", "yes"])
    numeric_cols = [
        "wind_tidal_speed",
        "energy_output",
        "total_cost",
        "buildtime",
        "metal_efficiency",
        "time_efficiency",
        "metalcost",
        "energycost",
    ]
    for column in numeric_cols:
        data[column] = pd.to_numeric(data[column], errors="coerce")

    return data[
        [
            "unit_name",
            "display_name",
            "description",
            "faction",
            "is_variable_energy",
            "wind_tidal_speed",
            "energy_output",
            "total_cost",
            "buildtime",
            "metal_efficiency",
            "time_efficiency",
            "metalcost",
            "energycost",
        ]
    ].sort_values(["faction", "wind_tidal_speed", "display_name"])
