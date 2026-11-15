const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DemoModel } = require("sdfz-demo-parser");
const { participation, readEvents, makeExtract } = require("../pipeline/replay_analysis.cjs");

const ID = DemoModel.Packet.ID;
const ACTION = DemoModel.TeamAction;
const players = [
  { playerId: 1, userId: 101, teamId: 1, allyTeamId: 0 },
  { playerId: 2, userId: 102, teamId: 2, allyTeamId: 1 },
];

test("excludes early exits including spectators, but keeps later exits and resumed players", () => {
  const resign = (frame, player) => ({ id: ID.TEAM, frame, player, action: ACTION.RESIGN });
  const left = (frame, player) => ({ id: ID.PLAYERLEFT, frame, player });
  const name = (frame, player) => ({ id: ID.PLAYERNAME, frame, player });
  assert.deepEqual(participation(players, [resign(9000, 1), left(9001, 2)]), [101]);
  assert.deepEqual(participation(players, [left(100, 1), name(1000, 1)]), []);
  assert.deepEqual(participation(players, [resign(100, 1), name(1000, 1)]), [101]);
  assert.deepEqual(participation(players, [
    resign(100, 1), { id: ID.TEAM, frame: 500, player: 1, action: ACTION.JOIN_TEAM, param: 1 },
  ]), []);
  assert.deepEqual(participation(players, [left(100, 1), name(1000, 1), left(8000, 1)]), [101]);
});

test("detects giveaway of own team and team death, not giveaway of another team", () => {
  const giveaway = (fromTeam) => ({ id: ID.TEAM, frame: 100, player: 1,
    action: ACTION.GIVEAWAY, param: 2, fromTeam });
  assert.deepEqual(participation(players, [giveaway(2)]), []);
  assert.deepEqual(participation(players, [giveaway(1)]), [101]);
  assert.deepEqual(participation(players, [{
    id: ID.TEAM, frame: 100, player: 1, action: ACTION.TEAM_DIED, param: 2,
  }]), [102]);
});

test("counts game frames precisely and reads reconnect player numbers", () => {
  function packet(bytes) {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, Buffer.from(bytes)]);
  }
  const stream = Buffer.concat([
    packet([ID.STARTPLAYING, 0, 0, 0, 0]),
    packet([ID.KEYFRAME, 0x20, 0x23, 0, 0]),
    packet([ID.NEWFRAME]),
    packet([ID.PLAYERLEFT, 1, 0]),
    packet([ID.PLAYERNAME, 5, 1, 65, 0]),
    packet([ID.GAMEOVER, 0]),
  ]);
  const events = readEvents(stream, { headerSize: 0, scriptSize: 0, demoStreamSize: stream.length });
  assert.equal(events[0].frame, 8993);
  assert.equal(events[1].player, 1);
  assert.deepEqual(participation(players, events), []);
  assert.throws(() => readEvents(stream.subarray(0, -1), {
    headerSize: 0, scriptSize: 0, demoStreamSize: stream.length,
  }), /stream size/);
});

test("limits the whole extract while retaining final statistics", () => {
  const row = { frame: 0, metalProduced: 100, metalUsed: 50, metalExcess: 2,
    energyProduced: 100, energyUsed: 50, energyExcess: 2,
    damageDealt: 10, damageReceived: 20, unitsProduced: 30, unitsDied: 10, unitsKilled: 5 };
  const teamStats = Object.fromEntries(Array.from({ length: 120 }, (_, i) =>
    [i, Array.from({ length: 120 }, (_, minute) => ({ ...row, frame: minute * 1800 }))]));
  const demo = { info: { meta: { gameId: "game" }, players }, statistics: { teamStats } };
  const json = makeExtract(demo, [], []);
  const result = JSON.parse(json);
  assert.ok(Buffer.byteLength(json) < 500000);
  assert.ok(result.snapshot_interval_minutes > 1);
  assert.deepEqual(result.teams[0][1], [100, 50, 2, 100, 50, 2, 10, 20, 30, 10, 5]);
});
