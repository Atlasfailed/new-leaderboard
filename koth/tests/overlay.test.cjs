const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = ["ratings.js", "overlay.js"]
  .map(file => readFileSync(`${__dirname}/../site/assets/${file}`, "utf8")).join("\n");
const cached = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.animations = 0;
  }
  append(child) { child.parent = this; this.children.push(child); }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.append(child)); }
  querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  animate() { this.animations++; }
}

function harness(search = "") {
  const elements = Object.fromEntries(["overlay", "scope", "kings", "peasants", "status"].map(id => [id, new Element()]));
  const errors = [];
  const intervals = [];
  const timeouts = new Map();
  const requests = [];
  let ready;
  let fetchImpl = async () => ({ ok: true, json: async () => plain(cached) });
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams, AbortController,
    document: {
      addEventListener: (_, listener) => { ready = listener; },
      getElementById: id => elements[id],
      createElement: () => new Element(),
    },
    window: { location: { search }, matchMedia: () => ({ matches: false }) },
    console: { error: (...args) => errors.push(args) },
    fetch: (...args) => { requests.push(args); return fetchImpl(...args); },
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
  };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test("default and explicit URL options; invalid layouts fail visibly", async () => {
  const h = harness();
  assert.deepEqual(plain(vm.runInContext('overlayOptions("")', h.context)),
    { layout: "side-by-side", period: null, map: null });
  assert.deepEqual(plain(vm.runInContext('overlayOptions("?layout=stacked&period=all&map=Raptor%20Crater")', h.context)),
    { layout: "stacked", period: "all", map: "Raptor Crater" });
  const bad = harness("?layout=typo");
  bad.start();
  await settled();
  assert.match(bad.elements.status.textContent, /Unknown layout/);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.requests.length, 0);
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

test("polling updates rows without replacing them, shows publication time and uses no-store", async () => {
  const h = harness("?layout=stacked");
  h.start();
  await settled();
  assert.ok(h.elements.overlay.classes.has("stacked"));
  assert.equal(h.intervals[0].delay, 60000);
  assert.equal(h.requests[0][0], "data/rankings.json");
  assert.equal(h.requests[0][1].cache, "no-store");
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
