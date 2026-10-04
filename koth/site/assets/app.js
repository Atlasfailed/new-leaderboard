const state = { data: null, mode: "Kings", period: "all", map: null, playerRole: "Kings", player: null };
const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  [
    "updated", "error", "modes", "period", "search", "summary", "playersWrap", "playerRows", "mapsWrap", "mapRows",
    "chartTitle", "scatter", "bands", "gamesWrap", "gameRows", "playerGames", "playerGamesTitle", "playerGameModes",
    "playerGameRows", "playerGamesClose",
  ].forEach((id) => (el[id] = document.getElementById(id)));
  try {
    const response = await fetch("data/rankings.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    state.data = await response.json();
  } catch (error) {
    el.error.textContent = `Could not load data (${error.message}).`;
    el.error.hidden = false;
    return;
  }
  el.updated.textContent = formatDateTime(state.data.generatedAt);
  el.period.innerHTML = state.data.periods.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
  modeButtons(el.modes, ["Kings", "Peasants", "Maps", "Games"], state.mode, (mode) => {
    state.mode = mode;
    render();
  });
  el.period.addEventListener("change", () => {
    state.period = el.period.value;
    render();
  });
  el.search.addEventListener("input", debounce(render, 150));
  el.playerRows.addEventListener("click", (event) => {
    const link = event.target.closest("[data-user]");
    if (link) {
      event.preventDefault();
      openPlayer(Number(link.dataset.user), link.dataset.name);
    }
  });
  el.mapRows.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-map]");
    if (row) {
      state.map = state.map === row.dataset.map ? null : row.dataset.map;
      render();
    }
  });
  el.playerGamesClose.addEventListener("click", () => el.playerGames.close());
  el.playerGames.addEventListener("click", (event) => {
    if (event.target === el.playerGames) {
      el.playerGames.close();
    }
  });
  render();
});

function periodGames() {
  const games = state.data.games;
  return state.period === "all" ? games : games.filter((g) => g.start_time.startsWith(state.period));
}

function render() {
  const summary = state.data.summary[state.period] || { games: 0, kings_wins: 0, peasants_wins: 0 };
  el.summary.textContent = `${summary.games} games: Kings won ${summary.kings_wins}, Peasants won ${summary.peasants_wins}.`;
  const { mode } = state;
  el.playersWrap.hidden = mode !== "Kings" && mode !== "Peasants";
  el.mapsWrap.hidden = mode !== "Maps";
  el.gamesWrap.hidden = mode !== "Games";
  if (mode === "Maps") {
    renderMaps();
  } else if (mode === "Games") {
    renderGames();
    const backtest = state.data.model?.backtest;
    if (backtest?.accuracy) {
      el.summary.textContent += ` Kings win chance uses bonus, team sizes and average OpenSkill; tested on past games it picked the winner ${Math.round(backtest.accuracy * 100)}% of the time (${backtest.games} games).`;
      const [low, mid, high] = backtest.bands || [];
      if (low?.games && mid?.games && high?.games) {
        el.summary.textContent += ` Low confidence (favourite under 60%): right ${Math.round(low.accuracy * 100)}% of the time. Medium (60-70%): ${Math.round(mid.accuracy * 100)}%. High (70% or more): ${Math.round(high.accuracy * 100)}%.`;
      }
    }
  } else {
    renderPlayers();
  }
}

function renderPlayers() {
  const query = el.search.value.trim().toLowerCase();
  const rows = (state.data.rankings[state.mode.toLowerCase()][state.period] || []).filter(
    (row) => !query || row.name.toLowerCase().includes(query)
  );
  el.playerRows.innerHTML = rows.length
    ? rows
        .map(
          (row, index) => `<tr>
          <td>${index + 1}</td>
          <td class="name-cell"><a href="#" data-user="${row.user_id}" data-name="${esc(row.name)}">${esc(row.name)}</a></td>
          <td>${esc(row.country)}</td>
          <td><strong>${Math.round(row.rating)}</strong></td>
          <td>${Math.round(row.peak)}</td>
          <td>${row.games}</td>
          <td>${row.wins}-${row.losses}</td>
          <td>${percent(row.win_rate)}</td>
          <td>${row.streak > 0 ? "+" : ""}${row.streak}</td>
          <td>${formatDate(row.last_played)}</td>
        </tr>`
        )
        .join("")
    : emptyRow(10);
}

