const state = { data: null, mode: "Home", period: null, map: null, ratingMap: null, playerRole: "Kings", player: null, sort: { key: "rank", direction: "ascending" } };
const el = {};
const SCORE_SCALE = 42;

function displayScore(score) {
  return 50 / 3 + (score - 800) / SCORE_SCALE;
}

function formatScore(score) {
  return displayScore(score).toFixed(2);
}

document.addEventListener("DOMContentLoaded", async () => {
  [
    "updated", "error", "modes", "toolbar", "homeWrap", "period", "search", "playersWrap", "playerRows", "playerChart", "mapsWrap", "mapRows",
    "chartTitle", "scatter", "bands", "gamesWrap", "gameRows", "playerGames", "playerGamesTitle", "playerGameModes",
    "playerGameRows", "playerGamesClose", "gameDaysWrap", "gameDayRows",
    "leaderboardMap", "leaderboardMapLabel",
  ].forEach((id) => (el[id] = document.getElementById(id)));
  try {
    const response = await fetch("data/rankings.json", { cache: "no-cache" });
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
  state.period = state.data.periods.find((p) => p.id !== "all")?.id || "all";
  el.period.innerHTML = state.data.periods.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
  el.period.value = state.period;
  el.leaderboardMap.addEventListener("change", () => {
    state.ratingMap = el.leaderboardMap.value || null;
    render();
  });
  document.querySelectorAll("#playersWrap th[data-sort]").forEach((header) => {
    header.querySelector("button").addEventListener("click", () => {
      const key = header.dataset.sort;
      state.sort = {
        key,
        direction: state.sort.key === key
          ? (state.sort.direction === "ascending" ? "descending" : "ascending")
          : (["rank", "name", "country"].includes(key) ? "ascending" : "descending"),
      };
      renderPlayers();
    });
  });
  modeButtons(el.modes, ["Home", "Kings", "Peasants", "Maps", "Games", "Game days"], state.mode, (mode) => {
    state.mode = mode;
    render();
    window.setInterval(() => {
      if (state.mode === "Kings" || state.mode === "Peasants") {
        renderPlayers();
      }
    }, 60000);
  });
  const twitchUrl = new URL("https://player.twitch.tv/");
  twitchUrl.search = new URLSearchParams({
    channel: "allreasonnologic",
    parent: window.location.hostname,
    muted: "true",
  }).toString();
  document.getElementById("twitchPlayer").src = twitchUrl.toString();
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
  const isHome = state.mode === "Home";
  const { mode } = state;
  el.homeWrap.hidden = !isHome;
  el.toolbar.hidden = isHome;
  el.playersWrap.hidden = mode !== "Kings" && mode !== "Peasants";
  el.mapsWrap.hidden = mode !== "Maps";
  el.gamesWrap.hidden = mode !== "Games";
  el.gameDaysWrap.hidden = mode !== "Game days";
  const isPlayers = mode === "Kings" || mode === "Peasants";
  el.leaderboardMapLabel.hidden = !isPlayers;
  if (isPlayers) {
    const maps = Object.keys(state.data.mapRankings).sort((a, b) => a.localeCompare(b));
    el.leaderboardMap.innerHTML = '<option value="">All maps</option>' + maps.map(map =>
      `<option value="${esc(map)}">${esc(map)} (${state.data.mapRankings[map].summary[state.period].games})</option>`
    ).join("");
    el.leaderboardMap.value = state.ratingMap || "";
  }
  el.search.placeholder = isPlayers ? "Player name" : mode === "Maps" ? "Map name"
    : mode === "Game days" ? "Date, player or map" : "Player or map";
  if (mode === "Maps") {
    renderMaps();
  } else if (mode === "Games") {
    renderGames();
  } else if (mode === "Game days") {
    renderGameDays();
  } else if (mode === "Kings" || mode === "Peasants") {
    renderPlayers();
  }
}

function renderPlayers() {
  const yearly = state.period !== "all";
  if (!yearly && ["starting_score", "year_change"].includes(state.sort.key)) {
    state.sort = { key: "rank", direction: "ascending" };
  }
  const query = el.search.value.trim().toLowerCase();
  const now = Date.now();
  const rows = playerRankings(now).filter(
    (row) => !query || row.name.toLowerCase().includes(query)
  ).sort(comparePlayers);
  document.querySelectorAll("#playersWrap th[data-sort]").forEach((header) => {
    header.setAttribute("aria-sort", header.dataset.sort === state.sort.key ? state.sort.direction : "none");
    if (["starting_score", "year_change"].includes(header.dataset.sort)) {
      header.hidden = !yearly;
    }
  });
  el.playerRows.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<tr>
          <td>${row.rank}</td>
          <td class="name-cell"><a href="#" data-user="${row.user_id}" data-name="${esc(row.name)}">${esc(row.name)}</a></td>
          <td>${esc(row.country)}</td>
          <td><strong>${formatScore(row.score)}</strong></td>
          ${yearly ? `<td>${formatScore(row.starting_score)}</td>
          ${changeCell(Math.round(displayScore(row.score) * 100) - Math.round(displayScore(row.starting_score) * 100))}` : ""}
          <td>${formatScore(row.peak)}</td>
          <td>${row.games}</td>
          <td>${row.wins}-${row.losses}</td>
          <td>${percent(row.win_rate)}</td>
          <td>${row.streak > 0 ? "+" : ""}${row.streak}</td>
          <td>${formatDate(row.last_played)}</td>
        </tr>`
        )
        .join("")
    : emptyRow(yearly ? 12 : 10);
}

function playerRankings(now = Date.now()) {
  const rows = playerRatingScope().rankings[state.mode.toLowerCase()][state.period] || [];
  if (state.period === "all") {
    return rows;
  }
  const cutoff = Math.min(now, Date.parse(`${state.period}-12-31T23:59:59Z`));
  const { halfLifeDays, maxGames, sigmaStart, gamesScale, scoreK } = state.data.scoreDecay;
  const role = state.mode.toLowerCase();
  return rows.map((row) => {
    const { inherited, games, year, rating } = row.experience;
    const days = Math.max(0, (cutoff - Date.parse(`${year}-01-01T00:00:00Z`)) / 86400000);
    const effective = games + inherited * 2 ** (-days / halfLifeDays);
    const score = rating - scoreK * sigmaStart / Math.sqrt(1 + Math.min(effective, maxGames[role]) / gamesScale[role]);
    const roundedScore = Math.round(score * 10) / 10;
    return { ...row, score: roundedScore, year_change: roundedScore - row.starting_score };
  }).sort((a, b) => b.score - a.score || b.games - a.games
      || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

function playerRatingScope() {
  return state.ratingMap ? state.data.mapRankings[state.ratingMap] : state.data;
}

function comparePlayers(a, b) {
  const { key, direction } = state.sort;
  const left = a[key], right = b[key];
  let order = typeof left === "string"
    ? left.localeCompare(right, "en", { sensitivity: "base" })
    : left - right;
  if (key === "wins" && order === 0) {
    order = b.losses - a.losses;
  }
  return (direction === "ascending" ? order : -order) || a.rank - b.rank;
}

function confidence(chance) {
  return chance >= 0.6 ? "high" : chance <= 0.4 ? "medium" : "low";
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
          <td class="chance chance-${confidence(g.kings_expected)}">${percent(g.kings_expected)}</td>
          <td>${g.winner === "kings" ? "Kings" : "Peasants"}</td>
          <td>${minutes(g.duration_ms)}</td>
          <td>${replayLink(g)}</td>
        </tr>`
        )
        .join("")
    : emptyRow(9);
}

const SYDNEY_TIME_ZONE = "Australia/Sydney";
const LONG_BREAK_MINUTES = 45;
const sydneyPartsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SYDNEY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function sydneyGameTime(value) {
  const parts = Object.fromEntries(sydneyPartsFormatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const day = hour < 12
    ? new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    : date;
  return {
    day,
    minute: (hour < 12 ? 1440 : 0) + hour * 60 + Number(parts.minute) + Number(parts.second) / 60,
  };
}

function gameDayClock(minute) {
  const total = Math.floor(minute);
  const hour = Math.floor(total / 60) % 24;
  return `${String(hour).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}${total >= 1440 ? " (+1d)" : ""}`;
}

function gameDaySessions(games, period, query = "") {
  const grouped = new Map();
  for (const game of games) {
    const { day, minute } = sydneyGameTime(game.start_time);
    if (period !== "all" && !day.startsWith(period)) continue;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push({ ...game, startMinute: minute, endMinute: minute + game.duration_ms / 60000 });
  }
  const search = query.trim().toLowerCase();
  return [...grouped].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => {
    rows.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time) || a.id.localeCompare(b.id));
    const breaks = [];
    let occupiedEnd = rows[0].endMinute;
    for (const game of rows.slice(1)) {
      if (game.startMinute - occupiedEnd >= LONG_BREAK_MINUTES) {
        breaks.push({ startMinute: occupiedEnd, endMinute: game.startMinute });
      }
      occupiedEnd = Math.max(occupiedEnd, game.endMinute);
    }
    return {
      day, games: rows, breaks, startMinute: rows[0].startMinute, endMinute: occupiedEnd,
    };
  }).filter(session => !search || session.day.includes(search) || session.games.some(game =>
    game.map.toLowerCase().includes(search)
    || [...game.kings, ...game.peasants].some(([, name]) => name.toLowerCase().includes(search))
  ));
}

