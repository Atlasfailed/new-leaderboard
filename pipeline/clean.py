from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import GAME_MODES, ISO_COUNTRY_PATH


@dataclass
class PreparedData:
    matches: pd.DataFrame
    match_players: pd.DataFrame
    players: pd.DataFrame
    ranked: pd.DataFrame
    countries: pd.DataFrame
    warnings: list[str]


def load_countries(path=ISO_COUNTRY_PATH) -> pd.DataFrame:
    countries = pd.read_csv(path)
    countries["alpha-2"] = countries["alpha-2"].astype(str).str.strip().str.upper()
    return countries


def _format_game_mode(raw_value: object, max_team_size: object) -> str | None:
    raw = str(raw_value or "").strip().lower()
    if "duel" in raw:
        return "Duel"
    if "ffa" in raw:
        return "FFA"
    if "small" in raw:
        return "Small Team"
    if "large" in raw:
        return "Large Team"
    if "team" in raw:
        try:
            return "Small Team" if float(max_team_size) <= 5 else "Large Team"
        except (TypeError, ValueError):
            return "Large Team"
    return None


def _clean_players(players: pd.DataFrame, country_names: dict[str, str], regions: dict[str, str]) -> pd.DataFrame:
    clean = players.copy()
    clean["user_id"] = pd.to_numeric(clean["user_id"], errors="coerce").astype("Int64")
    clean = clean.dropna(subset=["user_id"]).copy()
    clean["user_id"] = clean["user_id"].astype(int)
    clean["name"] = clean["name"].fillna("").astype(str).str.strip()
    clean.loc[clean["name"] == "", "name"] = clean["user_id"].map(lambda value: f"Player_{value}")
    clean["country"] = clean["country"].fillna("").astype(str).str.strip().str.upper()
    clean.loc[clean["country"].str.len() != 2, "country"] = ""
    clean["country_name"] = clean["country"].map(country_names).fillna("")
    clean["region"] = clean["country"].map(regions).fillna("")
    return clean[["user_id", "name", "country", "country_name", "region"]]


def _clean_match_players(match_players: pd.DataFrame) -> pd.DataFrame:
    clean = match_players.copy()
    for column in ["match_id", "team_id", "user_id"]:
        clean[column] = pd.to_numeric(clean[column], errors="coerce")
    clean = clean.dropna(subset=["match_id", "team_id", "user_id"]).copy()
    clean[["match_id", "team_id", "user_id"]] = clean[["match_id", "team_id", "user_id"]].astype(int)

    for column in ["old_skill", "old_uncertainty", "new_skill", "new_uncertainty"]:
        clean[column] = pd.to_numeric(clean.get(column), errors="coerce")

    if "party_id" not in clean.columns:
        clean["party_id"] = pd.NA
    if "faction" not in clean.columns:
        clean["faction"] = ""

    return clean


def _prepare_matches(matches: pd.DataFrame, match_players: pd.DataFrame) -> pd.DataFrame:
    clean = matches.copy()
    clean["match_id"] = pd.to_numeric(clean["match_id"], errors="coerce")
    clean = clean.dropna(subset=["match_id"]).copy()
    clean["match_id"] = clean["match_id"].astype(int)
    clean["start_time"] = pd.to_datetime(clean["start_time"], utc=True, errors="coerce")
    clean["is_ranked"] = clean["is_ranked"].fillna(False).astype(bool)
    clean["game_type"] = clean["game_type"].fillna("").astype(str)

    team_sizes = (
        match_players.groupby(["match_id", "team_id"])["user_id"]
        .nunique()
        .groupby("match_id")
        .max()
        .rename("max_team_size")
    )
    player_counts = match_players.groupby("match_id")["user_id"].nunique().rename("player_count")
    clean = clean.merge(team_sizes, on="match_id", how="left").merge(player_counts, on="match_id", how="left")
    clean["game_mode"] = [
        _format_game_mode(raw, size) for raw, size in zip(clean["game_type"], clean["max_team_size"])
    ]

    clean["winning_team"] = pd.to_numeric(clean.get("winning_team"), errors="coerce")
    inferred = _infer_winning_teams(match_players)
    clean = clean.merge(inferred, on="match_id", how="left")
    clean["effective_winning_team"] = clean["winning_team"].where(clean["winning_team"].notna(), clean["inferred_winning_team"])
    clean["winner_source"] = np.where(
        clean["winning_team"].notna(),
        "source",
        np.where(clean["inferred_winning_team"].notna(), "rating_delta", "missing"),
    )

    return clean


def _infer_winning_teams(match_players: pd.DataFrame) -> pd.DataFrame:
    rating_rows = match_players.dropna(subset=["old_skill", "new_skill"]).copy()
    if rating_rows.empty:
        return pd.DataFrame({"match_id": [], "inferred_winning_team": []})

    rating_rows["skill_delta"] = rating_rows["new_skill"] - rating_rows["old_skill"]
    team_delta = (
        rating_rows.groupby(["match_id", "team_id"], as_index=False)["skill_delta"]
        .mean()
        .sort_values(["match_id", "skill_delta"], ascending=[True, False])
    )
    winners = team_delta.drop_duplicates("match_id").copy()
    winners.loc[winners["skill_delta"] <= 0, "team_id"] = np.nan
    return winners[["match_id", "team_id"]].rename(columns={"team_id": "inferred_winning_team"})


def prepare_data(raw: dict[str, pd.DataFrame]) -> PreparedData:
    warnings: list[str] = []
    countries = load_countries()
    country_names = dict(zip(countries["alpha-2"], countries["name"]))
    regions = dict(zip(countries["alpha-2"], countries["sub-region"].fillna("")))

    match_players = _clean_match_players(raw["match_players"])
    matches = _prepare_matches(raw["matches"], match_players)
    players = _clean_players(raw["players"], country_names, regions)

    if matches["winning_team"].notna().sum() == 0 and matches["inferred_winning_team"].notna().sum() == 0:
        warnings.append("winning_team is missing in the datamart; win/loss metrics are unavailable.")
    elif matches["winning_team"].notna().sum() == 0:
        warnings.append("winning_team is missing in the datamart; winners were inferred from rating deltas.")

    ranked = match_players.merge(
        matches[
            [
                "match_id",
                "start_time",
                "map",
                "game_type",
                "game_mode",
                "is_ranked",
                "effective_winning_team",
                "winner_source",
                "player_count",
                "max_team_size",
            ]
        ],
        on="match_id",
        how="left",
    )
    ranked = ranked.merge(players, on="user_id", how="left")
    ranked["game_mode"] = ranked["game_mode"].where(ranked["game_mode"].isin(GAME_MODES))
    ranked = ranked[(ranked["is_ranked"]) & (ranked["game_mode"].notna()) & (ranked["start_time"].notna())].copy()
    ranked["won"] = np.where(
        ranked["effective_winning_team"].notna(),
        (ranked["team_id"] == ranked["effective_winning_team"]).astype(float),
        np.nan,
    )

    return PreparedData(
        matches=matches,
        match_players=match_players,
        players=players,
        ranked=ranked,
        countries=countries,
        warnings=warnings,
    )
