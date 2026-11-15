const fs = require("node:fs/promises");
const { gunzipSync } = require("node:zlib");
const { DemoParser, DemoModel } = require("sdfz-demo-parser");

const ID = DemoModel.Packet.ID;
const ACTION = DemoModel.TeamAction;
const FIELDS = [
  "metalProduced", "metalUsed", "metalExcess",
  "energyProduced", "energyUsed", "energyExcess",
  "damageDealt", "damageReceived", "unitsProduced", "unitsDied", "unitsKilled",
];
const MAX_BYTES = 500000;
const LIMIT_FRAME = 5 * 60 * 30;

function participation(players, events) {
  const states = new Map(players.map((p) => [p.playerId, {
    userId: p.userId, team: p.teamId, connected: true, playing: true, excluded: false,
  }]));
  for (const { frame, id, player, action, param, fromTeam } of events) {
    const state = states.get(player);
    if (id === ID.TEAM && action === ACTION.TEAM_DIED) {
      for (const other of states.values()) {
        if (other.team === param && other.playing) {
          other.playing = false;
          if (frame <= LIMIT_FRAME) other.excluded = true;
        }
      }
    } else if (state && id === ID.PLAYERLEFT) {
      state.connected = false;
      if (state.playing && frame <= LIMIT_FRAME) state.excluded = true;
    } else if (state && id === ID.PLAYERNAME) {
      state.connected = true;
      if (state.playing) state.excluded = false;
    } else if (state && id === ID.TEAM && action === ACTION.JOIN_TEAM) {
      state.team = param;
      state.playing = true;
      if (state.connected) state.excluded = false;
    } else if (state && id === ID.TEAM && (
      action === ACTION.RESIGN || (action === ACTION.GIVEAWAY && fromTeam === state.team)
    )) {
      state.playing = false;
      if (frame <= LIMIT_FRAME) state.excluded = true;
    }
  }
  return [...states.values()].filter((p) => p.excluded).map((p) => p.userId).sort((a, b) => a - b);
}

function readEvents(data, header) {
  let offset = header.headerSize + header.scriptSize;
  const end = offset + header.demoStreamSize;
  if (offset < 0 || end > data.length) throw new Error("Invalid demo stream size");
  let started = false, ended = false, frame = 0;
  const events = [];
  while (offset < end) {
    if (offset + 8 > end) throw new Error("Truncated demo packet header");
    const length = data.readUInt32LE(offset + 4);
    offset += 8;
    if (!length || offset + length > end) throw new Error("Invalid demo packet length");
    const packet = data.subarray(offset, offset + length);
    const id = packet[0];
    if (id === ID.STARTPLAYING && length >= 5 && packet.readUInt32LE(1) === 0) {
      started = true;
    } else if (started && !ended) {
      if ((id === ID.KEYFRAME && length < 5)
          || ((id === ID.PLAYERLEFT || id === ID.PLAYERNAME) && length < 3)
          || (id === ID.TEAM && length < 5)) {
        throw new Error(`Truncated replay packet ${id}`);
      }
      if (id === ID.KEYFRAME && length >= 5) frame = packet.readUInt32LE(1);
      else if (id === ID.NEWFRAME) frame++;
      else if (id === ID.GAMEOVER) ended = true;
      else if (id === ID.PLAYERLEFT && length >= 3) {
        events.push({ frame, id, player: packet[1], param: packet[2] });
      } else if (id === ID.PLAYERNAME && length >= 3) {
        events.push({ frame, id, player: packet[2] });
      } else if (id === ID.TEAM && length >= 5) {
        events.push({ frame, id, player: packet[1], action: packet[2], param: packet[3], fromTeam: packet[4] });
      }
    }
    offset += length;
  }
  if (!started || !ended) throw new Error("Recording lacks game-start or game-over packet");
  return events;
}

function makeExtract(demo, events, excluded) {
  const playerIds = new Set(demo.info.players.map((p) => p.playerId));
  const relevant = events.filter((event) =>
    playerIds.has(event.player) || (event.id === ID.TEAM && event.action === ACTION.TEAM_DIED)
  ).map(({ frame, id, player, action, param, fromTeam }) =>
    [frame, id, player, action ?? null, param ?? null, fromTeam ?? null]
  );
  const base = {
    version: 1,
    game_id: demo.info.meta.gameId,
    frames_per_second: 30,
    players: demo.info.players.map((p) => [p.playerId, p.userId, p.teamId, p.allyTeamId]),
    player_fields: ["player_id", "user_id", "team_id", "ally_team_id"],
    event_fields: ["frame", "packet_id", "player_id", "action", "parameter", "from_team"],
    events: relevant,
    excluded_user_ids: excluded,
    statistic_fields: FIELDS,
  };
  const stats = Object.entries(demo.statistics.teamStats);
  for (let interval = 1; interval <= 1024; interval *= 2) {
    const teams = stats.map(([id, rows]) => {
      const snapshots = [];
      let previous = -1;
      for (const row of rows) {
        const bucket = Math.floor(row.frame / (30 * 60 * interval));
        if (bucket > previous) {
          previous = bucket;
          snapshots.push([row.frame, ...FIELDS.map((key) => row[key])]);
        }
      }
      return [Number(id), rows.length ? FIELDS.map((key) => rows[rows.length - 1][key]) : null, snapshots];
    });
    const value = { ...base, snapshot_interval_minutes: interval, teams };
    const json = JSON.stringify(value);
    // Leave room for number formatting when Python serializes the extract.
    if (Buffer.byteLength(json) < MAX_BYTES - 20000) return json;
  }
  throw new Error("Participation and final statistics exceed the 500,000-byte extract limit");
}

async function analyze(file) {
  const parser = new DemoParser({ includePackets: [ID.STARTPLAYING, ID.GAMEOVER] });
  const demo = await parser.parseDemo(file);
  if (!demo.statistics) throw new Error("Replay statistics are missing");
  const players = demo.info.players;
  if (players.some((p) => !Number.isInteger(p.userId) || p.userId <= 0)
      || new Set(players.map((p) => p.userId)).size !== players.length
      || new Set(players.map((p) => p.playerId)).size !== players.length) {
    throw new Error("Recording contains missing or duplicate player identities");
  }
  const events = readEvents(gunzipSync(await fs.readFile(file)), demo.header);
  const excluded = participation(players, events);
  return {
    id: demo.info.meta.gameId,
    players: players.map((p) => p.userId),
    excluded,
    extract: JSON.parse(makeExtract(demo, events, excluded)),
  };
}

module.exports = { analyze, participation, readEvents, makeExtract };

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node pipeline/replay_analysis.cjs <recording.sdfz>");
    process.exitCode = 1;
  } else {
    analyze(process.argv[2]).then(
      (result) => console.log(JSON.stringify(result)),
      (error) => { console.error(error.stack || error.message); process.exitCode = 1; },
    );
  }
}
