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
