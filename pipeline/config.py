from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DIR = Path(__file__).resolve().parent / "reference"

DATAMART_URLS = {
    "matches": "https://data-marts.beyondallreason.dev/matches.parquet",
    "match_players": "https://data-marts.beyondallreason.dev/match_players.parquet",
    "players": "https://data-marts.beyondallreason.dev/players.parquet",
}

ISO_COUNTRY_PATH = REFERENCE_DIR / "iso_country.csv"
ENERGY_EFFICIENCY_PATH = REFERENCE_DIR / "energy_efficiency.csv"

GAME_MODES = ["Large Team", "Small Team", "Duel", "FFA"]
TEAM_MODES = {"Large Team", "Small Team"}

DEFAULT_CURRENT_WINDOW_DAYS = 30
DEFAULT_MIN_PLAYER_GAMES = 1
DEFAULT_MIN_NATION_PLAYER_GAMES = 1
DEFAULT_MIN_TEAM_GAMES = 8
DEFAULT_TEAM_WINDOW_DAYS = 90
