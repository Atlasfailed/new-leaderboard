function validateRankings(data) {
  const valid = (condition, message) => {
    if (!condition) {
      throw new Error(`Invalid rankings: ${message}`);
    }
  };
  valid(data && typeof data === "object", "expected an object");
  valid(data.schemaVersion === undefined || data.schemaVersion === 1, "unsupported schema version");
  valid(typeof data.generatedAt === "string" && Number.isFinite(Date.parse(data.generatedAt)), "publication date");
  valid(Array.isArray(data.periods) && data.periods.length > 0, "periods");
  valid(data.periods.every(p => p && typeof p.id === "string" && typeof p.label === "string"
    && (p.id === "all" || /^\d{4}$/.test(p.id))), "period labels");
  const periods = data.periods.map(p => p.id);
  valid(periods.includes("all") && new Set(periods).size === periods.length, "unique periods including all");
  valid(data.mapRankings && typeof data.mapRankings === "object" && !Array.isArray(data.mapRankings), "map rankings");
  valid(Number.isFinite(data.model?.backtest?.accuracy), "win model");
  for (const scope of [data, ...Object.values(data.mapRankings)]) {
    valid(scope && typeof scope === "object", "rating scope");
    const decay = scope.scoreDecay;
    valid(decay && [decay.halfLifeDays, decay.sigmaStart, decay.scoreK]
      .every(value => Number.isFinite(value) && value > 0), "score decay");
    valid(Array.isArray(scope.games), "games");
    for (const game of scope.games) {
      valid(game && typeof game.id === "string" && typeof game.map === "string"
        && Number.isFinite(Date.parse(game.start_time))
        && ["kings", "peasants"].includes(game.winner)
        && [game.duration_ms, game.kings_handicap, game.kings_expected].every(Number.isFinite), "game record");
      for (const role of ["kings", "peasants"]) {
        valid(Array.isArray(game[role]) && game[role].length > 0
          && game[role].every(player => Array.isArray(player) && player.length >= 7
            && Number.isFinite(player[0]) && typeof player[1] === "string"
            && player.slice(2, 7).every(Number.isFinite)), "game roster");
      }
    }
    for (const role of ["kings", "peasants"]) {
      valid([decay.maxGames?.[role], decay.gamesScale?.[role]]
        .every(value => Number.isFinite(value) && value > 0), "role decay");
      for (const period of periods) {
        valid(Number.isFinite(scope.summary?.[period]?.games), "period summary");
        const rows = scope.rankings?.[role]?.[period];
        valid(Array.isArray(rows), `${role} ${period} table`);
        for (const row of rows) {
          valid(row && typeof row.name === "string"
            && ["user_id", "rank", "score", "peak", "games", "wins", "losses", "win_rate", "streak"]
              .every(key => Number.isFinite(row[key]))
            && Number.isFinite(Date.parse(row.last_played)), "player record");
          if (period !== "all") {
            valid(Number.isFinite(row.starting_score) && row.experience
              && ["inherited", "games", "year", "rating"]
                .every(key => Number.isFinite(row.experience[key])), "yearly experience");
          }
        }
      }
    }
  }
  return data;
}

function createRankingsLoader() {
  let saved = null;
  let etag = null;
  return async (signal) => {
    if (saved && etag) {
      const metadata = await fetch("data/rankings.json", { method: "HEAD", cache: "no-store", signal });
      if (metadata.status === 304) {
        return saved;
      }
      if (!metadata.ok) {
        throw new Error(`HTTP ${metadata.status}`);
      }
      if (metadata.headers.get("ETag") === etag) {
        return saved;
      }
    }
    // Let the browser revalidate its HTTP cache without cross-origin custom headers.
    const response = await fetch("data/rankings.json", { cache: "no-cache", signal });
    if (response.status === 304 && saved) {
      return saved;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const incomingEtag = response.headers.get("ETag");
    if (saved && incomingEtag && incomingEtag === etag) {
      await response.arrayBuffer();
      return saved;
    }
    const incoming = validateRankings(await response.json());
    if (saved && Date.parse(incoming.generatedAt) < Date.parse(saved.generatedAt)) {
      throw new Error("Received rankings older than the displayed publication.");
    }
    saved = incoming;
    etag = incomingEtag;
    return saved;
  };
}

if (typeof module !== "undefined") {
  module.exports = { validateRankings, createRankingsLoader };
}