function confidence(chance) {
  const favourite = Math.max(chance, 1 - chance);
  return favourite < 0.6 ? "low confidence" : favourite < 0.7 ? "medium confidence" : "high confidence";
}

function renderGames() {
  const query = el.search.value.trim().toLowerCase();
  const games = periodGames().filter(
    (g) =>
      !query ||
      g.map.toLowerCase().includes(query) ||
      [...g.kings, ...g.peasants].some(([, name]) => name.toLowerCase().includes(query))
  );
  el.gameRows.innerHTML = games.length
    ? games
        .map(
          (g) => `<tr>
          <td>${formatDate(g.start_time)}</td>
          <td>${esc(g.map)}</td>
          <td title="${esc(g.kings.map(([, n]) => n).join(", "))}">${g.kings.length}</td>
          <td>${g.peasants.length}</td>
          <td>+${g.kings_handicap}%</td>
          <td>${percent(g.kings_expected)} <span class="confidence">${confidence(g.kings_expected)}</span></td>
          <td>${g.winner === "kings" ? "Kings" : "Peasants"}</td>
          <td>${minutes(g.duration_ms)}</td>
          <td>${replayLink(g.id)}</td>
        </tr>`
        )
        .join("")
    : emptyRow(9);
}

const SCATTER = { width: 360, height: 260, left: 56, right: 12, top: 10, bottom: 34 };

function renderMaps() {
  const query = el.search.value.trim().toLowerCase();
  const all = periodGames();
  const byMap = new Map();
  all.forEach((g) => byMap.set(g.map, [...(byMap.get(g.map) || []), g]));
  const mean = (games, fn) => games.reduce((sum, g) => sum + fn(g), 0) / games.length;
  const rows = [...byMap.entries()]
    .filter(([map]) => !query || map.toLowerCase().includes(query))
    .map(([map, games]) => ({
      map,
      count: games.length,
      rate: mean(games, (g) => (g.winner === "kings" ? 1 : 0)),
      kings: mean(games, (g) => g.kings.length),
      peasants: mean(games, (g) => g.peasants.length),
      bonus: mean(games, (g) => g.kings_handicap),
      length: mean(games, (g) => g.duration_ms),
    }))
    .sort((a, b) => b.count - a.count);
  if (!byMap.has(state.map)) {
    state.map = null;
  }
  el.mapRows.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr data-map="${esc(r.map)}"${r.map === state.map ? ' class="selected"' : ""}>
          <td class="name-cell">${esc(r.map)}</td>
          <td>${r.count}</td>
          <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${(r.rate * 100).toFixed(0)}%"></div></div><span>${percent(r.rate)}</span></div></td>
          <td>${r.kings.toFixed(1)}</td>
          <td>${r.peasants.toFixed(1)}</td>
          <td>+${Math.round(r.bonus)}%</td>
          <td>${minutes(r.length)}</td>
        </tr>`
        )
        .join("")
    : emptyRow(7);
  const selected = state.map ? byMap.get(state.map) : all;
  el.chartTitle.textContent = `${state.map || "All maps"} (${selected.length} games)`;
  el.scatter.innerHTML = scatterSvg(selected);
  el.bands.innerHTML = bandsHtml(selected);
}

function scatterSvg(games) {
  const { width, height, left, right, top, bottom } = SCATTER;
  if (!games.length) {
    return "";
  }
  const ratios = games.map((g) => g.peasants.length / g.kings.length);
  const bonuses = games.map((g) => g.kings_handicap);
  const xMax = Math.ceil(Math.max(...ratios, 4));
  const yMin = Math.floor(Math.min(...bonuses, 40) / 10) * 10 - 5;
  const yMax = Math.ceil(Math.max(...bonuses, 60) / 10) * 10 + 5;
  const x = (v) => left + (v / xMax) * (width - left - right);
  const y = (v) => top + (1 - (v - yMin) / (yMax - yMin)) * (height - top - bottom);
  const yTicks = [];
  for (let v = Math.ceil(yMin / 10) * 10; v <= yMax; v += 10) {
    yTicks.push(v);
  }
  const grid = [
    ...Array.from({ length: Math.floor(xMax / 2) + 1 }, (_, i) => i * 2).map(
      (t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - bottom}" stroke="#1c2c3b"/><text x="${x(t)}" y="${height - bottom + 14}" text-anchor="middle">${t}</text>`
    ),
    ...yTicks.map(
      (t) => `<line x1="${left}" x2="${width - right}" y1="${y(t)}" y2="${y(t)}" stroke="#1c2c3b"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">+${t}%</text>`
    ),
  ].join("");
  const dots = games
    .map((g, i) => {
      const won = g.winner === "kings";
      const cx = x(ratios[i]) + ((i * 7) % 5) - 2;
      const cy = y(bonuses[i]) + ((i * 11) % 5) - 2;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${won ? "#19b5ff" : "#ff5c5c"}" fill-opacity="0.6"><title>${esc(g.map)}: ${g.kings.length} v ${g.peasants.length}, +${g.kings_handicap}%, ${won ? "Kings" : "Peasants"} won</title></circle>`;
    })
    .join("");
  const mid = (top + height - bottom) / 2;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Games by peasants per king and bonus">${grid}${dots}<text x="${(left + width - right) / 2}" y="${height - 4}" text-anchor="middle">Peasants per king</text><text x="8" y="${mid}" transform="rotate(-90 8 ${mid})" text-anchor="middle">Kings bonus</text></svg>`;
}

