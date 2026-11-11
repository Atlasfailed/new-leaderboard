const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { validateRankings, createRankingsLoader } = require("../site/assets/data.js");
const { publicationNeeded, publishRankings, verifyPublication, ensureDataProject, DATA_URL } = require("../pipeline/publish_rankings.cjs");

const clone = value => JSON.parse(JSON.stringify(value));
const full = JSON.parse(readFileSync(`${__dirname}/../site/data/rankings.json`, "utf8"));
const trimScope = scope => ({
  ...scope, games: scope.games.slice(0, 1),
  rankings: Object.fromEntries(Object.entries(scope.rankings).map(([role, periods]) =>
    [role, Object.fromEntries(Object.entries(periods).map(([id, rows]) => [id, rows.slice(0, 1)]))])),
});
const fixture = { ...trimScope(full), schemaVersion: 1,
  mapRankings: Object.fromEntries(Object.entries(full.mapRankings).map(([name, scope]) => [name, trimScope(scope)])),
};

function response(data, { etag = '"first"', status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ ETag: etag }),
    json: async () => clone(data),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

test("v1 contract accepts current generated data and the legacy local preview format", () => {
  assert.equal(validateRankings(full), full);
  assert.equal(validateRankings(fixture), fixture);
});

for (const [label, mutate] of [
  ["version", d => { d.schemaVersion = 2; }],
  ["date", d => { d.generatedAt = "bad"; }],
  ["periods", d => { d.periods = []; }],
  ["duplicate periods", d => { d.periods.push(d.periods[0]); }],
  ["missing role", d => { delete d.rankings.peasants; }],
  ["missing map data", d => { delete d.mapRankings.Throne.rankings; }],
  ["decay", d => { d.scoreDecay.halfLifeDays = 0; }],
  ["year experience", d => { d.rankings.kings["2026"][0].experience.rating = null; }],
  ["scores", d => { d.rankings.kings.all[0].score = "bad"; }],
  ["game roster", d => { d.games[0].kings[0] = [1, "Name"]; }],
  ["game timestamp", d => { d.games[0].start_time = null; }],
]) {
  test(`invalid ${label} is rejected before publication or display`, () => {
    const data = clone(fixture);
    mutate(data);
    assert.throws(() => validateRankings(data), /Invalid rankings/);
  });
}

test("loader uses native HTTP revalidation without cross-origin preflight headers", async t => {
  const requests = [];
  t.mock.method(global, "fetch", async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? response(fixture) : response(null, { status: 304 });
  });
  const load = createRankingsLoader();
  const first = await load();
  assert.equal(await load(), first);
  assert.equal(requests[0].url, "data/rankings.json");
  assert.equal(requests[0].options.cache, "no-cache");
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(requests[1].options.method, "HEAD");
  assert.equal(requests[1].options.headers, undefined);
});

test("a cache-revalidated 200 with the same ETag reuses the saved object without parsing it again", async t => {
  let next = response(fixture);
  t.mock.method(global, "fetch", async () => next);
  const load = createRankingsLoader();
  const first = await load();
  next = { ...response(null), json: async () => assert.fail("Unchanged response must not be reparsed") };
  assert.equal(await load(), first);
});

test("loader rejects bad/newer-schema/older publications without losing last-good data", async t => {
  let next = response(fixture);
  t.mock.method(global, "fetch", async () => next);
  const load = createRankingsLoader();
  const first = await load();
  for (const bad of [{ ...fixture, schemaVersion: 2 }, { ...fixture, generatedAt: "2000-01-01" }]) {
    next = response(bad, { etag: '"bad"' });
    await assert.rejects(load());
    next = response(null, { status: 304 });
    assert.equal(await load(), first);
  }
  next = response(null, { status: 503 });
  await assert.rejects(load(), /HTTP 503/);
  next = response(null, { status: 304 });
  assert.equal(await load(), first);
});

test("304 without cached data is an explicit error", async t => {
  t.mock.method(global, "fetch", async () => response(null, { status: 304 }));
  await assert.rejects(createRankingsLoader()(), /HTTP 304/);
});

