const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = ["data.js", "ratings.js", "games.js", "overlay.js", "small-overlays.js"]
  .map(file => readFileSync(`${__dirname}/../site/assets/${file}`, "utf8")).join("\n");
const cached = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.animations = 0;
  }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.append(child)); }
  querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  animate() { this.animations++; }
}

function harness(search = "", map, mode) {
  const elements = Object.fromEntries(["overlay", "scope", "kings", "peasants", "status",
    "champions", "session-summary", "recap-games", "page-status"].map(id => [id, new Element()]));
  elements.overlay.dataset.map = map;
  elements.overlay.dataset.mode = mode;
  const errors = [];
  const intervals = [];
  const timeouts = new Map();
  const requests = [];
  let ready;
  let fetchImpl = async () => ({ ok: true, headers: new Headers(), json: async () => plain(cached) });
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams, AbortController, Headers,
    document: {
      addEventListener: (_, listener) => { ready = listener; },
      getElementById: id => elements[id],
      createElement: () => new Element(),
    },
    window: { location: { search }, matchMedia: () => ({ matches: false }) },
    console: { error: (...args) => errors.push(args) },
    fetch: async (...args) => {
      requests.push(args);
      return { headers: new Headers(), ...await fetchImpl(...args) };
    },
    setInterval: (fn, delay) => intervals.push({ fn, delay }),
    setTimeout: (fn, delay) => { timeouts.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(source, context);
  return {
    context, elements, errors, intervals, timeouts, requests,
    start: () => ready(),
    fetch: fn => { fetchImpl = fn; },
    view: (data = cached, options = {}, now = Date.parse("2026-11-11T12:00:00Z")) => {
      context.data = data; context.options = options; context.now = now;
      return plain(vm.runInContext("overlayView(data, options, now)", context));
    },
    render: view => { context.view = view; vm.runInContext("renderOverlay(view)", context); },
    smallView: (mode, data = cached, options = { layout: "side-by-side" }, now = Date.parse("2026-11-12T12:00:00Z")) => {
      context.data = data; context.options = options; context.now = now; context.mode = mode;
      return plain(vm.runInContext("smallOverlayView(data, options, mode, now)", context));
    },
    renderSmall: view => { context.view = view; vm.runInContext("renderSmallOverlay(view)", context); },
  };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test("default and explicit URL options; invalid layouts fail visibly", async () => {
  const h = harness();
  assert.deepEqual(plain(vm.runInContext('overlayOptions("")', h.context)),
    { layout: "side-by-side", period: null, map: null, scale: 1 });
  assert.deepEqual(plain(vm.runInContext('overlayOptions("?layout=stacked&period=all&map=Raptor%20Crater")', h.context)),
    { layout: "stacked", period: "all", map: "Raptor Crater", scale: 1 });
  const bad = harness("?layout=typo");
  bad.start();
  await settled();
  assert.match(bad.elements.status.textContent, /Unknown layout/);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.requests.length, 0);
});

test("render scale applies to every overlay mode without changing rankings or layout", async () => {
  for (const [map, mode] of [[undefined, undefined], ["Raptor Crater", undefined],
    ["Throne", undefined], ["Claymore", undefined], [undefined, "champions"], [undefined, "recap"]]) {
    for (const scale of [1, 1.5, 2, 4]) {
      const h = harness(`?scale=${scale}`, map, mode);
      h.start();
      await settled();
      assert.equal(h.elements.overlay.style.zoom, scale);
      assert.equal(h.errors.length, 0);
      assert.match(h.elements.status.textContent, /^Published /);
      assert.ok(!h.elements.overlay.classes.has("stacked"));
    }
  }
  const stacked = harness("?layout=stacked&period=all&scale=2", undefined, "champions");
  stacked.start();
  await settled();
  assert.equal(stacked.elements.overlay.style.zoom, 2);
  assert.ok(stacked.elements.overlay.classes.has("stacked"));
  assert.equal(stacked.elements.scope.textContent, "All time");
  const defaults = harness();
  defaults.start();
  assert.equal(defaults.elements.overlay.style.zoom, 1);
});

test("invalid render scales fail visibly before fetching rankings", () => {
  for (const scale of ["", "0", "-1", "0.5", "4.1", "NaN", "Infinity", "two"]) {
    const h = harness(`?scale=${scale}`);
    h.start();
    assert.match(h.elements.status.textContent, /Invalid scale/);
    assert.ok(h.elements.status.classes.has("warning"));
    assert.equal(h.errors.length, 1);
    assert.equal(h.requests.length, 0);
  }
});

test("top threes match website calculations for every map, role and published period", () => {
  const h = harness();
  const original = JSON.stringify(cached);
  for (const map of [null, ...Object.keys(cached.mapRankings)]) {
    for (const { id: period } of cached.periods) {
      const view = h.view(cached, { map, period });
      h.context.scope = map ? cached.mapRankings[map] : cached;
      for (const role of ["kings", "peasants"]) {
        h.context.role = role; h.context.period = period;
        const expected = plain(vm.runInContext("rankedPlayers(scope, role, period, now).slice(0, 3)", h.context));
        assert.deepEqual(view.players[role], expected);
        assert.ok(view.players[role].length <= 3);
      }
    }
  }
  assert.equal(JSON.stringify(cached), original);
  assert.equal(h.view().label, "2026 / All maps");
  assert.equal(h.view(cached, { map: "raptor crater", period: "all" }).label, "All time / Raptor Crater");
});

test("dedicated map pages load their own top threes without a map query", async () => {
  for (const [slug, map] of [["raptors", "Raptor Crater"], ["throne", "Throne"], ["claymore", "Claymore"]]) {
    const html = readFileSync(`${__dirname}/../site/overlay-${slug}.html`, "utf8");
    const pageMap = html.match(/data-map="([^"]+)"/)?.[1];
    assert.equal(pageMap, map);
    const h = harness("?period=all&layout=stacked", pageMap);
    h.start();
    await settled();
    const expected = h.view(cached, { map, period: "all" });
    assert.equal(h.elements.scope.textContent, expected.label);
    for (const role of ["kings", "peasants"]) {
      assert.deepEqual(h.elements[role].children.map(item => item.children[1].textContent),
        expected.players[role].map(row => row.name));
    }
    assert.ok(h.elements.overlay.classes.has("stacked"));
    assert.equal(h.errors.length, 0);
  }
});

