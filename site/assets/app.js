const state = {
  metadata: null,
  countries: [],
  players: [],
  nations: [],
  teams: [],
  efficiency: [],
  playerMode: null,
  nationMode: null,
  teamMode: null,
};

const paths = {
  metadata: "data/metadata.json",
  countries: "data/countries.json",
  players: "data/player_rankings.json",
  nations: "data/nation_rankings.json",
  teams: "data/team_rankings.json",
  efficiency: "data/efficiency_analysis.json",
};

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindTabs();

  try {
    const [metadata, countries, players, nations, teams, efficiency] = await Promise.all([
      fetchJson(paths.metadata),
      fetchJson(paths.countries),
      fetchJson(paths.players),
      fetchJson(paths.nations),
      fetchJson(paths.teams),
      fetchJson(paths.efficiency),
    ]);

    state.metadata = metadata;
    state.countries = countries.countries || [];
    state.players = players.players || [];
    state.nations = nations.nations || [];
    state.teams = teams.teams || [];
    state.efficiency = efficiency.units || [];

    initializeControls();
    renderSummary();
    renderAll();
  } catch (error) {
    showError("Data files are missing or invalid. Run the data pipeline before previewing the site.");
    console.error(error);
  }
}

function bindElements() {
  [
    "sourceRange",
    "statPlayers",
    "statNations",
    "statTeams",
    "statUpdated",
    "appError",
    "playerModes",
    "nationModes",
    "teamModes",
    "playerCountry",
    "playerSearch",
    "nationSearch",
    "teamSearch",
    "playerRows",
    "nationRows",
    "teamRows",
    "efficiencyFaction",
    "efficiencySpeed",
    "efficiencySpeedValue",
    "efficiencyMetric",
    "efficiencyRows",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      document.querySelectorAll(".tab").forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });
      document.querySelectorAll(".view").forEach((section) => {
        const active = section.id === `view-${view}`;
        section.classList.toggle("active", active);
        section.hidden = !active;
      });
    });
  });
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

function initializeControls() {
  const modes = state.metadata?.modes?.length ? state.metadata.modes : unique(state.players.map((row) => row.game_mode));
  state.playerMode = modes[0] || "Large Team";
  state.nationMode = modes[0] || "Large Team";
  state.teamMode = state.teams[0]?.game_mode || modes.find((mode) => mode.includes("Team")) || "Large Team";

  renderModeButtons(elements.playerModes, modes, state.playerMode, (mode) => {
    state.playerMode = mode;
    renderPlayers();
  });
  renderModeButtons(elements.nationModes, modes, state.nationMode, (mode) => {
    state.nationMode = mode;
    renderNations();
  });
  renderModeButtons(elements.teamModes, unique(state.teams.map((row) => row.game_mode)), state.teamMode, (mode) => {
    state.teamMode = mode;
    renderTeams();
  });

  const playerCountries = unique(state.players.map((row) => row.country).filter(Boolean)).sort();
  elements.playerCountry.innerHTML = [
    `<option value="all">All countries</option>`,
    ...playerCountries.map((code) => {
      const country = state.countries.find((item) => item.code === code);
      return `<option value="${escapeHtml(code)}">${escapeHtml(country?.name || code)}</option>`;
    }),
  ].join("");

  elements.playerCountry.addEventListener("change", renderPlayers);
  elements.playerSearch.addEventListener("input", debounce(renderPlayers, 120));
  elements.nationSearch.addEventListener("input", debounce(renderNations, 120));
  elements.teamSearch.addEventListener("input", debounce(renderTeams, 120));
  elements.efficiencyFaction.addEventListener("change", renderEfficiency);
  elements.efficiencyMetric.addEventListener("change", renderEfficiency);
  elements.efficiencySpeed.addEventListener("input", () => {
    elements.efficiencySpeedValue.value = elements.efficiencySpeed.value;
    renderEfficiency();
  });
}

function renderSummary() {
  const range = state.metadata?.sourceDateRange || {};
  elements.sourceRange.textContent = `${formatDate(range.from)} to ${formatDate(range.to)}`;
  elements.statPlayers.textContent = formatNumber(state.players.length);
  elements.statNations.textContent = formatNumber(state.nations.length);
  elements.statTeams.textContent = formatNumber(state.teams.length);
  elements.statUpdated.textContent = formatDateTime(state.metadata?.generatedAt);
}

function renderAll() {
  renderPlayers();
  renderNations();
  renderTeams();
  renderEfficiency();
}

