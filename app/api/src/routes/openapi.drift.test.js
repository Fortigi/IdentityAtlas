// Route <-> OpenAPI spec drift guard.
//
// `.spectral.yaml` lints the spec's SYNTAX. It cannot tell whether a documented
// operation still has a live route handler, whether a newly-added route in the
// documented surface got left out of the spec, or whether a brand-new router was
// added that nobody decided to document. This test closes all three gaps.
//
// The spec deliberately covers only the "ingest + crawler-admin" surface (see the
// Scope note in openapi.yaml) — NOT the 100+ read-API routes. So rather than
// documenting everything, we require every router module under routes/ to be
// EXPLICITLY classified as either `documented` (its routes must be in the spec)
// or `undocumented` (read API / internal). A new router file that nobody
// classified fails the test — so a new public surface can't silently escape the
// drift guard, and the "documented vs not" decision is always a conscious one.
//
// Enumeration is runtime introspection of each Router's `.stack` (Express 5
// exposes layer.route.path + layer.route.methods on a bare router) — robust
// against the computed `createIngestHandler(...)` registration that a static
// regex scan would miss.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yamljs';

import ingestRouter from './ingest.js';
import effectiveAccessRouter from './effectiveAccess.js';
import { adminCrawlersRouter, selfServiceCrawlersRouter } from './crawlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Router modules whose surface the spec documents, keyed by filename so the
// classification below stays honest against the file tree. The value is the
// router(s) that file exports (crawlers.js exports two).
const DOCUMENTED_ROUTERS = {
  'ingest.js': [ingestRouter],
  'crawlers.js': [adminCrawlersRouter, selfServiceCrawlersRouter],
  'effectiveAccess.js': [effectiveAccessRouter],
};

// EVERY router module under routes/ must appear here. `documented` => all its
// routes must be in openapi.yaml (or the allow-list); `undocumented` => the read
// API / internal surface the public spec intentionally omits. Adding a router
// file without classifying it fails the completeness test below — the point is
// that "should this be in the public API spec?" is never answered by omission.
const DOCUMENTED = 'documented';
const UNDOCUMENTED = 'undocumented';
const ROUTER_CLASSIFICATION = {
  ...Object.fromEntries(Object.keys(DOCUMENTED_ROUTERS).map((f) => [f, DOCUMENTED])),
  // ── intentionally undocumented: read API, internal, worker job protocol ──
  'accountLinking.js': UNDOCUMENTED,
  'admin.js': UNDOCUMENTED,
  'authRoles.js': UNDOCUMENTED,
  'bulkLists.js': UNDOCUMENTED,
  'categories.js': UNDOCUMENTED,
  'contextPlugins.js': UNDOCUMENTED,
  'contexts.js': UNDOCUMENTED,
  'crawlerFiles.js': UNDOCUMENTED,
  'dataExport.js': UNDOCUMENTED,
  'details.js': UNDOCUMENTED,
  'governance.js': UNDOCUMENTED,
  'identities.js': UNDOCUMENTED,
  'jobs.js': UNDOCUMENTED,
  'llm.js': UNDOCUMENTED,
  'matrix.js': UNDOCUMENTED,
  'orgChart.js': UNDOCUMENTED,
  'perf.js': UNDOCUMENTED,
  'permissions.js': UNDOCUMENTED,
  'preferences.js': UNDOCUMENTED,
  'recentChanges.js': UNDOCUMENTED,
  'resources.js': UNDOCUMENTED,
  'riskProfiles.js': UNDOCUMENTED,
  'riskScores.js': UNDOCUMENTED,
  'riskScoringRuns.js': UNDOCUMENTED,
  'systems.js': UNDOCUMENTED,
  'tags.js': UNDOCUMENTED,
  'updates.js': UNDOCUMENTED,
};

// The bounded set of reasons an endpoint in a DOCUMENTED router may be absent
// from the public spec. Adding a NEW category is itself a visible, reviewed
// change — which is the point: it stops the allow-list from becoming a silent
// escape hatch for arbitrary public-looking routes.
const UNDOCUMENTED_REASONS = {
  'worker-protocol': 'web<->worker job-orchestration protocol (crawlers.js) — not a public API',
  'delta-token': 'Graph delta-token persistence (crawlers.js) — internal crawler state',
  'internal-ingest': 'internal computed/seed ingest helper (ingest.js) — not a public entity endpoint',
};

// Endpoints that live in the DOCUMENTED routers but are DELIBERATELY not in the
// public spec. Each MUST declare WHY, from UNDOCUMENTED_REASONS — so silencing
// the guard for a genuinely public endpoint requires mis-categorising it (a
// review red flag) rather than just appending a line.
const INTENTIONALLY_UNDOCUMENTED = {
  // web<->worker job protocol (crawlers.js)
  'POST /crawlers/jobs/claim': 'worker-protocol',
  'POST /crawlers/jobs/{id}/complete': 'worker-protocol',
  'POST /crawlers/jobs/{id}/fail': 'worker-protocol',
  'POST /crawlers/jobs/{id}/phases': 'worker-protocol',
  'POST /crawlers/job-progress': 'worker-protocol',
  'POST /crawlers/configs/{id}/mark-delta-mode': 'worker-protocol',
  // Graph delta-token persistence (crawlers.js)
  'GET /crawlers/delta-tokens/{endpoint}': 'delta-token',
  'PUT /crawlers/delta-tokens/{endpoint}': 'delta-token',
  'DELETE /crawlers/delta-tokens/{endpoint}': 'delta-token',
  // internal ingest / seed helpers (ingest.js)
  'POST /ingest/classify-business-role-assignments': 'internal-ingest',
  'POST /ingest/context-members': 'internal-ingest',
  'POST /ingest/matrix-default-filter': 'internal-ingest',
  'POST /ingest/principal-activity': 'internal-ingest',
  'POST /ingest/principals-presence': 'internal-ingest',
  'POST /ingest/principal-relationships': 'internal-ingest',
  'POST /ingest/resource-assignments-identity': 'internal-ingest',
  'POST /ingest/sync-log': 'internal-ingest',
};
const ALLOWLISTED_OPS = new Set(Object.keys(INTENTIONALLY_UNDOCUMENTED));