test("dedicated map defaults retain the latest year and reject conflicting map queries visibly", async () => {
  const h = harness("", "Throne");
  h.start();
  await settled();
  assert.equal(h.elements.scope.textContent, "2026 / Throne");
  const bad = harness("?map=Claymore", "Throne");
  bad.start();
  assert.match(bad.elements.status.textContent, /This overlay is for Throne/);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.requests.length, 0);
});

test("unknown scope or malformed data is rejected instead of showing the wrong table", () => {
  const h = harness();
  assert.throws(() => h.view(cached, { period: "1900" }), /Unknown period/);
  assert.throws(() => h.view(cached, { map: "typo" }), /Unknown map/);
  assert.throws(() => h.view({ periods: [] }), /publication metadata/);
  const data = plain(cached);
  delete data.rankings.kings["2026"];
  assert.throws(() => h.view(data), /Missing kings/);
  data.rankings.kings["2026"] = [{ name: "Broken", score: NaN }];
  assert.throws(() => h.view(data), /Invalid kings/);
  data.rankings.kings.all = [{ user_id: 1, name: "Broken", score: NaN, rank: 1 }];
  assert.throws(() => h.view(data, { period: "all" }), /Invalid kings/);
});

test("yearly ties use games then case-insensitive name before assigning rank", () => {
  const h = harness();
  const data = plain(cached);
  const players = [["Zed", 4], ["bob", 5], ["Alice", 5], ["Other", 1]].map(([name, games], i) => ({
    user_id: i, name, games, starting_score: 800,
    experience: { inherited: 0, games: 30, year: 2026, rating: 1800 },
  }));
  data.rankings.kings["2026"] = players;
  const top = h.view(data).players.kings;
  assert.deepEqual(top.map(row => row.name), ["Alice", "bob", "Zed"]);
  assert.deepEqual(top.map(row => row.rank), [1, 2, 3]);
});

test("rendering safely handles names, empty lists and fewer than three players", () => {
  const h = harness();
  const view = h.view();
  view.players.kings = [{ user_id: 1, name: '<img src=x onerror="bad()">', rank: 1, score: 800 }];
  view.players.peasants = [];
  h.render(view);
  assert.equal(h.elements.kings.children.length, 1);
  assert.equal(h.elements.kings.children[0].children[1].textContent, '<img src=x onerror="bad()">');
  assert.equal(h.elements.kings.children[0].children[2].textContent, "16.67");
  assert.equal(h.elements.peasants.children[0].textContent, "No players this period");
  h.render(h.view());
  assert.equal(h.elements.kings.children.length, 3);
  assert.equal(h.elements.peasants.children.length, 3);
  h.render(view);
  assert.equal(h.elements.kings.children.length, 1);
});

