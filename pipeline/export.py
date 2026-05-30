from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .clean import PreparedData
from .config import DATAMART_URLS, GAME_MODES


def _json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return None if np.isnan(value) else float(value)
    if isinstance(value, float):
        return None if np.isnan(value) else value
    if isinstance(value, np.ndarray):
        return [_json_value(item) for item in value.tolist()]
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if pd.isna(value):
        return None
    return value


def _records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    output: list[dict[str, Any]] = []
    for row in frame.to_dict(orient="records"):
        output.append({key: _json_value(value) for key, value in row.items()})
    return output


def _write_json(path: Path, payload: dict[str, Any], compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    else:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _clean_generated_rankings(output_dir: Path) -> None:
    for pattern in ["player_rankings*.json", "nation_rankings*.json", "team_rankings*.json"]:
        for path in output_dir.glob(pattern):
            path.unlink()


def _period_payload(frame: pd.DataFrame, period_id: str) -> pd.DataFrame:
    period_frame = frame[frame["period"] == period_id].copy() if "period" in frame.columns else frame.copy()
    return period_frame.drop(columns=["period", "period_label"], errors="ignore")


def _completed_year(period: dict[str, Any], active_year: int) -> bool:
    return period.get("type") == "year" and int(period["year"]) < active_year


def _archive_path(output_dir: Path, period_id: str) -> Path:
    return output_dir / "completed" / f"completed_{period_id}.json"


def _archive_counts(path: Path) -> dict[str, int]:
    if not path.exists():
        return {"players": 0, "nations": 0, "teams": 0}

    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        "players": len(payload.get("players", [])),
        "nations": len(payload.get("nations", [])),
        "teams": len(payload.get("teams", [])),
    }


def team_roster_size_options(sizes: list[int]) -> list[dict[str, Any]]:
    labels = {
        2: "Duo",
        3: "Triple",
        4: "Quad",
    }
    return [{"size": int(size), "label": labels.get(int(size), f"{int(size)}-stack")} for size in sorted(set(sizes))]


def _write_category_file(
    output_dir: Path,
    filename: str,
    record_key: str,
    period_id: str,
    frame: pd.DataFrame,
    generated_at: str,
) -> int:
    period_frame = _period_payload(frame, period_id)
    _write_json(
        output_dir / filename,
        {"generatedAt": generated_at, "period": period_id, record_key: _records(period_frame)},
        compact=True,
    )
    return int(len(period_frame))


def _write_completed_archive(
    output_dir: Path,
    period_id: str,
    players: pd.DataFrame,
    nations: pd.DataFrame,
    teams: pd.DataFrame,
    generated_at: str,
    rebuild_completed_years: bool,
) -> dict[str, int]:
    path = _archive_path(output_dir, period_id)
    if path.exists() and not rebuild_completed_years:
        return _archive_counts(path)

    player_frame = _period_payload(players, period_id)
    nation_frame = _period_payload(nations, period_id)
    team_frame = _period_payload(teams, period_id)
    payload = {
        "generatedAt": generated_at,
        "period": period_id,
        "completed": True,
        "players": _records(player_frame),
        "nations": _records(nation_frame),
        "teams": _records(team_frame),
    }
    _write_json(path, payload, compact=True)
    return {
        "players": int(len(player_frame)),
        "nations": int(len(nation_frame)),
        "teams": int(len(team_frame)),
    }


def export_site_data(
    output_dir: Path,
    prepared: PreparedData,
    periods: list[dict[str, Any]],
    players: pd.DataFrame,
    nations: pd.DataFrame,
    teams: pd.DataFrame,
    efficiency: pd.DataFrame,
    team_roster_sizes: list[int] | None = None,
    rebuild_completed_years: bool = False,
) -> None:
    generated_at = datetime.now(timezone.utc).isoformat()
    modes = [mode for mode in GAME_MODES if mode in set(prepared.ranked["game_mode"].dropna())]
    countries = (
        prepared.countries[["alpha-2", "name", "region", "sub-region"]]
        .rename(columns={"alpha-2": "code", "sub-region": "subRegion"})
        .sort_values("name")
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    _clean_generated_rankings(output_dir)

    active_year = int(prepared.matches["start_time"].max().year)
    if team_roster_sizes is None:
        if "roster_size" in teams.columns and not teams.empty:
            team_roster_sizes = sorted(teams["roster_size"].dropna().astype(int).unique().tolist())
        else:
            team_roster_sizes = [2]
    player_files: dict[str, str] = {}
    nation_files: dict[str, str] = {}
    team_files: dict[str, str] = {}
    completed_files: dict[str, str] = {}
    player_counts: dict[str, int] = {}
    nation_counts: dict[str, int] = {}
    team_counts: dict[str, int] = {}

    for period in periods:
        period_id = str(period["id"])
        if _completed_year(period, active_year):
            archive = _archive_path(output_dir, period_id)
            completed_files[period_id] = str(archive.relative_to(output_dir))
            counts = _write_completed_archive(
                output_dir,
                period_id,
                players,
                nations,
                teams,
                generated_at,
                rebuild_completed_years,
            )
            player_counts[period_id] = counts["players"]
            nation_counts[period_id] = counts["nations"]
            team_counts[period_id] = counts["teams"]
            continue

        player_filename = f"player_rankings_{period_id}.json"
        nation_filename = f"nation_rankings_{period_id}.json"
        team_filename = f"team_rankings_{period_id}.json"
        player_files[period_id] = player_filename
        nation_files[period_id] = nation_filename
        team_files[period_id] = team_filename
        player_counts[period_id] = _write_category_file(output_dir, player_filename, "players", period_id, players, generated_at)
        nation_counts[period_id] = _write_category_file(output_dir, nation_filename, "nations", period_id, nations, generated_at)
        team_counts[period_id] = _write_category_file(output_dir, team_filename, "teams", period_id, teams, generated_at)

    metadata = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "sourceUrls": DATAMART_URLS,
        "modes": modes,
        "recordCounts": {
            "rankedRows": int(len(prepared.ranked)),
            "players": int(len(players)),
            "nations": int(len(nations)),
            "teams": int(len(teams)),
            "efficiencyRows": int(len(efficiency)),
        },
        "sourceDateRange": {
            "from": _json_value(prepared.matches["start_time"].min()),
            "to": _json_value(prepared.matches["start_time"].max()),
        },
        "periods": _json_value(periods),
        "teamRosterSizes": team_roster_size_options(team_roster_sizes),
        "files": {
            "players": player_files,
            "nations": nation_files,
            "teams": team_files,
            "completed": completed_files,
        },
        "recordCountsByPeriod": {
            "players": player_counts,
            "nations": nation_counts,
            "teams": team_counts,
        },
        "warnings": prepared.warnings,
    }

    _write_json(output_dir / "metadata.json", metadata)
    _write_json(output_dir / "countries.json", {"generatedAt": generated_at, "countries": _records(countries)})
    _write_json(output_dir / "efficiency_analysis.json", {"generatedAt": generated_at, "units": _records(efficiency)}, compact=True)
