from __future__ import annotations

from collections import defaultdict
from itertools import combinations

import numpy as np
import pandas as pd

from .config import (
    DEFAULT_CURRENT_WINDOW_DAYS,
    DEFAULT_MIN_NATION_PLAYER_GAMES,
    DEFAULT_MIN_PLAYER_GAMES,
    DEFAULT_MIN_TEAM_GAMES,
    ENERGY_EFFICIENCY_PATH,
    TEAM_MODES,
)
from .clean import PreparedData


def _rank_within_group(frame: pd.DataFrame, group_cols: list[str], score_col: str, rank_col: str) -> pd.Series:
    return frame.groupby(group_cols)[score_col].rank(method="dense", ascending=False).astype(int).rename(rank_col)


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


def _build_team_rankings_for_data(
    data: pd.DataFrame,
    player_lookup: dict[int, dict[str, object]],
    min_games: int,
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

    stats: dict[tuple[str, int, int], dict[str, object]] = defaultdict(
        lambda: {
            "games": 0,
            "last_played": pd.Timestamp.min.tz_localize("UTC"),
            "maps": defaultdict(int),
        }
    )

    grouped = data[["match_id", "team_id", "game_mode", "start_time", "map", "user_id"]].drop_duplicates()
    for (_match_id, _team_id, mode), team in grouped.groupby(["match_id", "team_id", "game_mode"], sort=False):
        players = sorted(set(int(value) for value in team["user_id"].dropna()))
        if len(players) < 2 or len(players) > 16:
            continue

        last_played = team["start_time"].max()
        map_name = str(team["map"].iloc[0] or "")
        for left, right in combinations(players, 2):
            key = (str(mode), left, right)
            item = stats[key]
            item["games"] += 1
            if last_played > item["last_played"]:
                item["last_played"] = last_played
            if map_name:
                item["maps"][map_name] += 1

    records: list[dict[str, object]] = []
    for (mode, left, right), item in stats.items():
        games = int(item["games"])
        if games < min_games:
            continue
        player_ratings = [rating_lookup.get((mode, left)), rating_lookup.get((mode, right))]
        known_ratings = [rating for rating in player_ratings if rating is not None]
        avg_rating = float(np.mean(known_ratings)) if known_ratings else 0.0
        score = round(avg_rating * 100 + np.log1p(games) * 300)
        roster = []
        for user_id in [left, right]:
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
                "roster": roster,
                "games": games,
                "wins": np.nan,
                "losses": np.nan,
                "win_rate": np.nan,
                "avg_rating": round(avg_rating, 2),
                "score": score,
                "last_played": item["last_played"],
                "top_map": maps[0][0] if maps else "",
            }
        )

    if not records:
        return pd.DataFrame()

    ranking = pd.DataFrame(records)
    ranking = ranking.sort_values(["game_mode", "score", "games"], ascending=[True, False, False])
    ranking["rank"] = _rank_within_group(ranking, ["game_mode"], "score", "rank")
    ranking = ranking.sort_values(["game_mode", "rank"]).groupby("game_mode", as_index=False).head(top_per_mode)
    return ranking[
        [
            "game_mode",
            "rank",
            "roster",
            "games",
            "wins",
            "losses",
            "win_rate",
            "avg_rating",
            "score",
            "last_played",
            "top_map",
        ]
    ]


def build_team_rankings(
    prepared: PreparedData,
    periods: list[dict[str, object]],
    min_games: int = DEFAULT_MIN_TEAM_GAMES,
    top_per_mode: int = 500,
) -> pd.DataFrame:
    data = prepared.ranked[prepared.ranked["game_mode"].isin(TEAM_MODES)].copy()
    if data.empty:
        return pd.DataFrame()

    player_lookup = prepared.players.set_index("user_id").to_dict("index")
    rankings = []
    for period in periods:
        period_rows = _period_data(data, period)
        if period_rows.empty:
            continue
        ranking = _build_team_rankings_for_data(period_rows, player_lookup, min_games, top_per_mode)
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
