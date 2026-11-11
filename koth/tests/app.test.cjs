const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = ["ratings.js", "app.js"]
  .map(file => readFileSync(`${__dirname}/../site/assets/${file}`, "utf8")).join("\n");
const context = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(source, context);
const compare = (key, direction, a, b) => {
  context.key = key;
  context.direction = direction;
  context.a = a;
  context.b = b;
  return vm.runInContext("state.sort = { key, direction }; comparePlayers(a, b)", context);
};

function navigationContext(hash) {
  const links = [];
  const listeners = {};
  const local = vm.createContext({
    document: {
      addEventListener() {},
      createElement(tag) {
        return {
          tag, attributes: {}, active: false,
          classList: { toggle(name, active) { this.owner.active = active; } },
          setAttribute(name, value) { this.attributes[name] = value; },
          removeAttribute(name) { delete this.attributes[name]; },
        };
      },
    },
    window: {
      location: { hash },
      addEventListener(name, callback) { listeners[name] = callback; },
    },
  });
  vm.runInContext(source, local);
  local.container = { appendChild(link) { link.classList.owner = link; links.push(link); } };
  vm.runInContext(`
    el.modes = container;
    let renderCount = 0;
    render = () => { renderCount++; };
    setupTabNavigation();
  `, local);
  return { local, links, listeners };
}

for (const [mode, hash] of [
  ["Home", "#home"], ["Kings", "#kings"], ["Peasants", "#peasants"],
  ["Maps", "#maps"], ["Games", "#games"], ["Game days", "#game-days"],
]) {
  test(`direct ${hash} link selects ${mode} on initial load and reload`, () => {
    for (let reload = 0; reload < 2; reload++) {
      const { local, links } = navigationContext(hash);
      assert.equal(vm.runInContext("state.mode", local), mode);
      assert.equal(links.length, 6);
      assert.ok(links.every(link => link.tag === "a"));
      assert.equal(links.filter(link => link.active).length, 1);
      const active = links.find(link => link.active);
      assert.equal(active.href, hash);
      assert.equal(active.textContent, mode);
      assert.equal(active.attributes["aria-current"], "page");
    }
  });
}

test("hash navigation and history update content and exactly one active link", () => {
  const { local, links, listeners } = navigationContext("#kings");
  for (const [hash, mode] of [["#games", "Games"], ["#game-days", "Game days"],
    ["#games", "Games"], ["#kings", "Kings"], ["#PEASANTS", "Peasants"]]) {
    local.window.location.hash = hash;
    listeners.hashchange();
    assert.equal(vm.runInContext("state.mode", local), mode);
    assert.equal(links.find(link => link.active).textContent, mode);
    assert.equal(links.filter(link => link.attributes["aria-current"] === "page").length, 1);
  }
  assert.equal(vm.runInContext("renderCount", local), 5);
});

test("bare and unknown fragments default to Home", () => {
  for (const hash of ["", "#unknown", "#%invalid"]) {
    const { local, links } = navigationContext(hash);
    assert.equal(vm.runInContext("state.mode", local), "Home");
    assert.equal(links.find(link => link.active).href, "#home");
  }
});

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
  assert.equal(cells.length, 10);
  assert.ok(html.includes('class="flag"') && html.includes("flagcdn.com/au.svg"));
  assert.ok(cells.includes("30 (20-10)"));
  assert.equal(Math.round((Number(cells[3]) + Number(cells[4])) * 100), Math.round(Number(cells[2]) * 100));
  vm.runInContext(`state.sort = {key: "year_change", direction: "descending"}; state.period = "all"; renderPlayers();`, tableContext);
  assert.ok(headers.every(h => h.hidden));
  assert.equal(vm.runInContext("state.sort.key", tableContext), "rank");
  assert.ok(vm.runInContext("el.playerRows.innerHTML", tableContext).includes('colspan="8"'));
  vm.runInContext(`state.data.rankings.kings["2026"] = []; state.period = "2026"; renderPlayers();`, tableContext);
  assert.ok(vm.runInContext("el.playerRows.innerHTML", tableContext).includes('colspan="10"'));
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
  const localContext = vm.createContext({document: {addEventListener() {}, querySelectorAll() { return []; }}});
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