test("unchanged rows do not animate and reduced-motion disables changed-row animation", () => {
  const h = harness();
  const view = h.view();
  h.render(view);
  const item = h.elements.kings.children[0];
  h.render(view);
  assert.equal(item.animations, 0);
  view.players.kings[0].score += 42;
  h.render(view);
  assert.equal(item.animations, 1);
  h.context.window.matchMedia = () => ({ matches: true });
  view.players.kings[0].score += 42;
  h.render(view);
  assert.equal(item.animations, 1);
});

test("polling updates rows without replacing them, shows publication time and revalidates the HTTP cache", async () => {
  const h = harness("?layout=stacked");
  h.start();
  await settled();
  assert.ok(h.elements.overlay.classes.has("stacked"));
  assert.equal(h.intervals[0].delay, 60000);
  assert.equal(h.requests[0][0], "data/rankings.json");
  assert.equal(h.requests[0][1].cache, "no-cache");
  assert.equal(h.timeouts.size, 0);
  assert.match(h.elements.status.textContent, /^Published .* UTC$/);
  assert.match(h.elements.status.textContent, /2026-11-03/);
  const item = h.elements.kings.children[0];
  const updated = plain(cached);
  updated.rankings.kings["2026"][0].name = "New name";
  h.fetch(async () => ({ ok: true, json: async () => updated }));
  await h.intervals[0].fn();
  assert.equal(h.elements.kings.children[0], item);
  assert.equal(item.children[1].textContent, "New name");
});

for (const failure of ["network", "http", "json", "invalid"]) {
  test(`${failure} refresh failure preserves rankings, logs a warning, and recovers`, async () => {
    const h = harness();
    h.start();
    await settled();
    const before = h.elements.kings.children.map(item => item.children[1].textContent);
    h.fetch(async () => {
      if (failure === "network") { throw new Error("Offline"); }
      if (failure === "http") { return { ok: false, status: 503 }; }
      if (failure === "json") { return { ok: true, json: async () => { throw new SyntaxError("Bad JSON"); } }; }
      const invalid = plain(cached);
      invalid.rankings.kings["2026"][0].experience.rating = null;
      invalid.rankings.peasants["2026"][0].experience.rating = "bad";
      return { ok: true, json: async () => invalid };
    });
    await h.intervals[0].fn();
    assert.deepEqual(h.elements.kings.children.map(item => item.children[1].textContent), before);
    assert.match(h.elements.status.textContent, /showing saved rankings/);
    assert.ok(h.elements.status.classes.has("warning"));
    assert.equal(h.errors.length, 1);
    h.fetch(async () => ({ ok: true, json: async () => plain(cached) }));
    await h.intervals[0].fn();
    assert.match(h.elements.status.textContent, /^Published /);
    assert.ok(!h.elements.status.classes.has("warning"));
  });
}

test("initial failure remains visible and the next poll recovers", async () => {
  const h = harness();
  h.fetch(async () => { throw new Error("Offline"); });
  h.start();
  await settled();
  assert.match(h.elements.status.textContent, /Rankings unavailable: Offline/);
  assert.equal(h.elements.kings.children.length, 0);
  h.fetch(async () => ({ ok: true, json: async () => plain(cached) }));
  await h.intervals[0].fn();
  assert.equal(h.elements.kings.children.length, 3);
});

test("hung requests time out after ten seconds and concurrent polls are skipped", async () => {
  const h = harness();
  h.fetch((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Timed out")));
  }));
  h.start();
  await h.intervals[0].fn();
  assert.equal(h.requests.length, 1);
  const timeout = [...h.timeouts.values()][0];
  assert.equal(timeout.delay, 10000);
  timeout.fn();
  await settled();
  assert.match(h.elements.status.textContent, /Timed out/);
  assert.equal(h.timeouts.size, 0);
  h.fetch(async () => ({ ok: true, json: async () => plain(cached) }));
  await h.intervals[0].fn();
  assert.equal(h.elements.kings.children.length, 3);
});

test("champions show the website's leading player and Score for each map and period", async () => {
  const h = harness("?period=all", undefined, "champions");
  for (const { id: period } of cached.periods) {
    const view = h.smallView("champions", cached, { period });
    assert.equal(view.maps.length, 3);
    for (const map of view.maps) {
      const expected = h.view(cached, { period, map: map.name }, Date.parse("2026-11-12T12:00:00Z"));
      for (const role of ["kings", "peasants"]) {
        assert.deepEqual(map.players[role][0], expected.players[role][0]);
      }
    }
  }
  h.start();
  await settled();
  assert.equal(h.elements.champions.children.length, 3);
  assert.equal(h.elements.scope.textContent, "All time");
  assert.match(h.elements.status.textContent, /^Published/);
  const data = plain(cached);
  data.mapRankings.Throne.rankings.kings.all = [];
  h.renderSmall(h.smallView("champions", data, { period: "all" }));
  assert.equal(h.elements.champions.children[1].children[1].children[1].textContent, "No players");
  assert.throws(() => h.smallView("champions", cached, { period: "1900" }), /Unknown period/);
  assert.throws(() => h.smallView("champions", cached, { map: "Throne" }), /cover all maps/);
});

