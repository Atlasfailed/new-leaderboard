# AllReasonNoLogic Leaderboard

A Cloudflare Pages site for the AllReasonNoLogic community, with channel links and embeds for the latest YouTube uploads and Twitch channel, as well as Sunday King of the Hill leaderboards for Beyond All Reason. The KOTH views are Kings, Peasants, Maps (win rate per map, setup scatter and win rate by team-size ratio) and Games (every game with a Kings win chance and replay link).

Game days shows the published leaderboard games as daily timelines in
Australia/Sydney time (AEST/AEDT), newest first, with Kings/Peasants win colours.
Sessions run noon-to-noon so after-midnight games remain with the preceding
evening (`+1d`). The year selector uses the session date; date, map and player
searches retain the complete matching day. Only breaks of at least 45 minutes
are shaded, neutrally as breaks rather than evidence of missing games; shorter
intervals are left blank. Ends are estimated from start plus recorded duration,
not verified wall-clock finish times. Short/rejected games outside the published
leaderboard are not added. Expand each day's details for start times, maps,
teams, results and available replay links. This view uses the existing live
rankings data, not a manually embedded analysis snapshot.

The YouTube embed uses the channel's uploads playlist, which lists the newest upload first. The Twitch player loads the channel and uses the current site hostname as its required `parent` parameter; streams appear in the player when the channel is live.

## How games are found

- Every Sunday since 2024-09-01 is scanned through `https://api.bar-rts.com/replays?date=YYYY-MM-DD`.
- A replay counts when it has two teams, no bots, an API game duration strictly longer than 10 minutes (`durationMs > 600000`), one winner, exactly one team with a handicap bonus (the Kings, not the larger team), and an organizer as player or spectator. Exactly 10:00 is excluded. The duration rule applies to new scans and cache-only rebuilds, before fitting models or calculating ratings and statistics; shorter cached records are preserved but not rated.
- Only compact per-game data is kept in `pipeline/reference/custom_games.json` (map, length, winner, bonus, players with country and OpenSkill). Rejected replay ids are kept too, so nothing is downloaded twice. Each run re-scans the last 14 days.

## Ratings

- Yearly Kings and Peasants tables include only players active in that year.
  Games, W-L, win rate, streak and Peak Score describe the selected year.
  Elo carries forward unchanged. Yearly Scores use recent effective role
  experience: games in the selected year keep full weight throughout that year.
  Only experience inherited on 1 January halves every 90 days:
  `E = min(role_cap, games_this_year + inherited * 2^(-days_since_Jan_1 / 90))`,
  with a cap of 30 for Kings and 50 for Peasants.
  The capped effective count at year-end becomes next year's inherited
  experience; skipped years continue to discount the inherited count.
  Completed years freeze the deduction at 31 December 23:59:59 UTC; the
  current year's Scores and ranks keep decaying in the browser (refreshed
  every minute), even without a data rebuild. All time uses cumulative
  role games with no decay.
  Yearly tables also show Starting Score (rating and inherited experience on
  1 January; 16.67 for a new player) and This Year's Change (current Score minus
  Starting Score). The change includes participation gains and inherited-experience
  decay as well as match results, so it is not the sum of game changes.
  These display-only columns are hidden in All time; ratings are unchanged.
  Yearly Peak Score and player history use decayed experience at each game;
  the table can be lower than the last game Score as inherited experience
  continues to decay. Current-year games never lose weight within that year.
  The latest available year (currently 2026) is selected by default.
  Every player-table column can be sorted in either direction using its header;
  W-L sorts by wins, with fewer losses first when sorting descending.
- Elo, start 1500, one rating per role. K is 48 for a player's first 8 games in a role, then 24. Everyone on a team gets the same change.
- Rank is by Score = Elo - 2 x sigma, where sigma = 350 / sqrt(1 + min(experience, role_cap) / role_scale).
  Kings use cap 30 and scale 3; Peasants retain cap 50 and scale 5.
  Experience means cumulative role games for All time and the decaying effective
  count for year views. This is a participation heuristic, not calibrated statistical uncertainty.
  The Kings curve is compressed from the former 50-game cap and scale of 5:
  the initial deduction (16.67 displayed points) and minimum deduction
  (about 5.03) are unchanged, but the minimum is reached at 30 effective
  King games or 50 effective Peasant games. It does not taper to zero. Historical Scores, peaks and ranks
  are rebuilt under this policy; Elo and match-rating changes are unchanged.
- Player history separates **Match Rating Change** (the underlying Elo change),
  **Participation Gain** (deduction recovery from playing this game), and
  **Game Score Change** (their sum, relative to the already-decayed Score
  immediately before this game). Time-based decay is applied before the game,
  not charged to it. Yearly table Scores continue to decay between games.
  Wins gain match rating and losses lose it, even when the net Score moves
  the other way for losses during early participation recovery. Participation
  gains reconcile the two displayed changes
  after rounding to two decimals. The chart continues to show post-game Score.
  Game roster arrays store `[id, name, all_time_score, all_time_net_change,
  yearly_score, yearly_game_change, match_rating_change]` on the internal scale.
  `scoreDecay.maxGames` and `scoreDecay.gamesScale` are keyed by role so the
  browser uses the same policy as the pipeline.
  Historical chart points remain post-game Scores, so the gap between two
  points can include time-based decay and need not equal Game Score Change.
