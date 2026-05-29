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


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def export_site_data(
    output_dir: Path,
    prepared: PreparedData,
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
        "warnings": prepared.warnings,
    }

    _write_json(output_dir / "metadata.json", metadata)
    _write_json(output_dir / "countries.json", {"generatedAt": generated_at, "countries": _records(countries)})
    _write_json(output_dir / "player_rankings.json", {"generatedAt": generated_at, "players": _records(players)})
    _write_json(output_dir / "nation_rankings.json", {"generatedAt": generated_at, "nations": _records(nations)})
    _write_json(output_dir / "team_rankings.json", {"generatedAt": generated_at, "teams": _records(teams)})
    _write_json(output_dir / "efficiency_analysis.json", {"generatedAt": generated_at, "units": _records(efficiency)})

