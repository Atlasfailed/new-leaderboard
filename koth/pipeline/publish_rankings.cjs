const { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { spawnSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { validateRankings } = require("../site/assets/data.js");

const DATA_URL = "https://allreasonnologic-koth-data.pages.dev/rankings/v1.json";
const LEGACY_URL = "https://allreasonnologic-koth.pages.dev/data/rankings.json";
const PROJECT = "allreasonnologic-koth-data";
const DATA_HEADERS = `/rankings/*
  Access-Control-Allow-Origin: *
  Access-Control-Expose-Headers: ETag, X-KOTH-Schema-Version
  Cache-Control: public, max-age=0, must-revalidate
  X-Content-Type-Options: nosniff
  X-KOTH-Schema-Version: 1
`;

function publicationNeeded(incoming, current) {
  validateRankings(incoming);
  validateRankings(current);
  if (Date.parse(incoming.generatedAt) < Date.parse(current.generatedAt)) {
    throw new Error("Refusing to overwrite a newer publication.");
  }
  return !isDeepStrictEqual(
    publicationContent(JSON.parse(JSON.stringify(incoming))),
    publicationContent(JSON.parse(JSON.stringify(current))),
  );
}

function publicationContent(data) {
  const normalizeScope = scope => ({
    ...scope,
    rankings: Object.fromEntries(Object.entries(scope.rankings).map(([role, periods]) => [
      role, Object.fromEntries(Object.entries(periods).map(([period, rows]) => [
        period, period === "all" ? rows : rows.map(({ score, rank, year_change, ...row }) => row)
          .sort((a, b) => a.user_id - b.user_id),
      ])),
    ])),
  });
  // Browsers recompute yearly scores/ranks from experience; time alone must not use a deployment.
  const { generatedAt, schemaVersion, ...content } = data;
  return {
    ...normalizeScope(content),
    mapRankings: Object.fromEntries(Object.entries(data.mapRankings).map(([map, scope]) => [map, normalizeScope(scope)])),
  };
}

async function publishRankings({
  data = JSON.parse(readFileSync("site/data/rankings.json", "utf8")),
  bootstrap = false, fetchData = fetch, deploy = deployData, verify = verifyPublication,
  ensureProject = ensureDataProject,
} = {}) {
  const serialized = JSON.stringify({ ...validateRankings(data), schemaVersion: 1 });
  const incoming = JSON.parse(serialized);
  if (Buffer.byteLength(serialized) > 25 * 1024 * 1024) {
    throw new Error("Rankings exceed Cloudflare Pages' 25 MiB per-file limit.");
  }
  const response = await fetchData(bootstrap ? LEGACY_URL : DATA_URL, {
    cache: "no-cache", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Cannot read current publication: HTTP ${response.status}`);
  }
  const current = validateRankings(await response.json());
  if (!bootstrap && current.schemaVersion !== 1) {
    throw new Error("Data project must serve schema v1. Run the initial publication with --bootstrap before switching the website.");
  }
  const changed = publicationNeeded(incoming, current);
  if (!changed && current.schemaVersion === 1) {
    console.log("Rankings unchanged; no data deployment.");
    return false;
  }
  if (bootstrap) {
    await ensureProject();
  }
  const directory = mkdtempSync(join(tmpdir(), "koth-publish-"));
  try {
    mkdirSync(join(directory, "rankings"));
    writeFileSync(join(directory, "rankings/v1.previous.json"), JSON.stringify(current));
    writeFileSync(join(directory, "rankings/v1.json"), serialized);
    writeFileSync(join(directory, "_headers"), DATA_HEADERS);
    writeFileSync(join(directory, "404.html"), "<!doctype html><title>Not found</title><h1>Data not found</h1>");
    await deploy(directory);
    await verify(incoming);
    console.log(`Published and verified schema v1 rankings generated at ${incoming.generatedAt}.`);
    return true;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

async function ensureDataProject({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetchData = fetch,
} = {}) {
  if (!accountId || !token) {
    throw new Error("Cloudflare account ID and API token are required to create the data project.");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const existing = await fetchData(`${url}/${PROJECT}`, { headers, signal: AbortSignal.timeout(30000) });
  if (existing.ok) {
    return;
  }
  if (existing.status !== 404) {
    throw new Error(`Cannot check data project: HTTP ${existing.status}`);
  }
  const created = await fetchData(url, {
    method: "POST", headers, body: JSON.stringify({ name: PROJECT, production_branch: "main" }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await created.json();
  if (!created.ok || result.success !== true) {
    throw new Error(`Cannot create data project: HTTP ${created.status}`);
  }
  console.log(`Created Cloudflare Pages project ${PROJECT}.`);
}

function deployData(directory) {
  const result = spawnSync(process.execPath, [
    join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
    "pages", "deploy", directory, `--project-name=${PROJECT}`, "--branch=main", "--commit-dirty=true",
  ], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Data deployment failed (exit ${result.status}).`);
  }
}

async function verifyPublication(incoming, {
  fetchData = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const url = `${DATA_URL}?publication=${encodeURIComponent(incoming.generatedAt)}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetchData(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
      if (!response.ok || response.headers.get("Access-Control-Allow-Origin") !== "*"
        || !response.headers.get("ETag")
        || !response.headers.get("Access-Control-Expose-Headers")?.toLowerCase().includes("etag")
        || !response.headers.get("Cache-Control")?.includes("must-revalidate")) {
        throw new Error(`Invalid data response or missing browser/cache headers (HTTP ${response.status}).`);
      }
      const published = validateRankings(await response.json());
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(incoming)), published)) {
        throw new Error("Public data does not yet match the new publication.");
      }
      return;
    } catch (error) {
      console.warn(`Data verification attempt ${attempt}/5 failed: ${error.message}`);
      if (attempt === 5) {
        throw error;
      }
      await wait(2000);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--bootstrap")) {
    console.error("Usage: npm run publish-data -- [--bootstrap]");
    process.exitCode = 1;
  } else {
    publishRankings({ bootstrap: args.includes("--bootstrap") }).catch(error => {
      console.error("KOTH data publication failed:", error);
      process.exitCode = 1;
    });
  }
}

module.exports = { publicationNeeded, publishRankings, verifyPublication, ensureDataProject, DATA_URL };
