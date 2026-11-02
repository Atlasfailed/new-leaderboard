const assert = require("node:assert/strict");
const { test } = require("node:test");
const { toReplay } = require("../pipeline/parse_local_replay.cjs");

function demo() {
  return {
    info: {
      meta: {
        gameId: "8442e76abab6d5932806d2405379b7ae",
        startTime: new Date("2026-11-01T13:45:40Z"),
        durationMs: 1965600,
        fullDurationMs: 2282000,
        map: "Raptor_Crater_V2",
        winningAllyTeamIds: [0],
      },
      players: [
        { userId: 1, name: "Peasant", allyTeamId: 0, handicap: 0, countryCode: "BE", skill: "[25]" },
        { userId: 2, name: "King", allyTeamId: 1, handicap: 55 },
      ],
      spectators: [{ name: "Twig" }],
      allyTeams: [{ allyTeamId: 0 }, { allyTeamId: 1 }],
      ais: [],
    },
    statistics: { winningAllyTeamIds: [0] },
  };
}

test("maps roster, winner and packet duration without using wall-clock time", () => {
  const replay = toReplay(demo(), true, true);
  assert.equal(replay.durationMs, 1965600);
  assert.equal(replay.startTime, "2026-11-01T13:45:40.000Z");
  assert.equal(replay.AllyTeams[0].winningTeam, true);
  assert.equal(replay.AllyTeams[1].winningTeam, false);
  assert.equal(replay.AllyTeams[1].Players[0].handicap, 55);
  assert.equal(replay.AllyTeams[0].Players[0].userId, 1);
  assert.equal(replay.hasBots, false);
  assert.deepEqual(replay.Spectators, [{ name: "Twig" }]);
});

test("rejects incomplete recordings and missing start packets", () => {
  assert.throws(() => toReplay(demo(), false, true), /complete recording/);
  assert.throws(() => toReplay(demo(), true, false), /complete recording/);
  const value = demo();
  value.info.meta.durationMs = 0;
  assert.throws(() => toReplay(value, true, true), /positive duration/);
});

test("rejects absent, ambiguous and contradictory winners", () => {
  for (const winners of [[], [0, 1], [2]]) {
    const value = demo();
    value.info.meta.winningAllyTeamIds = winners;
    assert.throws(() => toReplay(value, true, true), /winning ally team/);
  }
  const value = demo();
  value.statistics.winningAllyTeamIds = [1];
  assert.throws(() => toReplay(value, true, true), /disagree/);
});

test("never silently drops missing or duplicate account IDs", () => {
  for (const id of [undefined, 0, 1]) {
    const value = demo();
    value.info.players[1].userId = id;
    assert.throws(() => toReplay(value, true, true), /unique BAR user ID/);
  }
});

test("rejects invalid game IDs, team assignments and handicaps", () => {
  const value = demo();
  value.info.meta.gameId = "0".repeat(32);
  assert.throws(() => toReplay(value, true, true), /valid game ID/);
  value.info.meta.gameId = demo().info.meta.gameId;
  value.info.players[0].allyTeamId = 99;
  assert.throws(() => toReplay(value, true, true), /unknown ally team/);
  value.info.players[0].allyTeamId = 0;
  value.info.players[0].handicap = NaN;
  assert.throws(() => toReplay(value, true, true), /invalid handicap/);
});

test("preserves bot presence for the existing classifier to reject", () => {
  const value = demo();
  value.info.ais.push({ name: "Bot" });
  assert.equal(toReplay(value, true, true).hasBots, true);
});
