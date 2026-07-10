// Route <-> OpenAPI spec drift guard.
//
// `.spectral.yaml` lints the spec's SYNTAX. It cannot tell whether a documented
// operation still has a live route handler, whether a newly-added route in the
// documented surface got left out of the spec, or whether a brand-new router was
// added that nobody decided to document. This test closes all three gaps.
//
// The spec deliberately covers only the "ingest + crawler-admin + effective-
// access" surface (see the Scope note in openapi.yaml) — NOT the 100+ read-API
// routes. So every router module under routes/ is classified as either
// `documented` (its routes must be in the spec) or `undocumented` (read API /
// internal).
//
// The DOCUMENTED set is DERIVED, not hand-maintained: we import every router
// module, enumerate its routes, and treat a module as documented iff at least one
// of its routes appears in openapi.yaml. So the documented classification tracks
// the spec automatically and can't drift out of sync with it — document a
// module's route and that module becomes documented; stop and it doesn't. The
// UNDOCUMENTED set stays an explicit allow-list (below): a new router file that
// is neither spec-documented nor listed there fails the completeness test, so a
// new public surface can't silently escape the guard and the "should this be in
// the public API?" decision is still a conscious one.
//
// Enumeration is runtime introspection of each Router's `.stack` (Express 5
// exposes layer.route.path + layer.route.methods on a bare router), recursing
// into sub-routers a barrel controller mounts with `router.use(...)` — robust
// against the computed `createIngestHandler(...)` registration a static regex
// scan would miss.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import YAML from 'yamljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Router modules the public spec intentionally OMITS — the read API, internal
// worker/job protocol, and admin surfaces. Every router file that isn't derived
// as documented (has no route in openapi.yaml) MUST be listed here; a new file
// that is neither documented nor listed fails the completeness test below. This
// is the one place the "should this be in the public API spec?" question is
// answered by an explicit decision rather than by omission.
const UNDOCUMENTED_FILES = new Set([
  'accountLinking.js',
  'admin.js',
  'authRoles.js',
  'bulkLists.js',
  'categories.js',
  'contextPlugins.js',
  'contexts.js',
  'crawlerFiles.js',
  'dataExport.js',
  'details.js',
  'governance.js',
  'identities.js',
  'jobs.js',
  'llm.js',
  'matrix.js',
  'orgChart.js',
  'perf.js',
  'permissions.js',
  'preferences.js',
  'recentChanges.js',
  'resources.js',
  'riskProfiles.js',
  'riskScores.js',
  'riskScoringRuns.js',
  'systems.js',
  'tags.js',
  'updates.js',
]);

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

// An Express Router is a middleware function carrying a `.stack` of layers. This
// shape-check identifies a router regardless of how a module exports it (default
// export, or one of several named exports like crawlers.js's two routers).
const isRouter = (v) => typeof v === 'function' && Array.isArray(v.stack);

// "METHOD /path" for every route on a router, recursing into sub-routers a barrel
// controller mounts with `router.use(subRouter)` (no path prefix — the split
// controllers keep full paths on their leaf routes, matching the spec).
function collectRoutes(router, into, seen = new Set()) {
  if (seen.has(router)) return;
  seen.add(router);
  for (const layer of router.stack) {
    if (layer.route) {
      const path = toOpenApiPath(layer.route.path);
      for (const m of HTTP_METHODS) {
        if (layer.route.methods[m]) into.add(key(m, path));
      }
    } else if (layer.handle && isRouter(layer.handle)) {
      collectRoutes(layer.handle, into, seen);
    }
  }
}

// Every router module on disk (excludes tests and this guard). Subfolders (the
// barrel controllers' leaf routers) aren't scanned as top-level modules — they're
// reached by recursing into the parent router's stack, so they're introspected
// via the barrel that composes them.
function routerFilesOnDisk() {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && !/\.test\.js$/.test(f) && f !== 'openapi.drift.test.js')
    .sort();
}

// filename -> Set("METHOD /path") for every route the module's router(s) register.
// Importing the module and shape-checking its exports handles default- and
// named-router exports uniformly, so no hand-maintained import list can drift.
async function routesByFile() {
  const out = {};
  for (const file of routerFilesOnDisk()) {
    // Import by absolute file URL, opting out of Vite's dynamic-import-vars glob
    // (@vite-ignore) — the specifier is a runtime-computed path, not a bundle glob.
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(__dirname, file)).href);
    const ops = new Set();
    for (const exported of Object.values(mod)) {
      if (isRouter(exported)) collectRoutes(exported, ops);
    }
    out[file] = ops;
  }
  return out;
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

const byFile = await routesByFile();
const documented = documentedOps();

// DERIVED documented set: a module is documented iff at least one of its routes
// is in the spec. No hand-maintained DOCUMENTED_ROUTERS list to fall out of sync.
const documentedFiles = Object.entries(byFile)
  .filter(([, ops]) => [...ops].some((op) => documented.has(op)))
  .map(([file]) => file)
  .sort();

// Routes across the documented surface, and across everything on disk.
const documentedRegistered = new Set();
for (const file of documentedFiles) for (const op of byFile[file]) documentedRegistered.add(op);
const allRegistered = new Set();
for (const ops of Object.values(byFile)) for (const op of ops) allRegistered.add(op);

describe('OpenAPI route <-> spec drift', () => {
  it('every router module is classified as documented (derived) or undocumented', () => {
    // Completeness: every router file is either DERIVED documented (has a spec
    // route) or EXPLICITLY listed undocumented. A file that is neither fails
    // here, forcing the documented-vs-not decision on any new public surface.
    const files = routerFilesOnDisk();
    const unclassified = files
      .filter((f) => !documentedFiles.includes(f) && !UNDOCUMENTED_FILES.has(f))
      .sort();
    expect(
      unclassified,
      `router module(s) under routes/ are neither documented in openapi.yaml nor ` +
      `listed UNDOCUMENTED. Put their routes in openapi.yaml (auto-derives as ` +
      `documented) or add each to UNDOCUMENTED_FILES:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    // A file can't be both: if a listed-undocumented module now has a spec route,
    // it's documented — drop it from the list so the classification stays honest.
    const conflicting = files
      .filter((f) => documentedFiles.includes(f) && UNDOCUMENTED_FILES.has(f))
      .sort();
    expect(
      conflicting,
      `module(s) are listed UNDOCUMENTED but now have a route in openapi.yaml — ` +
      `remove them from UNDOCUMENTED_FILES:\n${conflicting.join('\n')}`,
    ).toEqual([]);

    const stale = [...UNDOCUMENTED_FILES].filter((f) => !files.includes(f)).sort();
    expect(
      stale,
      `UNDOCUMENTED_FILES lists router file(s) that no longer exist:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every documented operation maps to a live registered route', () => {
    const missing = [...documented].filter((op) => !allRegistered.has(op)).sort();
    expect(
      missing,
      `openapi.yaml documents operations with no matching route handler ` +
      `(renamed or removed?):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every route in the documented surface is documented or explicitly allow-listed', () => {
    const undocumented = [...documentedRegistered]
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
      .filter((op) => !documentedRegistered.has(op) || documented.has(op))
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