function bandsHtml(games) {
  const bands = [
    ["under 4", (r) => r < 4],
    ["4 to 6", (r) => r >= 4 && r < 6],
    ["6 to 8", (r) => r >= 6 && r < 8],
    ["8 or more", (r) => r >= 8],
  ];
  return bands
    .map(([label, test]) => {
      const inBand = games.filter((g) => test(g.peasants.length / g.kings.length));
      if (!inBand.length) {
        return `<div class="band-row"><span>${label}</span><span class="muted">no games</span><span></span></div>`;
      }
      const rate = inBand.filter((g) => g.winner === "kings").length / inBand.length;
      return `<div class="band-row"><span>${label}</span><div class="bar-track"><div class="bar-fill" style="width:${(rate * 100).toFixed(0)}%"></div></div><span>${percent(rate)} (${inBand.length})</span></div>`;
    })
    .join("");
}

function openPlayer(id, name) {
  state.player = { id, name };
  state.playerRole = state.mode === "Peasants" ? "Peasants" : "Kings";
  modeButtons(el.playerGameModes, ["Kings", "Peasants"], state.playerRole, (role) => {
    state.playerRole = role;
    renderPlayerGames();
  });
  renderPlayerGames();
  el.playerGames.showModal();
}

function renderPlayerGames() {
  const { id, name } = state.player;
  const role = state.playerRole.toLowerCase();
  let wins = 0;
  const rows = [];
  periodGames().forEach((g) => {
    if (!g[role].some(([userId]) => userId === id)) {
      return;
    }
    const won = g.winner === role;
    wins += won;
    rows.push(`<tr>
      <td>${formatDate(g.start_time)}</td>
      <td>${esc(g.map)}</td>
      <td>${won ? "Win" : "Loss"}</td>
      <td>${g.kings.length} vs ${g.peasants.length}</td>
      <td>${replayLink(g.id)}</td>
    </tr>`);
  });
  el.playerGamesTitle.textContent = `${name} - ${state.playerRole}: ${rows.length} games, ${wins} wins`;
  el.playerGameRows.innerHTML = rows.join("") || emptyRow(5);
}

function modeButtons(container, modes, active, onSelect) {
  container.innerHTML = "";
  modes.forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-button${mode === active ? " active" : ""}`;
    button.textContent = mode;
    button.addEventListener("click", () => {
      container.querySelectorAll(".mode-button").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      onSelect(mode);
    });
    container.appendChild(button);
  });
}

const replayLink = (id) =>
  `<a href="https://www.bar-rts.com/replays/${esc(id)}" target="_blank" rel="noopener">Watch</a>`;
const emptyRow = (n) => `<tr><td class="empty" colspan="${n}">No results</td></tr>`;
const minutes = (ms) => `${Math.round(Number(ms) / 60000)} min`;
const percent = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : `${(Number(v) * 100).toFixed(1)}%`);
const formatDate = (v) =>
  v ? new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit" }).format(new Date(v)) : "-";
const formatDateTime = (v) =>
  v
    ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(v))
    : "-";
const esc = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}