test("publication comparison ignores generation time, but detects model, game and ranking changes", () => {
  const data = { ...clone(fixture), generatedAt: "2099-01-01T00:00:00Z" };
  assert.equal(publicationNeeded(data, fixture), false);
  for (const mutate of [
    d => { d.rankings.kings.all[0].name += " updated"; },
    d => { d.games[0].kings_handicap++; },
    d => { d.model.kNew++; },
  ]) {
    const changed = clone(data);
    mutate(changed);
    assert.equal(publicationNeeded(changed, fixture), true);
  }
  assert.throws(() => publicationNeeded(fixture, data), /newer publication/);
});

test("yearly decay and rank reordering alone do not consume a Pages deployment", () => {
  const current = clone(fixture);
  current.rankings.kings["2026"].push({
    ...clone(current.rankings.kings["2026"][0]), user_id: 999999, rank: 2,
  });
  const next = clone(current);
  next.generatedAt = "2099-01-01T00:00:00Z";
  next.rankings.kings["2026"].reverse();
  next.rankings.kings["2026"].forEach((row, i) => { row.score -= 3; row.rank = i + 1; });
  next.mapRankings.Throne.rankings.peasants["2026"][0].score -= 1;
  assert.equal(publicationNeeded(next, current), false);
  next.rankings.kings["2026"][0].experience.rating += 1;
  assert.equal(publicationNeeded(next, current), true);
});

test("unchanged data does not deploy even when the generation timestamp changes", async () => {
  const deployments = [];
  const result = await publishRankings({
    data: { ...fixture, generatedAt: "2099-01-01T00:00:00Z" },
    fetchData: async () => response(fixture), deploy: directory => deployments.push(directory),
  });
  assert.equal(result, false);
  assert.equal(deployments.length, 0);
});

test("changed data deploys current and previous snapshots together with CORS, cache and 404 rules", async () => {
  const data = clone(fixture);
  data.rankings.kings.all[0].name += " changed";
  const deployments = [];
  let verified = false;
  const result = await publishRankings({
    data, fetchData: async () => response(fixture),
    deploy: directory => deployments.push({
      directory,
      previous: JSON.parse(readFileSync(`${directory}/rankings/v1.previous.json`, "utf8")),
      current: JSON.parse(readFileSync(`${directory}/rankings/v1.json`, "utf8")),
      headers: readFileSync(`${directory}/_headers`, "utf8"),
      notFound: readFileSync(`${directory}/404.html`, "utf8"),
    }),
    verify: async incoming => { assert.deepEqual(incoming, data); verified = true; },
  });
  assert.equal(result, true);
  assert.equal(deployments.length, 1);
  assert.deepEqual(deployments[0].previous, fixture);
  assert.deepEqual(deployments[0].current, data);
  assert.match(deployments[0].headers, /Access-Control-Allow-Origin: \*/);
  assert.match(deployments[0].headers, /Access-Control-Expose-Headers: ETag/);
  assert.match(deployments[0].headers, /must-revalidate/);
  assert.match(deployments[0].notFound, /Data not found/);
  assert.ok(!existsSync(deployments[0].directory));
  assert.ok(verified);
});

test("failed data deployment does not claim success or run verification, and cleans temporary files", async () => {
  const data = clone(fixture);
  data.rankings.kings.all[0].name += " changed";
  const directories = [];
  await assert.rejects(publishRankings({
    data, fetchData: async () => response(fixture),
    deploy: directory => {
      directories.push(directory);
      throw new Error("Permission denied");
    },
    verify: async () => assert.fail("Must not verify a failed deployment"),
  }), /Permission denied/);
  assert.equal(directories.length, 1);
  assert.ok(directories.every(directory => !existsSync(directory)));
});

