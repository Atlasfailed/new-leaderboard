function mapLabel(map) {
  return map.replace(/[\s_]+v?\d+(\.\d+)*$/i, "").replace(/_/g, " ");
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