function renderGameDays() {
  const sessions = gameDaySessions(state.data.games, state.period, el.search.value);
  if (!sessions.length) {
    el.gameDayRows.innerHTML = '<p class="empty">No results</p>';
    return;
  }
  const start = Math.floor(Math.min(...sessions.map(s => s.startMinute)) / 60) * 60;
  const end = Math.ceil(Math.max(...sessions.map(s => s.endMinute)) / 60) * 60;
  const span = Math.max(60, end - start);
  const position = minute => (minute - start) / span * 100;
  const width = (from, to) => (to - from) / span * 100;
  const ticks = [];
  for (let minute = start; minute <= start + span; minute += 60) {
    ticks.push(`<span style="left:${position(minute)}%">${gameDayClock(minute)}</span>`);
  }
  el.gameDayRows.innerHTML = sessions.map(session => {
    const bars = session.games.map((game, i) => {
      const winner = game.winner === "kings" ? "Kings" : "Peasants";
      const label = `${gameDayClock(game.startMinute)} - ${gameDayClock(game.endMinute)}: ${game.map}, ${minutes(game.duration_ms)}, ${winner} won`;
      const attributes = `class="day-game day-game-${game.winner === "kings" ? "kings" : "peasants"}"
        style="left:${position(game.startMinute)}%;width:${width(game.startMinute, game.endMinute)}%"
        title="${esc(label)}" aria-label="${esc(label)}"`;
      const localOnly = game.source?.type === "local" && !game.source.api_available;
      return localOnly
        ? `<span ${attributes} tabindex="0">${i + 1}. ${esc(game.map)}</span>`
        : `<a ${attributes} href="https://www.bar-rts.com/replays/${esc(game.id)}" target="_blank" rel="noopener">${i + 1}. ${esc(game.map)}</a>`;
    }).join("");
    const breaks = session.breaks.map(gap => {
      const label = `Break: ${gameDayClock(gap.startMinute)} - ${gameDayClock(gap.endMinute)} (${Math.round(gap.endMinute - gap.startMinute)} min). May include other activity.`;
      return `<span class="day-break" style="left:${position(gap.startMinute)}%;width:${width(gap.startMinute, gap.endMinute)}%"
        tabindex="0" title="${esc(label)}" aria-label="${esc(label)}">Break</span>`;
    }).join("");
    return `<article class="game-day-card">
      <header class="game-day-heading">
        <h3>${esc(session.day)}</h3>
        <span class="muted">${session.games.length} games · ${gameDayClock(session.startMinute)} - ${gameDayClock(session.endMinute)}</span>
      </header>
      <div class="day-timeline-scroll" tabindex="0" aria-label="${esc(session.day)} Sydney game timeline">
        <div class="day-timeline">
          <div class="day-axis">${ticks.join("")}</div>
          <div class="day-track">${breaks}${bars}</div>
        </div>
      </div>
      <details class="day-details"><summary>Game details</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Start (Sydney)</th><th>Map</th><th>Teams</th><th>Winner</th><th>Length</th><th>Replay</th></tr></thead>
          <tbody>${session.games.map(game => `<tr>
            <td>${gameDayClock(game.startMinute)}</td><td>${esc(game.map)}</td>
            <td>${game.kings.length} vs ${game.peasants.length}</td>
            <td>${game.winner === "kings" ? "Kings" : "Peasants"}</td>
            <td>${minutes(game.duration_ms)}</td><td>${replayLink(game)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </details>
    </article>`;
  }).join("");
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
  const points = [];
  const games = playerRatingScope().games;
  games.filter(g => state.period === "all" || g.start_time.startsWith(state.period)).forEach((g) => {
    const entry = g[role].find(([userId]) => userId === id);
    if (!entry) {
      return;
    }
    const score = entry[state.period === "all" ? 2 : 4];
    const change = Math.round(entry[state.period === "all" ? 3 : 5] / SCORE_SCALE * 100);
    const matchChange = Math.round(entry[6] / SCORE_SCALE * 100);
    const experienceChange = change - matchChange;
    const won = g.winner === role;
    wins += won;
    points.push({ time: g.start_time, score: displayScore(score) });
    rows.push(`<tr>
      <td>${formatDate(g.start_time)}</td>
      <td>${esc(g.map)}</td>
      <td>${won ? "Win" : "Loss"}</td>
      <td>${g.kings.length} vs ${g.peasants.length}</td>
      <td>${formatScore(score)}</td>
      ${changeCell(matchChange)}
      ${changeCell(experienceChange)}
      ${changeCell(change)}
      <td>${replayLink(g)}</td>
    </tr>`);
  });
  el.playerGamesTitle.textContent = `${name} - ${state.playerRole}${state.ratingMap ? ` · ${state.ratingMap}` : ""}: ${rows.length} games, ${wins} wins`;
  el.playerGameRows.innerHTML = rows.join("") || emptyRow(9);
  el.playerChart.innerHTML = scoreChart(points.reverse());
}

function changeCell(cents) {
  return `<td class="${cents > 0 ? "delta-up" : cents < 0 ? "delta-down" : ""}">${cents > 0 ? "+" : ""}${(cents / 100).toFixed(2)}</td>`;
}

function scoreChart(points) {
  if (points.length < 2) {
    return "";
  }
  const w = 800, h = 180, pad = { l: 44, r: 12, t: 12, b: 22 };
  const scores = points.map((p) => p.score);
  const lo = Math.floor(Math.min(...scores)), hi = Math.max(lo + 1, Math.ceil(Math.max(...scores)));
  const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  const dots = points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="2.5"><title>${formatDate(p.time)}: ${p.score.toFixed(2)}</title></circle>`)
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Score over time">
    <text x="4" y="${pad.t + 4}">${hi}</text><text x="4" y="${h - pad.b}">${lo}</text>
    <text x="${pad.l}" y="${h - 4}">${formatDate(points[0].time)}</text>
    <text x="${w - pad.r}" y="${h - 4}" text-anchor="end">${formatDate(points[points.length - 1].time)}</text>
    <polyline points="${line}" fill="none"/>${dots}</svg>`;
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

const replayLink = (game) =>
  game.source?.type === "local" && !game.source.api_available
    ? ""
    : `<a href="https://www.bar-rts.com/replays/${esc(game.id)}" target="_blank" rel="noopener">Watch</a>`;
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
