# AllReasonNoLogic Leaderboard

A Cloudflare Pages site for the AllReasonNoLogic community, with channel links and embeds for the latest YouTube uploads and Twitch channel, as well as Sunday King of the Hill leaderboards for Beyond All Reason. The KOTH views are Kings, Peasants, Maps (win rate per map, setup scatter and win rate by team-size ratio) and Games (every game with a Kings win chance and replay link).

The YouTube embed uses the channel's uploads playlist, which lists the newest upload first. The Twitch player loads the channel and uses the current site hostname as its required `parent` parameter; streams appear in the player when the channel is live.

## How games are found

- Every Sunday since 2024-09-01 is scanned through `https://api.bar-rts.com/replays?date=YYYY-MM-DD`.
- A replay counts when it has two teams, no bots, a 5+ minute game with one winner, exactly one team with a handicap bonus (the Kings, not the larger team), and an organizer as player or spectator.
- Only compact per-game data is kept in `pipeline/reference/custom_games.json` (map, length, winner, bonus, players with country and OpenSkill). Rejected replay ids are kept too, so nothing is downloaded twice. Each run re-scans the last 14 days.

## Ratings

- Yearly Kings and Peasants tables include only players active in that year.
  Games, W-L, win rate, streak and Peak Score describe the selected year.
  Elo carries forward unchanged. Yearly Scores use recent effective role
  experience: games in the selected year keep full weight throughout that year.
  Only experience inherited on 1 January halves every 90 days:
  `E = min(50, games_this_year + inherited * 2^(-days_since_Jan_1 / 90))`.
  The capped effective count at year-end becomes next year's inherited
  experience; skipped years continue to discount the inherited count.
  Completed years freeze the deduction at 31 December 23:59:59 UTC; the
  current year's Scores and ranks keep decaying in the browser (refreshed
  every minute), even without a data rebuild. All time uses cumulative
  role games with no decay and retains its original Scores and history.
  Yearly Peak Score and player history use decayed experience at each game;
  the table can be lower than the last game Score as inherited experience
  continues to decay. Current-year games never lose weight within that year.
  The latest available year (currently 2026) is selected by default.
  Every player-table column can be sorted in either direction using its header;
  W-L sorts by wins, with fewer losses first when sorting descending.
- Elo, start 1500, one rating per role. K is 48 for a player's first 8 games in a role, then 24. Everyone on a team gets the same change.
- Rank is by Score = Elo - 2 x sigma, where sigma = 350 / sqrt(1 + min(experience, 50) / 5). Experience means cumulative role games for All time and the decaying effective count for year views. This is a participation heuristic, not calibrated statistical uncertainty.
- The website displays Score and Peak Score on a BAR-like scale:
  `displayed_score = 50/3 + (Score - 800) / 42`, shown to two decimal places.
  The starting Score of 800 displays as 16.67; game changes are divided by 42
  without adding the starting offset. Tables, histories and charts all use
  this display scale. Stored scores, ranking order, sorting, Elo updates and
  experience decay are unchanged, including tie-breaks before display rounding.
  This is a cosmetic rescaling, not official BAR OpenSkill or a calibration
  of per-game changes against BAR.
- The expected result starts from a logistic fit on bonus and team-size ratio, shifted by the difference of the team average ratings.
- The Kings win chance on the Games view is a separate logistic fit on bonus, team-size ratio and the mean OpenSkill gap. Its walk-forward backtest accuracy (about 66%) is written to `model.backtest` and shown on the Games view.

## Automatic updates

`.github/workflows/koth-update-and-deploy.yml` (in the repo root) runs every Monday 05:00 UTC, on every push to `main` and manually. It scans for new games, rebuilds `site/data/rankings.json`, commits the replay cache if it changed, and deploys to Cloudflare Pages.

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
