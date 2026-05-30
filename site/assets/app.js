const state = {
  metadata: null,
  countries: [],
  playersByPeriod: {},
  nationsByPeriod: {},
  teamsByPeriod: {},
  efficiency: [],
  periods: [],
  playerMode: null,
  nationMode: null,
  teamMode: null,
  playerPeriod: "current",
  nationPeriod: "current",
  teamPeriod: "current",
};

const paths = {
  metadata: "data/metadata.json",
  countries: "data/countries.json",
  efficiency: "data/efficiency_analysis.json",
};

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindTabs();

  try {
    const [metadata, countries, efficiency] = await Promise.all([
      fetchJson(paths.metadata),
      fetchJson(paths.countries),
      fetchJson(paths.efficiency),
    ]);

    state.metadata = metadata;
    state.countries = countries.countries || [];
    state.efficiency = efficiency.units || [];
    state.periods = metadata.periods || [{ id: "current", label: "Current", description: "Last 30 days" }];

    initializeControls();
    await loadPeriodData(defaultPeriod());
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
    "playerPeriod",
    "nationPeriod",
    "teamPeriod",
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
  const modes = state.metadata?.modes?.length ? state.metadata.modes : ["Large Team", "Small Team", "Duel", "FFA"];
  state.playerMode = modes[0] || "Large Team";
  state.nationMode = modes[0] || "Large Team";
  state.teamMode = modes.find((mode) => mode.includes("Team")) || "Large Team";
  state.playerPeriod = defaultPeriod();
  state.nationPeriod = defaultPeriod();
  state.teamPeriod = defaultPeriod();

  renderModeButtons(elements.playerModes, modes, state.playerMode, (mode) => {
    state.playerMode = mode;
    renderPlayers();
  });
  renderModeButtons(elements.nationModes, modes, state.nationMode, (mode) => {
    state.nationMode = mode;
    renderNations();
  });
  renderModeButtons(elements.teamModes, modes.filter((mode) => mode.includes("Team")), state.teamMode, (mode) => {
    state.teamMode = mode;
    renderTeams();
  });
  renderPeriodSelect(elements.playerPeriod, state.playerPeriod, async (period) => {
    state.playerPeriod = period;
    showLoading(elements.playerRows, 7);
    await loadPeriodData(period);
    renderPlayers();
  });
  renderPeriodSelect(elements.nationPeriod, state.nationPeriod, async (period) => {
    state.nationPeriod = period;
    showLoading(elements.nationRows, 7);
    await loadPeriodData(period);
    renderNations();
  });
  renderPeriodSelect(elements.teamPeriod, state.teamPeriod, async (period) => {
    state.teamPeriod = period;
    showLoading(elements.teamRows, 7);
    await loadPeriodData(period);
    renderTeams();
  });

  elements.playerCountry.innerHTML = [
    `<option value="all">All countries</option>`,
    ...state.countries.map((country) => `<option value="${escapeHtml(country.code)}">${escapeHtml(country.name)}</option>`),
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
  const current = defaultPeriod();
  const counts = state.metadata?.recordCountsByPeriod || {};
  elements.sourceRange.textContent = `${formatDate(range.from)} to ${formatDate(range.to)}`;
  elements.statPlayers.textContent = formatNumber(counts.players?.[current] || 0);
  elements.statNations.textContent = formatNumber(counts.nations?.[current] || 0);
  elements.statTeams.textContent = formatNumber(counts.teams?.[current] || 0);
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

function renderPeriodSelect(select, activePeriod, onSelect) {
  select.innerHTML = state.periods
    .map((period) => {
      const label = period.id === "current" ? `${period.label} (${period.description})` : period.label;
      const selected = period.id === activePeriod ? " selected" : "";
      return `<option value="${escapeHtml(period.id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  select.addEventListener("change", () => onSelect(select.value));
}

async function loadPeriodData(period) {
  const files = state.metadata?.files || {};
  const completedFile = files.completed?.[period];
  if (completedFile && (!state.playersByPeriod[period] || !state.nationsByPeriod[period] || !state.teamsByPeriod[period])) {
    const payload = await fetchJson(`data/${completedFile}`);
    state.playersByPeriod[period] = payload.players || [];
    state.nationsByPeriod[period] = payload.nations || [];
    state.teamsByPeriod[period] = payload.teams || [];
    return;
  }

  const tasks = [];
  const playerFile = files.players?.[period];
  const nationFile = files.nations?.[period];
  const teamFile = files.teams?.[period];

  if (!state.playersByPeriod[period] && playerFile) {
    tasks.push(
      fetchJson(`data/${playerFile}`).then((payload) => {
        state.playersByPeriod[period] = payload.players || [];
      })
    );
  }
  if (!state.nationsByPeriod[period] && nationFile) {
    tasks.push(
      fetchJson(`data/${nationFile}`).then((payload) => {
        state.nationsByPeriod[period] = payload.nations || [];
      })
    );
  }
  if (!state.teamsByPeriod[period] && teamFile) {
    tasks.push(
      fetchJson(`data/${teamFile}`).then((payload) => {
        state.teamsByPeriod[period] = payload.teams || [];
      })
    );
  }

  await Promise.all(tasks);
}

function renderPlayers() {
  const country = elements.playerCountry.value;
  const query = elements.playerSearch.value.trim().toLowerCase();
  let rows = (state.playersByPeriod[state.playerPeriod] || []).filter((row) => row.game_mode === state.playerMode);

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
          const rank = country === "all" ? row.rank : row.country_rank || index + 1;
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
  let rows = (state.nationsByPeriod[state.nationPeriod] || []).filter((row) => row.game_mode === state.nationMode);
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
  let rows = (state.teamsByPeriod[state.teamPeriod] || []).filter((row) => row.game_mode === state.teamMode);
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

function showLoading(container, columns) {
  container.innerHTML = `<tr><td class="empty" colspan="${columns}">Loading...</td></tr>`;
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

function defaultPeriod() {
  return state.periods.some((period) => period.id === "current") ? "current" : state.periods[0]?.id || "current";
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
