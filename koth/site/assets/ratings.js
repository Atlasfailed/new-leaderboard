const SCORE_SCALE = 42;

function displayScore(score) {
  return 50 / 3 + (score - 800) / SCORE_SCALE;
}

function formatScore(score) {
  return displayScore(score).toFixed(2);
}

function rankedPlayers(scope, role, period, now = Date.now()) {
  const rows = scope.rankings[role][period] || [];
  if (period === "all") {
    return rows;
  }
  const cutoff = Math.min(now, Date.parse(`${period}-12-31T23:59:59Z`));
  const { halfLifeDays, maxGames, sigmaStart, gamesScale, scoreK } = scope.scoreDecay;
  return rows.map((row) => {
    const { inherited, games, year, rating } = row.experience;
    const days = Math.max(0, (cutoff - Date.parse(`${year}-01-01T00:00:00Z`)) / 86400000);
    const effective = games + inherited * 2 ** (-days / halfLifeDays);
    const score = rating - scoreK * sigmaStart / Math.sqrt(1 + Math.min(effective, maxGames[role]) / gamesScale[role]);
    const roundedScore = Math.round(score * 10) / 10;
    return { ...row, score: roundedScore, year_change: roundedScore - row.starting_score };
  }).sort((a, b) => b.score - a.score || b.games - a.games
      || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}