function recapData(games) {
  return { generatedAt: cached.generatedAt, games: games.map(([id, start_time, winner = "kings"]) => ({
    ...plain(cached.games[0]), id, start_time, winner,
  })) };
}

test("recap selects the latest completed Sunday, includes Monday morning, and excludes other sessions", () => {
  const h = harness();
  const data = recapData([
    ["future", "2026-11-15T04:00:00Z"],
    ["monday", "2026-11-08T14:00:00Z", "peasants"],
    ["saturday", "2026-11-07T04:00:00Z"],
    ["old", "2026-11-01T04:00:00Z"],
    ["sunday", "2026-11-08T04:00:00Z"],
    ["monday-noon", "2026-11-09T01:00:00Z"],
  ]);
  const view = h.smallView("recap", data);
  assert.equal(view.session, "2026-11-08");
  assert.deepEqual(view.games.map(game => game.id), ["sunday", "monday"]);
  assert.equal(view.kingsWins, 1);
  assert.equal(view.peasantsWins, 1);
  assert.equal(h.smallView("recap", data, { layout: "side-by-side" },
    Date.parse("2026-11-09T00:59:59Z")).session, "2026-11-01");
  assert.equal(h.smallView("recap", data, { layout: "side-by-side" },
    Date.parse("2026-11-09T01:00:00Z")).session, "2026-11-08");
  const winter = recapData([["winter", "2026-07-05T04:00:00Z"]]);
  assert.equal(h.smallView("recap", winter, { layout: "side-by-side" },
    Date.parse("2026-07-06T01:59:59Z")).session, null);
  assert.equal(h.smallView("recap", winter, { layout: "side-by-side" },
    Date.parse("2026-07-06T02:00:00Z")).session, "2026-07-05");
  assert.throws(() => h.smallView("recap", data, { period: "all" }), /own session date/);
});

test("recap safely renders map, winner, team sizes and mm:ss; pagination includes every game", () => {
  const h = harness();
  const data = recapData(Array.from({ length: 7 }, (_, i) => [
    String(i), `2026-11-08T04:${String(i).padStart(2, "0")}:00Z`, i % 2 ? "peasants" : "kings",
  ]));
  data.games[0].map = "<img src=x onerror=bad()>";
  data.games[0].duration_ms = 1965600;
  const view = h.smallView("recap", data);
  h.renderSmall(view);
  const list = h.elements["recap-games"];
  assert.equal(list.children.length, 5);
  assert.deepEqual(list.children[0].children.map(child => child.textContent),
    ["01", "<img src=x onerror=bad()>", "Kings", "9 vs 83", "32:45"]);
  assert.match(h.elements["session-summary"].textContent, /7 games \/ Kings 4 wins \/ Peasants 3 wins/);
  const timer = h.intervals.find(timer => timer.delay === 12000);
  timer.fn();
  assert.deepEqual(list.children.map(row => row.children[0].textContent), ["06", "07"]);
  h.renderSmall(view);
  assert.match(h.elements["page-status"].textContent, /page 2\/2/);
  assert.equal(h.intervals.filter(timer => timer.delay === 12000).length, 1);
  timer.fn();
  assert.deepEqual(list.children.map(row => row.children[0].textContent), ["01", "02", "03", "04", "05"]);
  h.renderSmall(h.smallView("recap", recapData([])));
  assert.match(list.children[0].textContent, /No completed Sunday games/);
});

for (const mode of ["champions", "recap"]) {
  test(`${mode} uses shared polling, preserves saved content on failure, and recovers`, async () => {
    const h = harness("", undefined, mode);
    h.start();
    await settled();
    assert.equal(h.errors.length, 0);
    const container = h.elements[mode === "champions" ? "champions" : "recap-games"];
    const before = container.children.length;
    h.fetch(async () => { throw new Error("Offline"); });
    await h.intervals.find(timer => timer.delay === 60000).fn();
    assert.equal(container.children.length, before);
    assert.match(h.elements.status.textContent, /showing saved rankings/);
    h.fetch(async () => ({ ok: true, json: async () => plain(cached) }));
    await h.intervals.find(timer => timer.delay === 60000).fn();
    assert.match(h.elements.status.textContent, /^Published/);
  });
}
