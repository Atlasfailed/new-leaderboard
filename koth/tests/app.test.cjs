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

for (const key of ["rank", "name", "country", "score", "peak", "games", "wins", "win_rate", "streak", "last_played"]) {
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
      scoreDecay: {halfLifeDays: 90, maxGames: 50, sigmaStart: 350, gamesScale: 5, scoreK: 2},
      rankings: {kings: Object.fromEntries(["all", "2025", "2026"].map(year => [year, [
        {user_id: 1, name: "A", games: 1, rank: 1, score: 1488.9, peak: 1488.9,
         experience: {inherited: 50, games: 1, year: Number(year), rating: 1700}},
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
  const expected = Math.round((1700 - 700 / Math.sqrt(1 + 26 / 5)) * 10) / 10;
  assert.equal(score, expected);
});

test("current-year games retain full weight at year-end", () => {
  const row = decayedRows("2026", "2026-12-31T23:59:59Z").find(r => r.user_id === 2);
  const expected = Math.round((1800 - 700 / Math.sqrt(1 + 10 / 5)) * 10) / 10;
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
         kings: [[1, "Player", 842, -42, 884, -84]], peasants: []},
        {id: "old", start_time: "2026-06-01", map: "Test", winner: "kings",
         kings: [[1, "Player", 884, 84, 968, 168]], peasants: []}
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
    assert.ok(chart.includes(`: ${score}</title>`));
    assert.ok(!chart.includes("NaN"));
  });
}