- The website displays Score and Peak Score on a BAR-like scale:
  `displayed_score = 50/3 + (Score - 800) / 42`, shown to two decimal places.
  The starting Score of 800 displays as 16.67; game changes are divided by 42
  without adding the starting offset. Tables, histories and charts all use
  this display scale. The display conversion itself does not change stored
  scores, ranking order, sorting, Elo updates or experience decay, including
  tie-breaks before display rounding.
  This is a cosmetic rescaling, not official BAR OpenSkill or a calibration
  of per-game changes against BAR.
- The expected result starts from a logistic fit on bonus and team-size ratio, shifted by the difference of the team average ratings.
- The Kings win chance on the Games view is a separate logistic fit on bonus, team-size ratio and the mean OpenSkill gap. Its walk-forward backtest accuracy (about 66%) is written to `model.backtest` and shown on the Games view.

## Automatic updates

`.github/workflows/koth-update-and-deploy.yml` (in the repo root) is scheduled every Sunday every 20 minutes from 11:00 through 16:00 inclusive in `Europe/Brussels` (CET in winter, CEST in summer), on every push to `main` affecting KOTH files or the workflow, and manually. GitHub Actions scheduled runs can be delayed or dropped during busy periods; the interval is not guaranteed. It scans for new games, rebuilds `site/data/rankings.json`, commits the replay cache if it changed, and deploys to Cloudflare Pages.

Scheduled checks deploy to Cloudflare only when cached game records change.
New rejected replay IDs or scan metadata alone do not trigger a deployment.
Pushes and manual runs still deploy even when game data is unchanged, so
website changes and deliberate redeployments are always published.

One-time setup:

1. Create a GitHub repository and push this folder to `main`.
2. Repository settings, Actions, General, Workflow permissions: read and write (the workflow commits the cache). If `main` is protected, allow the bot to push or the cache commit step will fail.
3. Add repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare Pages edit permission) and `CLOUDFLARE_ACCOUNT_ID`.
4. Create the Pages project once (Workers & Pages, Create, Pages, Direct Upload, name it `allreasonnologic-koth`), or run `npx wrangler pages project create allreasonnologic-koth --production-branch=main`. The site will be at `https://allreasonnologic-koth.pages.dev`. The name is set in the `--project-name` flag of the workflow.

## Local use

```bash
python -m pip install -r requirements.txt
npm run scan   # scan for new games and rebuild site/data/rankings.json
npm run data   # rebuild from the cache only
npm run dev    # http://localhost:4174
```

### Checking player-submitted local replays

Local `.sdfz` recordings can supply the same compact game data as the replay API.
Use the read-only inspector from this directory:

```bash
npm ci
npm run inspect-replay -- "local replays/game.sdfz"
npm run inspect-replay -- "local replays/game.sdfz" --compare-api
```

The inspector uses [BAR's demo-parser](https://github.com/beyond-all-reason/demo-parser),
then the existing KOTH classifier. It prints the game ID, compact game record,
local cache status, and (with `--compare-api`) differing compact field names.
An empty `api_differences` list means an exact match, including player order,
account IDs, names, countries and OpenSkill. API comparison requires the game
to exist on the API; omit that flag for missing games. Differences cause a
nonzero exit status. Neither command changes the cache or rankings.

The supplied `2026-11-01_13-45-40-027_Raptor_Crater_V2_2026.07.04.sdfz`
was verified against API game `8442e76abab6d5932806d2405379b7ae`: all seven
compact fields matched exactly (9 Kings, 83 Peasants, 55% Kings bonus,
Peasants win, 1,965,600 ms). The checked-in cache at verification only reached
2026-10-25, so it did not yet contain this game.

Ask players for an unmodified recording kept through the end of the game.
The inspector requires game-start and game-over packets and unique BAR account
IDs for all players; incomplete recordings are not assigned an inferred result.
It reads both `STARTPLAYING` and `GAMEOVER`: filtering to only `GAMEOVER`
produces zero duration in parser 5.15.1, while header-only parsing uses a
different wall-clock duration (2,282,000 ms in the sample).

### Importing validated local replays

Inspection remains read-only by default. To explicitly import one or more files:

```bash
npm run inspect-replay -- --import "local replays/game-one.sdfz" "local replays/game-two.sdfz"
npm run data
```

Imports require complete start/game-over packets, one winner, valid unique
account IDs, and the same KOTH eligibility rules (including duration strictly
over 10 minutes). Each ID is checked against the live replay API. A 404 allows
a local-only import; other HTTP failures stop the import. Existing API records
must match the local compact record exactly. Existing cache IDs are not duplicated
or overwritten if they disagree. Previously rejected IDs require an explicit
`--allow-rejected` after review.

The entire file batch is validated before saving. Imports preserve scan metadata
and store the source filename, SHA-256 hash and API availability inside the game
record. API-missing games leave the Replay cell empty in both Games and player
histories rather than showing a broken Watch link. Reimporting a matching local game after it
appears on the API enables its Watch link. Rebuilds and automatic cache refreshes
retain imported records; the recordings themselves are not published.

This validates recording structure, not authenticity or the fairness of a result.
Player-controlled or disputed submissions still need independent review.
