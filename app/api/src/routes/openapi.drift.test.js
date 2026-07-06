// Route <-> OpenAPI spec drift guard.
//
// `.spectral.yaml` lints the spec's SYNTAX. It cannot tell whether a documented
// operation still has a live route handler, nor whether a newly-added route in
// the documented surface got left out of the spec. This test closes that gap.
//
// The spec deliberately covers only the "ingest + crawler-admin" surface (see the
// Scope note in openapi.yaml) — NOT the 100+ read-API routes. So we scope the
// check to exactly the routers that back that surface, and keep an explicit
// allow-list of endpoints in those routers that are intentionally internal /
// undocumented (the web<->worker job protocol, delta-token CRUD, seed helpers).
//
// Enumeration is runtime introspection of each Router's `.stack` (Express 5
// exposes layer.route.path + layer.route.methods on a bare router) — robust
// against the computed `createIngestHandler(...)` registration that a static
// regex scan would miss.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yamljs';

import ingestRouter from './ingest.js';
import effectiveAccessRouter from './effectiveAccess.js';
import { adminCrawlersRouter, selfServiceCrawlersRouter } from './crawlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// The routers whose surface the spec is meant to document. Anything registered
// OUTSIDE these routers (jobs.js, crawlerFiles.js, the read API, …) is out of
// scope and correctly ignored.
const SCOPED_ROUTERS = [
  ingestRouter,
  selfServiceCrawlersRouter,
  adminCrawlersRouter,
  effectiveAccessRouter,
];

// Endpoints that live in the scoped routers but are DELIBERATELY not in the
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

// "METHOD /path" for every route registered on the scoped routers.
function registeredOps() {
  const ops = new Set();
  for (const router of SCOPED_ROUTERS) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const path = toOpenApiPath(layer.route.path);
      for (const m of HTTP_METHODS) {
        if (layer.route.methods[m]) ops.add(key(m, path));
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

describe('OpenAPI route <-> spec drift', () => {
  const registered = registeredOps();
  const documented = documentedOps();

  it('every documented operation maps to a live registered route', () => {
    const missing = [...documented].filter((op) => !registered.has(op)).sort();
    expect(
      missing,
      `openapi.yaml documents operations with no matching route handler ` +
      `(renamed or removed?):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every in-scope registered route is documented or explicitly allow-listed', () => {
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
