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

// Endpoints that live in the DOCUMENTED routers but are DELIBERATELY not in the
// public spec — the web<->worker job-orchestration protocol, Graph delta-token
// persistence, and internal ingest/seed helpers. Adding a genuinely public
// endpoint here to silence the guard is a review red flag; document it instead.
const INTENTIONALLY_UNDOCUMENTED = new Set([
  // web<->worker job protocol (crawlers.js)
  'POST /crawlers/jobs/claim',
  'POST /crawlers/jobs/{id}/complete',
  'POST /crawlers/jobs/{id}/fail',
  'POST /crawlers/jobs/{id}/phases',
  'POST /crawlers/job-progress',
  'POST /crawlers/configs/{id}/mark-delta-mode',
  // Graph delta-token persistence (crawlers.js)
  'GET /crawlers/delta-tokens/{endpoint}',
  'PUT /crawlers/delta-tokens/{endpoint}',
  'DELETE /crawlers/delta-tokens/{endpoint}',
  // internal ingest / seed helpers (ingest.js)
  'POST /ingest/classify-business-role-assignments',
  'POST /ingest/context-members',
  'POST /ingest/matrix-default-filter',
  'POST /ingest/principal-activity',
  'POST /ingest/principals-presence',
  'POST /ingest/resource-assignments-identity',
  'POST /ingest/sync-log',
]);

// Express `:param` -> OpenAPI `{param}` so the two sides compare apples to apples.
const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const key = (method, path) => `${method.toUpperCase()} ${path}`;

// "METHOD /path" for every route registered on the documented routers.
function registeredOps() {
  const ops = new Set();
  for (const routers of Object.values(DOCUMENTED_ROUTERS)) {
    for (const router of routers) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const path = toOpenApiPath(layer.route.path);
        for (const m of HTTP_METHODS) {
          if (layer.route.methods[m]) ops.add(key(m, path));
        }
      }
    }
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
      .filter((op) => !documented.has(op) && !INTENTIONALLY_UNDOCUMENTED.has(op))
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
    const stale = [...INTENTIONALLY_UNDOCUMENTED]
      .filter((op) => !registered.has(op) || documented.has(op))
      .sort();
    expect(
      stale,
      `INTENTIONALLY_UNDOCUMENTED lists entries that are no longer ` +
      `undocumented registered routes:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