test("bootstrap reads the existing website and seeds the separate project even if bundled data is unchanged", async () => {
  const deployments = [];
  const urls = [];
  const legacy = clone(fixture);
  delete legacy.schemaVersion;
  const options = {
    data: fixture, fetchData: async url => { urls.push(url); return response(legacy); },
    deploy: directory => deployments.push(directory), verify: async () => {},
    ensureProject: async () => {},
  };
  await assert.rejects(publishRankings(options), /--bootstrap/);
  assert.equal(deployments.length, 0);
  await publishRankings({ ...options, bootstrap: true });
  assert.equal(deployments.length, 1);
  assert.equal(urls[0], DATA_URL);
  assert.equal(urls[1], "https://allreasonnologic-koth.pages.dev/data/rankings.json");
});

test("failed current-publication lookup and invalid incoming data never deploy", async () => {
  const options = { data: fixture, deploy: () => assert.fail("must not deploy") };
  await assert.rejects(publishRankings({ ...options, fetchData: async () => response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(publishRankings({ ...options, data: { ...fixture, schemaVersion: 2 } }), /schema version/);
});

test("the legacy URL redirects only rankings requests to the independent data project", () => {
  const redirects = readFileSync(`${__dirname}/../site/_redirects`, "utf8").trim();
  assert.equal(redirects, `/data/rankings.json ${DATA_URL} 302`);
});

test("oversized assets fail before any lookup or deployment", async () => {
  const data = { ...fixture, extra: "x".repeat(25 * 1024 * 1024) };
  await assert.rejects(publishRankings({
    data, fetchData: () => assert.fail("must not fetch"), deploy: () => assert.fail("must not deploy"),
  }), /25 MiB/);
});

test("published payload and browser headers are verified, with bounded retries for propagation", async () => {
  let attempts = 0;
  const waits = [];
  await verifyPublication(fixture, {
    fetchData: async () => {
      attempts++;
      const result = response(fixture);
      if (attempts === 1) {
        return result;
      }
      result.headers.set("Access-Control-Allow-Origin", "*");
      result.headers.set("Access-Control-Expose-Headers", "ETag, X-KOTH-Schema-Version");
      result.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      return result;
    },
    wait: async delay => waits.push(delay),
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2000]);
});

test("verification reports a persistent deployment mismatch rather than claiming success", async t => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  await assert.rejects(verifyPublication(fixture, {
    fetchData: async () => { attempts++; return response(null, { status: 503 }); },
    wait: async () => {},
  }), /HTTP 503/);
  assert.equal(attempts, 5);
});

test("bootstrap creates only the separate Pages project and never activates billing or R2", async () => {
  const requests = [];
  await ensureDataProject({
    accountId: "test-account", token: "test-token",
    fetchData: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1 ? response(null, { status: 404 }) : response({ success: true });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.cloudflare.com/client/v4/accounts/test-account/pages/projects/allreasonnologic-koth-data");
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    name: "allreasonnologic-koth-data", production_branch: "main",
  });
});

test("project setup uses an existing project and surfaces credential/permission failures", async () => {
  let requests = 0;
  await ensureDataProject({
    accountId: "test-account", token: "test-token",
    fetchData: async () => { requests++; return response({}); },
  });
  assert.equal(requests, 1);
  await assert.rejects(ensureDataProject({ accountId: "", token: "" }), /required/);
  await assert.rejects(ensureDataProject({
    accountId: "test-account", token: "test-token", fetchData: async () => response(null, { status: 403 }),
  }), /HTTP 403/);
});

function websiteHarness() {
  const source = ["data.js", "ratings.js", "app.js"]
    .map(file => readFileSync(`${__dirname}/../site/assets/${file}`, "utf8")).join("\n");
  const elements = {
    updated: {}, period: {}, leaderboardMap: {}, error: { hidden: true }, playerGames: { open: false },
    search: { value: "kept" },
  };
  let next = response(fixture);
  const intervals = [];
  const errors = [];
  const context = vm.createContext({
    document: { addEventListener() {}, querySelectorAll: () => [] }, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args), warn() {} },
    fetch: async () => next,
    window: { setInterval: (fn, delay) => intervals.push({ fn, delay }) },
  });
  vm.runInContext(source, context);
  context.elements = elements;
  vm.runInContext(`
    Object.assign(el, elements);
    let renderCount = 0, playerRenderCount = 0, modalRenderCount = 0;
    render = () => { renderCount++; };
    renderPlayers = () => { playerRenderCount++; };
    renderPlayerGames = () => { modalRenderCount++; };
  `, context);
  return { context, elements, errors, intervals, next: value => { next = value; } };
}

