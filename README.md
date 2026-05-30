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
- `player_rankings_current.json` and `player_rankings_<year>.json`
- `nation_rankings_current.json` and `nation_rankings_<year>.json`
- `team_rankings_current.json` and `team_rankings_<year>.json`
- `efficiency_analysis.json`

The generated JSON files are intentionally ignored by Git; Actions regenerates them before every deployment.

The pipeline uses the BAR datamarts only. Nation and team rankings are rating/activity based so they do not depend on replay JSON or winner fields.

Ranking pages default to `Current`, which is generated from players with games in the last 30 days of the newest datamart timestamp. Year options are generated from UTC calendar years and include players who played during that year.
