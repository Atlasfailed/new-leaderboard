# BAR Leaderboard Clean

Static Cloudflare Pages build for BAR rankings. The project has no Flask server: GitHub Actions downloads the BAR datamarts, builds frontend-ready JSON, and deploys `site/` to Cloudflare Pages.

## Structure

- `pipeline/` - modular Python data download, cleaning, ranking, and JSON export.
- `pipeline/reference/` - small static reference files used by the pipeline.
- `site/` - static HTML/CSS/JS frontend.
- `.github/workflows/update-and-deploy.yml` - Tuesday/Saturday data refresh and Cloudflare Pages deploy.

## Local Data Build

Use the current parent repo data:

```bash
npm run data:local
```

Download fresh datamarts:

```bash
python3 -m pipeline.run --output site/data --refresh
```

Preview locally:

```bash
npm run dev
```

Open `http://localhost:4173`.

## GitHub and Cloudflare

This folder is intended to be its own repository under `roark2120`.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare Pages project name in the workflow is `bar-leaderboard`. Change the `--project-name` value if the Cloudflare project uses a different name.

The workflow runs at 10:35 UTC every Tuesday and Saturday, on every push to `main`, and manually through `workflow_dispatch`.

## Data Outputs

- `metadata.json`
- `countries.json`
- `player_rankings_current.json`, `nation_rankings_current.json`, and `team_rankings_current.json`
- `player_rankings_<active-year>.json`, `nation_rankings_<active-year>.json`, and `team_rankings_<active-year>.json`
- `completed/completed_<finished-year>.json` for finished calendar years
- `efficiency_analysis.json`

The generated JSON files are intentionally ignored by Git; Actions regenerates them before every deployment.

The pipeline uses the BAR datamarts only. Nation rankings are rating/depth based, and team rankings are based on roster rating, opponent difficulty, and win rate.

Ranking pages default to `Current`, which is generated from players with games in the last 30 days of the newest datamart timestamp. Year options are generated from UTC calendar years and include players who played during that year.

Finished years are archived as completed JSON files and are not rebuilt by default. Use `--rebuild-completed-years` only when intentionally regenerating historical archives.
When a new calendar year starts, run the pipeline once and commit the newly created `completed/completed_<previous-year>.json` archive.
Team rankings use exact datamart party rosters and are generated separately by roster size. The default sizes are Duo, Triple, and Quad; pass `--team-roster-sizes 2,3,4,5` to build additional sizes.
