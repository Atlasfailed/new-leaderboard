const CHAMPION_MAPS = [
  { name: "Raptor Crater", label: "Raptors", theme: "raptors" },
  { name: "Throne", label: "Throne", theme: "throne" },
  { name: "Claymore", label: "Claymore", theme: "claymore" },
];
const RECAP_PAGE_SIZE = 5;
let recapView = null;
let recapPage = 0;
let recapTimer = null;

function smallOverlayView(data, options, mode, now = Date.now()) {
  if (options.map) {
    throw new Error("These overlays cover all maps. Remove the map option.");
  }
  if (mode === "champions") {
    const maps = CHAMPION_MAPS.map(map => ({
      ...overlayView(data, { ...options, map: map.name }, now), ...map,
    }));
    const period = options.period || data.periods.find(p => p.id !== "all")?.id || "all";
    return { mode, maps, label: data.periods.find(p => p.id === period).label, generatedAt: data.generatedAt };
  }
  if (mode !== "recap") {
    throw new Error(`Unknown overlay mode "${mode}".`);
  }
  if (options.period || options.layout !== "side-by-side") {
    throw new Error("The Sunday recap uses its own session date and fixed layout. Remove period/layout options.");
  }
  if (!Number.isFinite(Date.parse(data.generatedAt)) || !Array.isArray(data.games)) {
    throw new Error("Invalid recap publication data.");
  }
  const today = sydneyGameTime(now).day;
  const session = gameDaySessions(data.games, "all").find(session =>
    new Date(`${session.day}T00:00:00Z`).getUTCDay() === 0 && session.day < today
  );
  if (!session) {
    return { mode, label: "No completed Sunday session", session: null, games: [], generatedAt: data.generatedAt };
  }
  const kingsWins = session.games.filter(game => game.winner === "kings").length;
  return {
    mode, label: `Sunday ${session.day} / Sydney`, session: session.day,
    kingsWins, peasantsWins: session.games.length - kingsWins,
    games: session.games, generatedAt: data.generatedAt,
  };
}

function smallOverlayText(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  span.title = text;
  return span;
}

function renderRecapPage() {
  const list = document.getElementById("recap-games");
  const games = recapView.games;
  const pages = Math.max(1, Math.ceil(games.length / RECAP_PAGE_SIZE));
  recapPage %= pages;
  const offset = recapPage * RECAP_PAGE_SIZE;
  const rows = games.slice(offset, offset + RECAP_PAGE_SIZE).map((game, index) => {
    const row = document.createElement("li");
    row.className = "recap-row";
    const seconds = Math.floor(game.duration_ms / 1000);
    row.append(
      smallOverlayText("game-number", String(offset + index + 1).padStart(2, "0")),
      smallOverlayText("game-map", mapLabel(game.map)),
      smallOverlayText(`winner ${game.winner}`, game.winner === "kings" ? "Kings" : "Peasants"),
      smallOverlayText("teams", `${game.kings.length} vs ${game.peasants.length}`),
      smallOverlayText("duration", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`),
    );
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "recap-empty";
    empty.textContent = "No completed Sunday games in the published data.";
    rows.push(empty);
  }
  list.replaceChildren(...rows);
  document.getElementById("page-status").textContent = games.length
    ? `Games ${offset + 1}-${Math.min(offset + RECAP_PAGE_SIZE, games.length)} of ${games.length} / page ${recapPage + 1}/${pages}`
    : "Waiting for published games";
}

function renderSmallOverlay(view) {
  document.getElementById("scope").textContent = view.label;
  if (view.mode === "champions") {
    const tiles = view.maps.map(map => {
      const tile = document.createElement("section");
      tile.className = `champion-tile ${map.theme}`;
      const title = document.createElement("h1");
      title.textContent = map.label;
      tile.append(title);
      for (const role of ["kings", "peasants"]) {
        const player = map.players[role][0];
        const row = document.createElement("div");
        row.className = `champion-row ${role}`;
        row.append(
          smallOverlayText("role-label", role === "kings" ? "King" : "Peasant"),
          smallOverlayText("champion-name", player ? player.name : "No players"),
          smallOverlayText("champion-score", player ? formatScore(player.score) : "-"),
        );
        tile.append(row);
      }
      return tile;
    });
    document.getElementById("champions").replaceChildren(...tiles);
    return;
  }
  if (recapView?.session !== view.session) {
    recapPage = 0;
  }
  recapView = view;
  document.getElementById("session-summary").textContent = view.session
    ? `${view.games.length} games / Kings ${view.kingsWins} wins / Peasants ${view.peasantsWins} wins`
    : "Published leaderboard games only";
  renderRecapPage();
  if (recapTimer === null) {
    recapTimer = setInterval(() => {
      recapPage++;
      renderRecapPage();
    }, 12000);
  }
}
