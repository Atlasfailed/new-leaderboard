const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../site/assets/app.js`, "utf8");
const context = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(source, context);
const compare = (key, direction, a, b) => {
  context.key = key;
  context.direction = direction;
  context.a = a;
  context.b = b;
  return vm.runInContext("state.sort = { key, direction }; comparePlayers(a, b)", context);
};

for (const key of ["rank", "name", "country", "score", "starting_score", "year_change", "peak", "games", "wins", "win_rate", "streak", "last_played"]) {
  test(`sort ${key} in both directions`, () => {
    const strings = { name: ["Alice", "Bob"], country: ["BE", "NL"], last_played: ["2025-01-01", "2026-01-01"] };
    const [low, high] = strings[key] || [2, 10];
    const a = { rank: 1, [key]: low };
    const b = { rank: 2, [key]: high };
    assert.ok(compare(key, "ascending", a, b) < 0);
    assert.ok(compare(key, "descending", a, b) > 0);
  });
}

test("W-L descending breaks equal wins by fewer losses", () => {
  assert.ok(compare("wins", "descending", { rank: 2, wins: 5, losses: 1 }, { rank: 1, wins: 5, losses: 3 }) < 0);
});

test("equal values preserve official rank order in both directions", () => {
  for (const direction of ["ascending", "descending"]) {
    assert.ok(compare("score", direction, { rank: 1, score: 1500 }, { rank: 2, score: 1500 }) < 0);
  }
});

test("name comparison ignores case", () => {
  assert.ok(compare("name", "ascending", { rank: 1, name: "alice" }, { rank: 2, name: "Bob" }) < 0);
});

function decayedRows(period, now) {
  context.period = period;
  context.now = Date.parse(now);
  vm.runInContext(`
    state.mode = "Kings";
    state.period = period;
    state.data = {
      scoreDecay: {halfLifeDays: 90, maxGames: {kings: 30, peasants: 50},
        sigmaStart: 350, gamesScale: {kings: 3, peasants: 5}, scoreK: 2},
      rankings: {kings: Object.fromEntries(["all", "2025", "2026"].map(year => [year, [
        {user_id: 1, name: "A", games: 1, rank: 1, score: 1488.9, peak: 1488.9,
         experience: {inherited: 30, games: 1, year: Number(year), rating: 1700}},
        {user_id: 2, name: "B", games: 10, rank: 2, score: 1400, peak: 1400,
         experience: {inherited: 0, games: 10, year: Number(year), rating: 1800}}
      ]]))}
    };
  `, context);
  return JSON.parse(vm.runInContext("JSON.stringify(playerRankings(now))", context));
}

test("All time never decays", () => {
  assert.deepEqual(decayedRows("all", "2026-07-01"), decayedRows("all", "2029-01-01"));
});

test("completed years freeze at year-end", () => {
  assert.deepEqual(decayedRows("2025", "2026-07-01"), decayedRows("2025", "2029-01-01"));
  assert.deepEqual(decayedRows("2026", "2027-01-01"), decayedRows("2026", "2029-01-01"));
});

test("year change tracks live score minus a fixed starting score", () => {
  decayedRows("2026", "2026-01-01");
  vm.runInContext(`state.data.rankings.kings["2026"].forEach(row => row.starting_score = 1400);`, context);
  const rowsAt = date => {
    context.now = Date.parse(date);
    return JSON.parse(vm.runInContext("JSON.stringify(playerRankings(now))", context));
  };
  const early = rowsAt("2026-06-01");
  const late = rowsAt("2026-12-01");
  for (const row of late) {
    assert.equal(row.starting_score, 1400);
    assert.equal(row.year_change, row.score - 1400);
  }
  assert.ok(late.find(r => r.user_id === 1).year_change < early.find(r => r.user_id === 1).year_change);
});

test("yearly columns reconcile displayed cents and disappear in All time", () => {
  const headers = ["starting_score", "year_change"].map(key => ({
    dataset: {sort: key}, hidden: true, setAttribute() {},
  }));
  const tableContext = vm.createContext({document: {
    addEventListener() {}, querySelectorAll() { return headers; },
  }});
  vm.runInContext(source, tableContext);
  vm.runInContext(`
    state.mode = "Kings"; state.period = "2026";
    state.data = {
      scoreDecay: {halfLifeDays: 90, maxGames: {kings: 30}, sigmaStart: 350, gamesScale: {kings: 3}, scoreK: 2},
      rankings: {kings: {"2026": [{
        user_id: 1, name: "Player", country: "AU", games: 30, wins: 20, losses: 10,
        win_rate: 2/3, streak: 1, last_played: "2026-06-01", peak: 1577.6, starting_score: 1542.4,
        experience: {inherited: 0, games: 30, year: 2026, rating: 1788.7}
      }], all: []}}
    };
    el.search = {value: ""}; el.playerRows = {};
    renderPlayers();
  `, tableContext);
  assert.ok(headers.every(h => !h.hidden));
  const html = vm.runInContext("el.playerRows.innerHTML", tableContext);
  const cells = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(m => m[1].replace(/<[^>]+>/g, ""));
  assert.equal(cells.length, 12);
  assert.equal(Math.round((Number(cells[4]) + Number(cells[5])) * 100), Math.round(Number(cells[3]) * 100));
  vm.runInContext(`state.sort = {key: "year_change", direction: "descending"}; state.period = "all"; renderPlayers();`, tableContext);
  assert.ok(headers.every(h => h.hidden));
  assert.equal(vm.runInContext("state.sort.key", tableContext), "rank");
  assert.ok(vm.runInContext("el.playerRows.innerHTML", tableContext).includes('colspan="10"'));
  vm.runInContext(`state.data.rankings.kings["2026"] = []; state.period = "2026"; renderPlayers();`, tableContext);
  assert.ok(vm.runInContext("el.playerRows.innerHTML", tableContext).includes('colspan="12"'));
});

test("current year scores decrease without rebuilding data and ranks update", () => {
  const early = decayedRows("2026", "2026-06-01");
  const late = decayedRows("2026", "2026-12-01");
  assert.ok(late.find(r => r.user_id === 1).score < early.find(r => r.user_id === 1).score);
  assert.equal(late.find(r => r.user_id === 2).score, early.find(r => r.user_id === 2).score);
  assert.ok(late.every((row, i) => row.rank === i + 1 && (!i || late[i - 1].score >= row.score)));
});

test("one half-life halves effective experience exactly", () => {
  const rows = decayedRows("2026", "2026-04-01T00:00:00Z");
  const score = rows.find(r => r.user_id === 1).score;
  const expected = Math.round((1700 - 700 / Math.sqrt(1 + 16 / 3)) * 10) / 10;
  assert.equal(score, expected);
});

test("current-year games retain full weight at year-end", () => {
  const row = decayedRows("2026", "2026-12-31T23:59:59Z").find(r => r.user_id === 2);
  const expected = Math.round((1800 - 700 / Math.sqrt(1 + 10 / 3)) * 10) / 10;
  assert.equal(row.score, expected);
});

test("display scale starts at 16.67 and divides score movements by 42", () => {
  assert.equal(vm.runInContext("formatScore(800)", context), "16.67");
  assert.equal(vm.runInContext("formatScore(842)", context), "17.67");
  assert.equal(vm.runInContext("formatScore(758)", context), "15.67");
  assert.equal(vm.runInContext("displayScore(842) - displayScore(800)", context), 1);
});

test("rescaling preserves order across every cached role and period without mutating scores", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  context.cachedData = data;
  const original = JSON.stringify(data);
  vm.runInContext(`
    for (const periods of Object.values(cachedData.rankings)) {
      for (const rows of Object.values(periods)) {
        const rawOrder = [...rows].sort((a, b) => b.score - a.score || a.rank - b.rank);
        const scaledOrder = [...rows].sort((a, b) => displayScore(b.score) - displayScore(a.score) || a.rank - b.rank);
        if (rawOrder.some((row, i) => row.user_id !== scaledOrder[i].user_id)) {
          throw new Error("Rescaling changed ranking order");
        }
      }
    }
  `, context);
  assert.equal(JSON.stringify(data), original);
});

test("table rescales Score and Peak but sorting retains raw-score precision", () => {
  const tableContext = vm.createContext({
    document: { addEventListener() {}, querySelectorAll() { return []; } },
  });
  vm.runInContext(source, tableContext);
  vm.runInContext(`
    state.mode = "Kings";
    state.period = "all";
    state.sort = { key: "score", direction: "descending" };
    const row = {name: "Player", country: "BE", games: 1, wins: 1, losses: 0,
      win_rate: 1, streak: 1, last_played: "2026-06-01", peak: 884};
    state.data = { rankings: { kings: { all: [
      {...row, user_id: 1, rank: 1, score: 800.1},
      {...row, user_id: 2, rank: 2, score: 800}
    ] } } };
    el.search = {value: ""};
    el.playerRows = {};
    renderPlayers();
  `, tableContext);
  const html = vm.runInContext("el.playerRows.innerHTML", tableContext);
  assert.ok(html.indexOf('data-user="1"') < html.indexOf('data-user="2"'));
  assert.equal((html.match(/<strong>16.67<\/strong>/g) || []).length, 2);
  assert.ok(html.includes("<td>18.67</td>"));
  assert.ok(vm.runInContext("comparePlayers({score: 800.1, rank: 2}, {score: 800, rank: 1})", tableContext) < 0);
});

for (const period of ["all", "2026"]) {
  test(`player history and chart use scaled scores and changes for ${period}`, () => {
    const historyContext = vm.createContext({ document: { addEventListener() {} } });
    vm.runInContext(source, historyContext);
    historyContext.period = period;
    vm.runInContext(`
      state.period = period;
      state.player = {id: 1, name: "Player"};
      state.data = {games: [
        {id: "new", start_time: "2026-06-02", map: "Test", winner: "peasants",
         kings: [[1, "Player", 842, -42, 884, -84, -21]], peasants: []},
        {id: "old", start_time: "2026-06-01", map: "Test", winner: "kings",
         kings: [[1, "Player", 884, 84, 968, 168, 42]], peasants: []}
      ]};
      el.playerGamesTitle = {};
      el.playerGameRows = {};
      el.playerChart = {};
      renderPlayerGames();
    `, historyContext);
    const html = vm.runInContext("el.playerGameRows.innerHTML", historyContext);
    const chart = vm.runInContext("el.playerChart.innerHTML", historyContext);
    const [score, loss, win] = period === "all" ? ["17.67", "-1.00", "+2.00"] : ["18.67", "-2.00", "+4.00"];
    assert.ok(html.includes(`<td>${score}</td>`));
    assert.ok(html.includes(`class="delta-down">${loss}`));
    assert.ok(html.includes(`class="delta-up">${win}`));
    assert.ok(html.includes('class="delta-down">-0.50'));
    assert.ok(html.includes('class="delta-up">+1.00'));
    assert.ok(chart.includes(`: ${score}</title>`));
    assert.ok(!chart.includes("NaN"));
  });
}

test("a winning match shows gains relative to its already-decayed pre-game Score", () => {
  vm.runInContext(`
    state.period = "2026";
    state.player = {id: 1, name: "Player"};
    state.playerRole = "Kings";
    state.data = {games: [{
      id: "win", start_time: "2026-04-05", map: "Test", winner: "kings",
      kings: [[1, "Player", 1500, 9.9, 1400, 14.7, 9.9]], peasants: []
    }]};
    el.playerGamesTitle = {};
    el.playerGameRows = {};
    el.playerChart = {};
    renderPlayerGames();
  `, context);
  const html = vm.runInContext("el.playerGameRows.innerHTML", context);
  assert.ok(html.includes("<td>Win</td>"));
  assert.ok(html.includes('class="delta-up">+0.24'));
  assert.ok(html.includes('class="delta-up">+0.11'));
  assert.ok(html.includes('class="delta-up">+0.35'));
  assert.ok(!html.includes("delta-down"));
  assert.equal((html.match(/<td[ >]/g) || []).length, 9);
});

test("displayed change components reconcile at rounding boundaries without negative zero", () => {
  for (const [net, match] of [[-9.2, 9.9], [0, -0.1], [1, 1], [-1, -1], [84, 42]]) {
    context.net = net;
    context.match = match;
    const cells = vm.runInContext(`(() => {
      const total = Math.round(net / SCORE_SCALE * 100);
      const rating = Math.round(match / SCORE_SCALE * 100);
      return [changeCell(rating), changeCell(total - rating), changeCell(total)];
    })()`, context);
    const values = Array.from(cells, cell => Number(cell.match(/>([^<]+)</)[1]));
    assert.equal(Math.round((values[0] + values[1]) * 100), Math.round(values[2] * 100));
    assert.ok(cells.every(cell => !cell.includes("NaN") && !cell.includes(">-0.00")));
  }
});

test("empty player history spans all nine columns", () => {
  vm.runInContext("state.data = {games: []}; renderPlayerGames();", context);
  assert.ok(vm.runInContext("el.playerGameRows.innerHTML", context).includes('colspan="9"'));
});

test("browser scoring settles at thirty effective games using the published policy", () => {
  decayedRows("2026", "2026-01-01");
  const scores = vm.runInContext(`
    state.data.rankings.kings["2026"] = [29, 30, 31, 50].map(games => ({
      user_id: games, name: String(games), games, experience: {inherited: 0, games, year: 2026, rating: 1500}
    }));
    playerRankings(Date.parse("2026-06-01"));
  `, context);
  const score = games => scores.find(row => row.user_id === games).score;
  assert.ok(score(29) < score(30));
  assert.equal(score(30), score(31));
  assert.equal(score(30), score(50));
  assert.equal(score(30), Math.round((1500 - 700 / Math.sqrt(11)) * 10) / 10);
});

test("Peasants keep gaining participation beyond thirty and settle at fifty", () => {
  decayedRows("2026", "2026-01-01");
  const rows = vm.runInContext(`
    state.mode = "Peasants";
    state.data.rankings.peasants = {"2026": [29, 30, 31, 49, 50, 51].map(games => ({
      user_id: games, name: String(games), games,
      experience: {inherited: 0, games, year: 2026, rating: 1500}
    }))};
    playerRankings(Date.parse("2026-06-01"));
  `, context);
  for (const row of rows) {
    assert.equal(row.score, Math.round((1500 - 700 / Math.sqrt(1 + Math.min(row.games, 50) / 5)) * 10) / 10);
  }
  const score = games => rows.find(row => row.user_id === games).score;
  assert.ok(score(30) < score(31));
  assert.ok(score(49) < score(50));
  assert.equal(score(50), score(51));
});

test("browser scores match rebuilt pipeline scores for both roles and every year", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  context.rebuiltData = data;
  const comparisons = vm.runInContext(`(() => {
    state.data = rebuiltData;
    const comparisons = [];
    for (const role of ["kings", "peasants"]) {
      state.mode = role === "kings" ? "Kings" : "Peasants";
      for (const period of state.data.periods.filter(p => p.id !== "all")) {
        state.period = period.id;
        const actual = playerRankings(Date.parse(state.data.generatedAt));
        for (const row of state.data.rankings[role][period.id]) {
          comparisons.push([actual.find(r => r.user_id === row.user_id).score, row.score]);
        }
      }
    }
    return comparisons;
  })()`, context);
  assert.ok(comparisons.length > 0);
  for (const [actual, expected] of comparisons) {
    assert.equal(actual, expected);
  }
});

test("local-only recordings never advertise missing server replay links", () => {
  const local = {id: "local", source: {type: "local", api_available: false}};
  context.game = local;
  assert.equal(vm.runInContext("replayLink(game)", context), "");
  context.game = {id: "api"};
  assert.ok(vm.runInContext("replayLink(game)", context).includes("https://www.bar-rts.com/replays/api"));
  context.game = {...local, source: {...local.source, api_available: true}};
  assert.ok(vm.runInContext("replayLink(game)", context).includes(">Watch</a>"));
});

test("Games and player histories leave missing replay cells empty", () => {
  const localContext = vm.createContext({document: {addEventListener() {}}});
  vm.runInContext(source, localContext);
  vm.runInContext(`
    state.period = "all";
    state.player = {id: 1, name: "Player"};
    state.data = {games: [{
      id: "local", start_time: "2026-11-01", map: "Test", winner: "kings",
      kings: [[1, "Player", 842, 42, 842, 42, 21]], peasants: [],
      duration_ms: 700000, kings_handicap: 50, kings_expected: 0.5,
      source: {type: "local", api_available: false}
    }]};
    el.search = {value: ""};
    el.gameRows = {};
    el.playerGamesTitle = {};
    el.playerGameRows = {};
    el.playerChart = {};
    renderGames();
    renderPlayerGames();
  `, localContext);
  for (const expression of ["el.gameRows.innerHTML", "el.playerGameRows.innerHTML"]) {
    const html = vm.runInContext(expression, localContext);
    assert.ok(/<td><\/td>\s*<\/tr>/.test(html));
    assert.ok(!html.includes("Local recording"));
    assert.ok(!html.includes("/replays/local"));
  }
});

function dayGame(id, start, duration = 20, extra = {}) {
  return {
    id, start_time: start, duration_ms: duration * 60000, map: "Test map",
    winner: "kings", kings: [[1, "Alice"]], peasants: [[2, "Bob"]], ...extra,
  };
}

function daySessions(games, period = "all", query = "") {
  context.dayGames = games;
  context.dayPeriod = period;
  context.dayQuery = query;
  return JSON.parse(vm.runInContext("JSON.stringify(gameDaySessions(dayGames, dayPeriod, dayQuery))", context));
}

test("Game days use Sydney seasonal time and group after midnight with the previous evening", () => {
  const rows = daySessions([
    dayGame("summer", "2026-01-04T10:00:00Z"),
    dayGame("winter", "2026-07-05T11:00:00Z"),
    dayGame("after-midnight", "2026-01-04T13:15:00Z"),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].day, "2026-07-05");
  assert.equal(rows[0].startMinute, 1260);
  assert.equal(rows[1].startMinute, 1260);
  assert.equal(rows[1].games[1].startMinute, 1455);
  assert.equal(vm.runInContext("gameDayClock(1455)", context), "00:15 (+1d)");
});

test("Game days year filtering uses the Sydney session year, not the UTC year", () => {
  const games = [
    dayGame("jan", "2025-12-31T14:00:00Z"),
    dayGame("new-evening", "2026-01-01T10:00:00Z"),
  ];
  assert.deepEqual(daySessions(games, "2025").map(s => s.day), ["2025-12-31"]);
  assert.deepEqual(daySessions(games, "2026").map(s => s.day), ["2026-01-01"]);
});

test("Game days shade breaks at exactly 45 minutes but not ordinary turnaround", () => {
  const session = daySessions([
    dayGame("one", "2026-01-04T10:00:00Z"),
    dayGame("two", "2026-01-04T10:30:00Z"),
    dayGame("three", "2026-01-04T11:35:00Z"),
  ])[0];
  assert.equal(session.breaks.length, 1);
  assert.equal(session.breaks[0].endMinute - session.breaks[0].startMinute, 45);
});

test("Game days merge overlapping occupied intervals before calculating breaks", () => {
  const session = daySessions([
    dayGame("long", "2026-01-04T10:00:00Z", 120),
    dayGame("short-overlap", "2026-01-04T10:10:00Z", 20),
    dayGame("next", "2026-01-04T12:15:00Z", 20),
  ])[0];
  assert.equal(session.breaks.length, 0);
});

test("Game days search by date, map or player retains every game of the matching session", () => {
  const games = [
    dayGame("one", "2026-01-04T10:00:00Z", 20, {map: "Throne"}),
    dayGame("two", "2026-01-04T11:00:00Z", 20, {map: "Claymore", kings: [[3, "Twig"]]}),
    dayGame("other", "2026-01-11T10:00:00Z"),
  ];
  for (const query of ["2026-01-04", "THRONE", "twig"]) {
    const sessions = daySessions(games, "all", query);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].games.length, 2);
  }
  assert.equal(daySessions(games, "all", "not present").length, 0);
});

test("Game days include every published game exactly once without mutating the source", () => {
  const games = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8")).games;
  const before = JSON.stringify(games);
  const sessions = daySessions(games);
  assert.equal(sessions.reduce((sum, s) => sum + s.games.length, 0), games.length);
  assert.equal(new Set(sessions.flatMap(s => s.games.map(g => g.id))).size, games.length);
  assert.equal(JSON.stringify(games), before);
});

test("Game days rendering escapes map names, respects local-only replays, and handles empty results", () => {
  context.dayGames = [
    dayGame("api", "2026-01-04T10:00:00Z", 20, {map: "<b>Map</b>"}),
    dayGame("local", "2026-01-04T10:50:00Z", 20,
      {winner: "peasants", source: {type: "local", api_available: false}}),
  ];
  vm.runInContext(`
    state.data = {games: dayGames}; state.period = "all";
    el.search = {value: ""}; el.gameDayRows = {};
    renderGameDays();
  `, context);
  const html = vm.runInContext("el.gameDayRows.innerHTML", context);
  assert.ok(html.includes("&lt;b&gt;Map&lt;/b&gt;"));
  assert.ok(!html.includes("<b>Map</b>"));
  assert.ok(html.includes("/replays/api"));
  assert.ok(!html.includes("/replays/local"));
  assert.ok(html.includes("day-game-kings"));
  assert.ok(html.includes("day-game-peasants"));
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(html.includes("<summary>Game details</summary>"));
  assert.ok(!html.includes('class="day-break"'));
  vm.runInContext('el.search.value = "not present"; renderGameDays();', context);
  assert.ok(vm.runInContext("el.gameDayRows.innerHTML", context).includes("No results"));
});
