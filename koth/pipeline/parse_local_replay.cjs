const { DemoParser, DemoModel } = require("sdfz-demo-parser");

function toReplay(demo, started, ended) {
  const { meta, players, spectators, allyTeams, ais } = demo.info;
  if (!started || !ended || !Number.isFinite(meta.durationMs) || meta.durationMs <= 0) {
    throw new Error("Replay must contain game-start and game-over packets with a positive duration; request a complete recording.");
  }
  if (!/^[a-f0-9]{32}$/i.test(meta.gameId) || /^0+$/.test(meta.gameId)) {
    throw new Error("Replay has no valid game ID.");
  }
  const winners = meta.winningAllyTeamIds;
  if (winners.length !== 1 || !allyTeams.some((ally) => ally.allyTeamId === winners[0])) {
    throw new Error("Replay must identify exactly one winning ally team.");
  }
  const footerWinners = demo.statistics.winningAllyTeamIds;
  if (footerWinners.length && (footerWinners.length !== 1 || footerWinners[0] !== winners[0])) {
    throw new Error("Game-over packet and statistics disagree about the winner.");
  }
  const ids = players.map((player) => player.userId);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error("Every player needs a unique BAR user ID; refusing to omit players or match by name.");
  }
  if (players.some((player) => !allyTeams.some((ally) => ally.allyTeamId === player.allyTeamId))) {
    throw new Error("A player has an unknown ally team.");
  }
  if (players.some((player) => !Number.isFinite(player.handicap) || player.handicap < 0)) {
    throw new Error("A player has an invalid handicap.");
  }
  return {
    id: meta.gameId,
    startTime: new Date(meta.startTime).toISOString(),
    durationMs: meta.durationMs,
    Map: { scriptName: meta.map },
    hasBots: ais.length > 0,
    Spectators: spectators.map(({ name }) => ({ name })),
    AllyTeams: allyTeams.map(({ allyTeamId }) => ({
      winningTeam: winners.includes(allyTeamId),
      Players: players.filter((player) => player.allyTeamId === allyTeamId).map((player) => ({
        userId: player.userId,
        name: player.name,
        handicap: player.handicap,
        countryCode: player.countryCode,
        skill: player.skill,
      })),
    })),
  };
}

async function parseReplay(file) {
  // STARTPLAYING initializes the parser's clock; GAMEOVER alone reports zero duration.
  const parser = new DemoParser({
    includePackets: [DemoModel.Packet.ID.STARTPLAYING, DemoModel.Packet.ID.GAMEOVER],
  });
  let started = false;
  let ended = false;
  parser.onPacket.add((packet) => {
    if (packet.id === DemoModel.Packet.ID.STARTPLAYING && packet.data.countdown === 0) started = true;
    if (packet.id === DemoModel.Packet.ID.GAMEOVER) ended = true;
  });
  return toReplay(await parser.parseDemo(file), started, ended);
}

module.exports = { toReplay, parseReplay };

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node pipeline/parse_local_replay.cjs <demo.sdfz>");
    process.exitCode = 1;
  } else {
    parseReplay(process.argv[2]).then(
      (replay) => console.log(JSON.stringify(replay)),
      (error) => {
        console.error(`Cannot parse replay: ${error.message}`);
        process.exitCode = 1;
      },
    );
  }
}
