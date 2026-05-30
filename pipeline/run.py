from __future__ import annotations

import argparse
import logging
from pathlib import Path

from .clean import prepare_data
from .config import (
    DEFAULT_CURRENT_WINDOW_DAYS,
    DEFAULT_MIN_NATION_PLAYER_GAMES,
    DEFAULT_MIN_PLAYER_GAMES,
    DEFAULT_MIN_TEAM_GAMES,
    PROJECT_ROOT,
)
from .export import export_site_data
from .io import load_sources
from .rankings import (
    build_efficiency_analysis,
    build_nation_rankings,
    build_periods,
    build_player_rankings,
    build_team_rankings,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static BAR leaderboard data.")
    parser.add_argument("--source-dir", type=Path, help="Directory containing matches/match_players/players parquet files.")
    parser.add_argument("--cache-dir", type=Path, default=PROJECT_ROOT / ".cache" / "datamarts")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "site" / "data")
    parser.add_argument("--refresh", action="store_true", help="Download fresh datamart files even if cache exists.")
    parser.add_argument("--min-player-games", type=int, default=DEFAULT_MIN_PLAYER_GAMES)
    parser.add_argument("--min-nation-player-games", type=int, default=DEFAULT_MIN_NATION_PLAYER_GAMES)
    parser.add_argument("--min-team-games", type=int, default=DEFAULT_MIN_TEAM_GAMES)
    parser.add_argument("--current-window-days", type=int, default=DEFAULT_CURRENT_WINDOW_DAYS)
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper()), format="%(levelname)s %(name)s: %(message)s")

    raw = load_sources(source_dir=args.source_dir, cache_dir=args.cache_dir, refresh=args.refresh)
    prepared = prepare_data(raw)
    periods = build_periods(prepared, current_window_days=args.current_window_days)

    players = build_player_rankings(prepared, periods=periods, min_games=args.min_player_games)
    nations = build_nation_rankings(prepared, periods=periods, min_player_games=args.min_nation_player_games)
    teams = build_team_rankings(
        prepared,
        periods=periods,
        min_games=args.min_team_games,
    )
    efficiency = build_efficiency_analysis()

    export_site_data(args.output, prepared, periods, players, nations, teams, efficiency)

    print(f"Wrote data to {args.output}")
    print(f"Player records: {len(players):,}")
    print(f"Nation records: {len(nations):,}")
    print(f"Team records: {len(teams):,}")
    print(f"Efficiency records: {len(efficiency):,}")


if __name__ == "__main__":
    main()
