function overlayOptions(search, defaultMap = null) {
  const params = new URLSearchParams(search);
  const layout = params.get("layout") || "side-by-side";
  if (!["side-by-side", "stacked"].includes(layout)) {
    throw new Error('Unknown layout. Use "side-by-side" or "stacked".');
  }
  const scale = Number(params.get("scale") ?? "1");
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
    throw new Error("Invalid scale. Use a number from 1 to 4.");
  }
  const map = params.get("map") || defaultMap;
  if (defaultMap && map.toLowerCase() !== defaultMap.toLowerCase()) {
    throw new Error(`This overlay is for ${defaultMap}. Use that map's overlay page instead.`);
  }
  return { layout, period: params.get("period"), map, scale };
}

function overlayView(data, options, now = Date.now()) {
  if (!Number.isFinite(Date.parse(data.generatedAt)) || !Array.isArray(data.periods)) {
    throw new Error("Invalid leaderboard publication metadata.");
  }
  const period = options.period || data.periods.find(p => p.id !== "all")?.id || "all";
  const periodInfo = data.periods.find(p => p.id === period);
  if (!periodInfo) {
    throw new Error(`Unknown period "${period}". Use a published year or "all".`);
  }
  const map = options.map
    ? Object.keys(data.mapRankings).find(name => name.toLowerCase() === options.map.toLowerCase())
    : null;
  if (options.map && !map) {
    throw new Error(`Unknown map "${options.map}". Check the leaderboard's map names.`);
  }
  const scope = map ? data.mapRankings[map] : data;
  const players = {};
  for (const role of ["kings", "peasants"]) {
    if (!Array.isArray(scope.rankings?.[role]?.[period])) {
      throw new Error(`Missing ${role} rankings for ${period}.`);
    }
    if (period !== "all") {
      const decay = scope.scoreDecay;
      if (!decay || [decay.halfLifeDays, decay.sigmaStart, decay.scoreK,
        decay.maxGames?.[role], decay.gamesScale?.[role]].some(value => !Number.isFinite(value) || value <= 0)
        || scope.rankings[role][period].some(row => !Number.isFinite(row.games)
          || !row.experience || ["inherited", "games", "year", "rating"]
            .some(key => !Number.isFinite(row.experience[key])))) {
        throw new Error(`Invalid ${role} score calculation data.`);
      }
    }
    const rows = rankedPlayers(scope, role, period, now);
    if (rows.some(row => typeof row.name !== "string" || !Number.isFinite(row.user_id)
        || !Number.isFinite(row.score) || !Number.isFinite(row.rank))) {
      throw new Error(`Invalid ${role} player data.`);
    }
    players[role] = rows.slice(0, 3);
  }
  return { label: `${periodInfo.label} / ${map || "All maps"}`, players, generatedAt: data.generatedAt };
}

function renderOverlay(view) {
  document.getElementById("scope").textContent = view.label;
  for (const role of ["kings", "peasants"]) {
    const list = document.getElementById(role);
    const rows = view.players[role];
    if (!rows.length) {
      if (!list.querySelector(".empty")) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No players this period";
        list.replaceChildren(empty);
      }
      continue;
    }
    list.querySelector(".empty")?.remove();
    rows.forEach((row, index) => {
      let item = list.children[index];
      if (!item) {
        item = document.createElement("li");
        item.className = "player";
        for (const className of ["rank", "name", "score"]) {
          const span = document.createElement("span");
          span.className = className;
          item.append(span);
        }
        list.append(item);
      }
      const signature = JSON.stringify([row.user_id, row.name, row.rank, formatScore(row.score)]);
      if (item.dataset.signature !== signature) {
        const changed = Boolean(item.dataset.signature);
        item.dataset.signature = signature;
        item.children[0].textContent = row.rank;
        item.children[1].textContent = row.name;
        item.children[1].title = row.name;
        item.children[2].textContent = formatScore(row.score);
        if (changed && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          item.animate([{ opacity: 0.4, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }],
            { duration: 350, easing: "ease-out" });
        }
      }
    });
    while (list.children.length > rows.length) {
      list.lastElementChild.remove();
    }
  }
}

function overlayStatus(message, warning = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.title = message;
  status.classList.toggle("warning", warning);
}

function startOverlay(options, buildView = overlayView, renderView = renderOverlay) {
  let data = null;
  let refreshing = false;
  const loadRankings = createRankingsLoader();
  document.getElementById("overlay").classList.toggle("stacked", options.layout === "stacked");

  async function refresh() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (data) {
        renderView(buildView(data, options));
      }
      const incoming = await loadRankings(controller.signal);
      const view = buildView(incoming, options);
      renderView(view);
      data = incoming;
      const published = new Date(view.generatedAt).toISOString().slice(0, 16).replace("T", " ");
      overlayStatus(`Published ${published} UTC`);
    } catch (error) {
      console.error("KOTH overlay refresh failed:", error);
      overlayStatus(data ? "Update failed / showing saved rankings" : `Rankings unavailable: ${error.message}`, true);
    } finally {
      clearTimeout(timeout);
      refreshing = false;
    }
  }

  void refresh();
  setInterval(refresh, 60000);
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    const element = document.getElementById("overlay");
    const options = overlayOptions(window.location.search, element.dataset.map);
    // Layout zoom rasterizes text at the requested size instead of stretching a bitmap.
    element.style.zoom = options.scale;
    if (element.dataset.mode) {
      startOverlay(options, (data, opts) => smallOverlayView(data, opts, element.dataset.mode), renderSmallOverlay);
    } else {
      startOverlay(options);
    }
  } catch (error) {
    console.error("KOTH overlay configuration failed:", error);
    overlayStatus(error.message, true);
  }
});