test("DOMContentLoaded starts polling once; changing year renders without starting a second poller", async () => {
  const elements = new Map();
  const element = () => ({
    value: "", listeners: {}, children: [], classList: { toggle() {} },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    appendChild(child) { this.children.push(child); },
    setAttribute() {}, removeAttribute() {},
  });
  let ready;
  let requests = 0;
  const intervals = [];
  const local = vm.createContext({
    document: {
      addEventListener: (name, callback) => { ready = callback; },
      getElementById: id => {
        if (!elements.has(id)) { elements.set(id, element()); }
        return elements.get(id);
      },
      querySelectorAll: () => [], createElement: element,
    },
    window: {
      location: { hostname: "localhost", hash: "#kings" }, addEventListener() {},
      setInterval: (fn, delay) => intervals.push({ fn, delay }),
    },
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console,
    fetch: async () => { requests++; return response(fixture); },
  });
  vm.runInContext(["data.js", "ratings.js", "app.js"]
    .map(file => readFileSync(`${__dirname}/../site/assets/${file}`, "utf8")).join("\n"), local);
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(intervals.length, 1);
  assert.equal(vm.runInContext("state.period", local), "2026");
  elements.get("period").value = "2025";
  elements.get("period").listeners.change();
  assert.equal(vm.runInContext("state.period", local), "2025");
  assert.equal(requests, 1);
  assert.equal(intervals.length, 1);
  assert.ok(elements.get("playerRows").innerHTML.includes("<tr>"));
});

test("website refresh preserves selected tab, period, map, sorting, search and open player", async () => {
  const h = websiteHarness();
  vm.runInContext("startSiteUpdates()", h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.intervals[0].delay, 60000);
  vm.runInContext(`
    state.mode = "Peasants"; state.period = "2025"; state.ratingMap = "Throne";
    state.sort = {key: "games", direction: "descending"};
    state.player = {id: 1, name: "Player"}; el.playerGames.open = true;
  `, h.context);
  h.next(response({ ...fixture, generatedAt: "2099-01-01T00:00:00Z" }, { etag: '"updated"' }));
  await h.intervals[0].fn();
  const selection = vm.runInContext("JSON.stringify([state.mode,state.period,state.ratingMap,state.sort,el.search.value,state.player])", h.context);
  assert.deepEqual(JSON.parse(selection), ["Peasants", "2025", "Throne",
    { key: "games", direction: "descending" }, "kept", { id: 1, name: "Player" }]);
  assert.equal(h.elements.period.value, "2025");
  assert.equal(vm.runInContext("modalRenderCount", h.context), 1);
  assert.equal(h.elements.error.hidden, true);
  h.next(response(null, { status: 304 }));
  await h.intervals[0].fn();
  assert.equal(vm.runInContext("renderCount", h.context), 2);
  assert.equal(vm.runInContext("playerRenderCount", h.context), 1);
});

test("website retries initial failures and retains last-good data on later failures", async () => {
  const h = websiteHarness();
  h.next(response(null, { status: 503 }));
  vm.runInContext("startSiteUpdates()", h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.error.hidden, false);
  assert.match(h.elements.error.textContent, /Retrying automatically/);
  assert.equal(vm.runInContext("state.data", h.context), null);
  h.next(response(fixture));
  await h.intervals[0].fn();
  assert.equal(h.elements.error.hidden, true);
  h.next(response({ ...fixture, schemaVersion: 2 }, { etag: '"invalid"' }));
  await h.intervals[0].fn();
  assert.equal(h.elements.error.hidden, false);
  assert.match(h.elements.error.textContent, /last loaded data/);
  assert.equal(vm.runInContext("state.data.schemaVersion", h.context), 1);
  assert.equal(h.errors.length, 2);
});
