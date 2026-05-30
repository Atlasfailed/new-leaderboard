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


def _write_period_files(
    output_dir: Path,
    base_name: str,
    record_key: str,
    periods: list[dict[str, Any]],
    frame: pd.DataFrame,
    generated_at: str,
) -> tuple[dict[str, str], dict[str, int]]:
    files: dict[str, str] = {}
    counts: dict[str, int] = {}
    for period in periods:
        period_id = str(period["id"])
        period_frame = _period_payload(frame, period_id)
        filename = f"{base_name}_{period_id}.json"
        files[period_id] = filename
        counts[period_id] = int(len(period_frame))
        _write_json(
            output_dir / filename,
            {"generatedAt": generated_at, "period": period_id, record_key: _records(period_frame)},
            compact=True,
        )
    return files, counts


def export_site_data(
    output_dir: Path,
    prepared: PreparedData,
    periods: list[dict[str, Any]],
    players: pd.DataFrame,
    nations: pd.DataFrame,
    teams: pd.DataFrame,
    efficiency: pd.DataFrame,
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

    player_files, player_counts = _write_period_files(
        output_dir, "player_rankings", "players", periods, players, generated_at
    )
    nation_files, nation_counts = _write_period_files(
        output_dir, "nation_rankings", "nations", periods, nations, generated_at
    )
    team_files, team_counts = _write_period_files(output_dir, "team_rankings", "teams", periods, teams, generated_at)

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
        "files": {
            "players": player_files,
            "nations": nation_files,
            "teams": team_files,
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