test("Games sort numerically by total players, bonus and date without mutating data", () => {
  const headers = ["start_time", "players", "kings_handicap"].map(key => ({
    dataset: {sort: key}, setAttribute(name, value) { this[name] = value; },
  }));
  const tableContext = vm.createContext({document: {
    addEventListener() {}, querySelectorAll() { return headers; },
  }});
  vm.runInContext(source, tableContext);
  vm.runInContext(`
    state.period = "all";
    state.sort = {key: "score", direction: "ascending"};
    state.data = {games: [
      {id: "small", start_time: "2026-01-04", kings: [[1, "Alice"]], peasants: [[2, "Bob"]], kings_handicap: 100},
      {id: "large", start_time: "2026-02-01", kings: [[1, "Alice"]], peasants: Array(9).fill([2, "Bob"]), kings_handicap: 20},
      {id: "medium", start_time: "2025-03-02", kings: Array(3).fill([3, "Carol"]), peasants: [[4, "Dave"]], kings_handicap: 50},
      {id: "tied", start_time: "2026-03-01", kings: [[1, "Alice"]], peasants: [[2, "Bob"]], kings_handicap: 100}
    ].map(g => ({map: "Test", winner: "kings", duration_ms: 700000, kings_expected: 0.5, ...g}))};
    el.search = {value: ""}; el.gameRows = {};
  `, tableContext);
  const original = vm.runInContext("JSON.stringify(state.data)", tableContext);
  const render = (key = "start_time", direction = "descending") => {
    tableContext.sortKey = key;
    tableContext.sortDirection = direction;
    vm.runInContext("state.gameSort = {key: sortKey, direction: sortDirection}; renderGames();", tableContext);
    assert.equal(headers.find(h => h.dataset.sort === key)["aria-sort"], direction);
    assert.ok(headers.filter(h => h.dataset.sort !== key).every(h => h["aria-sort"] === "none"));
    return [...vm.runInContext("el.gameRows.innerHTML", tableContext).matchAll(/\/replays\/([^"]+)"/g)].map(m => m[1]);
  };
  assert.deepEqual(render(), ["tied", "large", "small", "medium"]);
  assert.deepEqual(render("start_time", "ascending"), ["medium", "small", "large", "tied"]);
  assert.deepEqual(render("players"), ["large", "medium", "tied", "small"]);
  assert.deepEqual(render("players", "ascending"), ["tied", "small", "medium", "large"]);
  assert.deepEqual(render("kings_handicap"), ["tied", "small", "medium", "large"]);
  assert.deepEqual(render("kings_handicap", "ascending"), ["large", "medium", "tied", "small"]);
  assert.equal(vm.runInContext("JSON.stringify(state.data)", tableContext), original);
  assert.equal(vm.runInContext("state.sort.key", tableContext), "score");
  vm.runInContext('state.period = "2026";', tableContext);
  assert.deepEqual(render("players"), ["large", "tied", "small"]);
  vm.runInContext('el.search.value = "alice";', tableContext);
  assert.deepEqual(render("kings_handicap"), ["tied", "small", "large"]);
  vm.runInContext('el.search.value = "test";', tableContext);
  assert.deepEqual(render("players"), ["large", "tied", "small"]);
  vm.runInContext('el.search.value = "carol";', tableContext);
  assert.deepEqual(render("players"), []);
  assert.ok(vm.runInContext("el.gameRows.innerHTML", tableContext).includes('colspan="8"'));
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

test("map leaderboard choices contain only the three combined map families", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  assert.deepEqual(Object.keys(data.mapRankings).sort(), ["Claymore", "Raptor Crater", "Throne"]);
  const claymore = data.mapRankings.Claymore;
  assert.ok(new Set(claymore.games.map(game => game.map)).size > 1);
  for (const [name, scope] of Object.entries(data.mapRankings)) {
    assert.deepEqual(scope.scoreDecay.maxGames, {kings: 10, peasants: 20});
    assert.deepEqual(scope.scoreDecay.gamesScale, data.scoreDecay.gamesScale);
    const prefix = name.toLowerCase();
    assert.ok(scope.games.every(game => game.map.replaceAll("_", " ").toLowerCase().startsWith(prefix)));
    assert.equal(scope.summary.all.games, scope.games.length);
    for (const period of data.periods.filter(p => p.id !== "all")) {
      assert.equal(scope.summary[period.id].games,
        scope.games.filter(game => game.start_time.startsWith(period.id)).length);
    }
  }
});

test("browser map deductions stop at 10 King and 20 Peasant games while overall policy stays 30/50", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  const local = vm.createContext({document: {addEventListener() {}}});
  vm.runInContext(source, local);
  local.data = data;
  for (const [role, cap] of [["kings", 10], ["peasants", 20]]) {
    local.role = role;
    local.cap = cap;
    const scores = vm.runInContext(`
      state.data = data; state.ratingMap = "Throne"; state.period = "2026";
      state.mode = role === "kings" ? "Kings" : "Peasants";
      state.data.mapRankings.Throne.rankings[role]["2026"] = [cap - 1, cap, cap + 1].map(count => ({
        user_id: count, name: String(count), games: count, starting_score: 800,
        experience: {inherited: 0, games: count, year: 2026, rating: 1500}
      }));
      playerRankings(Date.parse("2026-06-01")).sort((a, b) => a.user_id - b.user_id).map(row => row.score);
    `, local);
    assert.ok(scores[0] < scores[1]);
    assert.equal(scores[1], scores[2]);
    assert.equal(scores[1], Math.round((1500 - 700 / Math.sqrt(1 + cap / data.scoreDecay.gamesScale[role])) * 10) / 10);
  }
  assert.deepEqual(data.scoreDecay.maxGames, {kings: 30, peasants: 50});
});

test("map selection uses independent rankings and histories, with overall rankings unchanged on reset", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  const mapContext = vm.createContext({document: {addEventListener() {}}});
  vm.runInContext(source, mapContext);
  mapContext.data = data;
  const map = Object.keys(data.mapRankings).find(name => data.mapRankings[name].games.length > 1);
  mapContext.mapName = map;
  vm.runInContext(`
    state.data = data; state.mode = "Kings"; state.period = "all"; state.ratingMap = mapName;
  `, mapContext);
  const rows = JSON.parse(vm.runInContext("JSON.stringify(playerRankings())", mapContext));
  assert.deepEqual(rows, data.mapRankings[map].rankings.kings.all);
  const player = rows[0];
  mapContext.player = player;
  vm.runInContext(`
    state.player = {id: player.user_id, name: player.name}; state.playerRole = "Kings";
    el.playerGamesTitle = {}; el.playerGameRows = {}; el.playerChart = {};
    renderPlayerGames();
  `, mapContext);
  const html = vm.runInContext("el.playerGameRows.innerHTML", mapContext);
  const expected = data.mapRankings[map].games.filter(g => g.kings.some(([id]) => id === player.user_id));
  assert.equal((html.match(/<tr>/g) || []).length, expected.length);
  assert.ok(vm.runInContext("el.playerGamesTitle.textContent", mapContext).includes(map));
  vm.runInContext("state.ratingMap = null", mapContext);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(playerRankings())", mapContext)), data.rankings.kings.all);
});

test("yearly map scores use the existing browser decay for each role and map", () => {
  const data = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
  const mapContext = vm.createContext({document: {addEventListener() {}}});
  vm.runInContext(source, mapContext);
  mapContext.data = data;
  const results = vm.runInContext(`(() => {
    state.data = data;
    const results = [];
    for (const [map, scope] of Object.entries(data.mapRankings)) {
      state.ratingMap = map;
      for (const role of ["Kings", "Peasants"]) {
        state.mode = role;
        for (const period of data.periods.filter(p => p.id !== "all")) {
          state.period = period.id;
          const actual = playerRankings(Date.parse(data.generatedAt));
          for (const expected of scope.rankings[role.toLowerCase()][period.id]) {
            results.push([actual.find(r => r.user_id === expected.user_id).score, expected.score]);
          }
        }
      }
    }
    return results;
  })()`, mapContext);
  assert.ok(results.length > 0);
  for (const [actual, expected] of results) assert.equal(actual, expected);
});

test("map labels drop underscores and version suffixes", () => {
  const label = (map) => vm.runInContext(`mapLabel(${JSON.stringify(map)})`, context);
  assert.equal(label("Raptor_Crater_V2"), "Raptor Crater");
  assert.equal(label("All That Glitters Extended v1.0.2"), "All That Glitters Extended");
  assert.equal(label("Claymore 3.0.4"), "Claymore");
  assert.equal(label("DSD 8 Way 1.1"), "DSD 8 Way");
});