function renderModeButtons(container, modes, activeMode, onSelect) {
  container.innerHTML = "";
  modes.forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-button${mode === activeMode ? " active" : ""}`;
    button.textContent = mode;
    button.addEventListener("click", () => {
      container.querySelectorAll(".mode-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      onSelect(mode);
    });
    container.appendChild(button);
  });
}

function renderPlayers() {
  const country = elements.playerCountry.value;
  const query = elements.playerSearch.value.trim().toLowerCase();
  let rows = state.players.filter((row) => row.game_mode === state.playerMode);

  if (country && country !== "all") {
    rows = rows.filter((row) => row.country === country).sort((a, b) => b.rating - a.rating);
  }
  if (query) {
    rows = rows.filter((row) => `${row.name} ${row.country_name} ${row.country}`.toLowerCase().includes(query));
  }

  const limited = rows.slice(0, 150);
  elements.playerRows.innerHTML = limited.length
    ? limited
        .map((row, index) => {
          const rank = country === "all" ? row.rank : index + 1;
          return `<tr>
            <td>${formatNumber(rank)}</td>
            <td class="name-cell">${escapeHtml(row.name)}</td>
            <td><span class="pill">${escapeHtml(row.country || "-")}</span> <span class="muted">${escapeHtml(row.country_name || "")}</span></td>
            <td>${formatDecimal(row.rating, 2)}</td>
            <td>${formatNumber(row.games)}</td>
            <td>${formatPercent(row.win_rate)}</td>
            <td>${formatDate(row.last_played)}</td>
          </tr>`;
        })
        .join("")
    : emptyRow(7);
}

function renderNations() {
  const query = elements.nationSearch.value.trim().toLowerCase();
  let rows = state.nations.filter((row) => row.game_mode === state.nationMode);
  if (query) {
    rows = rows.filter((row) => `${row.country_name} ${row.country}`.toLowerCase().includes(query));
  }

  elements.nationRows.innerHTML = rows.length
    ? rows
        .slice(0, 120)
        .map((row) => `<tr>
          <td>${formatNumber(row.rank)}</td>
          <td class="name-cell">${escapeHtml(row.country_name || row.country)} <span class="pill">${escapeHtml(row.country)}</span></td>
          <td>${formatNumber(row.adjusted_score)}</td>
          <td>${formatDecimal(row.avg_rating, 2)}</td>
          <td>${formatNumber(row.player_count)}</td>
          <td>${formatNumber(row.total_games)}</td>
          <td>${formatContributors(row.top_contributors)}</td>
        </tr>`)
        .join("")
    : emptyRow(7);
}

function renderTeams() {
  const query = elements.teamSearch.value.trim().toLowerCase();
  let rows = state.teams.filter((row) => row.game_mode === state.teamMode);
  if (query) {
    rows = rows.filter((row) => rosterText(row.roster).toLowerCase().includes(query));
  }

  elements.teamRows.innerHTML = rows.length
    ? rows
        .slice(0, 150)
        .map((row) => `<tr>
          <td>${formatNumber(row.rank)}</td>
          <td class="name-cell">${formatRoster(row.roster)}</td>
          <td>${escapeHtml(row.game_mode)}</td>
          <td>${formatNumber(row.score)}</td>
          <td>${formatNumber(row.games)}</td>
          <td>${formatDecimal(row.avg_rating, 2)}</td>
          <td>${escapeHtml(row.top_map || "-")}</td>
        </tr>`)
        .join("")
    : emptyRow(7);
}

function renderEfficiency() {
  const faction = elements.efficiencyFaction.value;
  const speed = Number(elements.efficiencySpeed.value);
  const metric = elements.efficiencyMetric.value;
  const rows = state.efficiency
    .filter((row) => row.faction === faction && Number(row.wind_tidal_speed) === speed)
    .sort((left, right) => Number(right[metric] || 0) - Number(left[metric] || 0));

  elements.efficiencyRows.innerHTML = rows.length
    ? rows
        .map((row, index) => `<tr>
          <td>${index + 1}</td>
          <td class="name-cell">${escapeHtml(row.display_name)}</td>
          <td>${formatDecimal(row.energy_output, 1)}</td>
          <td>${formatDecimal(row.metalcost, 0)}</td>
          <td>${formatNumber(row.buildtime)}</td>
          <td>${formatDecimal(row.metal_efficiency, 4)}</td>
          <td>${formatDecimal(row.time_efficiency, 4)}</td>
        </tr>`)
        .join("")
    : emptyRow(7);
}

function formatRoster(roster) {
  return (roster || [])
    .map((player) => `${escapeHtml(player.name)} <span class="muted">${escapeHtml(player.countryCode || "")}</span>`)
    .join(" / ");
}

function rosterText(roster) {
  return (roster || []).map((player) => `${player.name} ${player.countryCode}`).join(" ");
}

function formatContributors(contributors) {
  if (!contributors || contributors.length === 0) {
    return `<span class="muted">-</span>`;
  }
  return contributors.map((item) => `${escapeHtml(item.name)} <span class="muted">${formatDecimal(item.score, 2)}</span>`).join(", ");
}

function emptyRow(columns) {
  return `<tr><td class="empty" colspan="${columns}">No records</td></tr>`;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return new Intl.NumberFormat().format(Number(value));
}

function formatDecimal(value, digits) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}

function showError(message) {
  elements.appError.textContent = message;
  elements.appError.hidden = false;
}