// Express `:param` -> OpenAPI `{param}` so the two sides compare apples to apples.
const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const key = (method, path) => `${method.toUpperCase()} ${path}`;

// Walk a router's layer stack, collecting "METHOD /path" for every route.
// Recurses into nested sub-routers so a barrel that composes focused routers via
// `router.use(subRouter)` (e.g. routes/ingest.js after its C1 split) is enumerated
// just like a router with its routes registered directly.
function collectRoutes(stack, ops) {
  for (const layer of stack) {
    if (layer.route) {
      const path = toOpenApiPath(layer.route.path);
      for (const m of HTTP_METHODS) {
        if (layer.route.methods[m]) ops.add(key(m, path));
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      collectRoutes(layer.handle.stack, ops);
    }
  }
}

// "METHOD /path" for every route registered on the documented routers.
function registeredOps() {
  const ops = new Set();
  for (const routers of Object.values(DOCUMENTED_ROUTERS)) {
    for (const router of routers) collectRoutes(router.stack, ops);
  }
  return ops;
}

// "METHOD /path" for every operation the spec documents.
function documentedOps() {
  const spec = YAML.parse(readFileSync(SPEC_PATH, 'utf8'));
  const ops = new Set();
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const m of HTTP_METHODS) {
      if (item[m]) ops.add(key(m, path));
    }
  }
  return ops;
}

// Every router module on disk (excludes tests and the non-router helpers).
function routerFilesOnDisk() {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && !/\.test\.js$/.test(f) && f !== 'openapi.drift.test.js');
}

describe('OpenAPI route <-> spec drift', () => {
  const registered = registeredOps();
  const documented = documentedOps();

  it('every router module is classified as documented or undocumented', () => {
    // Closes the "new public surface ships undocumented" gap: a router file
    // nobody classified fails here, forcing the documented-vs-not decision.
    const files = routerFilesOnDisk();
    const unclassified = files.filter((f) => !(f in ROUTER_CLASSIFICATION)).sort();
    expect(
      unclassified,
      `router module(s) under routes/ are not classified in openapi.drift.test.js. ` +
      `Add each as DOCUMENTED_ROUTERS (and put its routes in openapi.yaml) or mark it ` +
      `UNDOCUMENTED:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const stale = Object.keys(ROUTER_CLASSIFICATION).filter((f) => !files.includes(f)).sort();
    expect(
      stale,
      `ROUTER_CLASSIFICATION lists router file(s) that no longer exist:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every documented operation maps to a live registered route', () => {
    const missing = [...documented].filter((op) => !registered.has(op)).sort();
    expect(
      missing,
      `openapi.yaml documents operations with no matching route handler ` +
      `(renamed or removed?):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every route in the documented surface is documented or explicitly allow-listed', () => {
    const undocumented = [...registered]
      .filter((op) => !documented.has(op) && !ALLOWLISTED_OPS.has(op))
      .sort();
    expect(
      undocumented,
      `route(s) in the documented surface are missing from openapi.yaml. ` +
      `Add them to the spec, or (if intentionally internal) to ` +
      `INTENTIONALLY_UNDOCUMENTED:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    // Keeps the allow-list honest: if a route is deleted or later documented,
    // its allow-list entry must go too.
    const stale = [...ALLOWLISTED_OPS]
      .filter((op) => !registered.has(op) || documented.has(op))
      .sort();
    expect(
      stale,
      `INTENTIONALLY_UNDOCUMENTED lists entries that are no longer ` +
      `undocumented registered routes:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every allow-list entry declares a known internal reason', () => {
    // Bounds WHY an endpoint may be undocumented: an entry must be one of the
    // recognised internal surfaces (worker-protocol / delta-token / internal-
    // ingest), not an arbitrary public-looking route slipped in to silence the
    // guard. A genuinely new internal surface means a reviewed UNDOCUMENTED_REASONS
    // addition — deliberately a visible change, not a one-line append.
    const badReasons = Object.entries(INTENTIONALLY_UNDOCUMENTED)
      .filter(([, reason]) => !(reason in UNDOCUMENTED_REASONS))
      .map(([op, reason]) => `${op} -> '${reason}'`)
      .sort();
    expect(
      badReasons,
      `allow-list entry with an unknown reason. Use one of ` +
      `${Object.keys(UNDOCUMENTED_REASONS).join(', ')}, or document the route:\n${badReasons.join('\n')}`,
    ).toEqual([]);
  });
});
