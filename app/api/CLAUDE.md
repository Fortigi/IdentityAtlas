# Node.js API — Coding Guide

## Reuse Before Creating

Before writing any helper, utility, middleware, or route logic — search first. If equivalent logic already exists, use or extend it.

**Known shared utilities in `src/`:**
- `db/connection.js` — connection pool; never create one-off connections
- `db/columnCache.js` — column discovery with 5-minute TTL; never query `information_schema` per-request
- `db/migrate.js` — migration runner; add files to `src/db/migrations/`, never edit existing ones
- `middleware/auth.js` — Entra ID JWT validation (v1 + v2 tokens)
- `middleware/perfMetrics.js` — request timing + Server-Timing headers
- `secrets/vault.js` — encrypted secret storage/retrieval for crawler credentials
- `crawlerManifests.js` — the crawler manifest registry (`CRAWLER_MANIFESTS_DIR`, `VALID_JOB_TYPES`, `validateCrawlerConfig`), scanned once at startup from `tools/crawlers/*/crawler.json`; shared by `routes/jobs.js` and `routes/crawlerFiles.js` to avoid a circular import between them

## Always Test Locally Before Committing

After any change to the API, rebuild the container and verify the fix before touching git:

```bash
docker compose build web && docker compose up -d web
# then hit a representative endpoint, e.g.:
curl -s -X POST http://localhost:3001/api/ingest/contexts \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"records":[{"id":"...","contextType":"Department","displayName":"Test","systemId":1}],"syncMode":"full","systemId":1}'
```

Only proceed to branch/commit/push once the endpoint returns a 2xx response. The prod compose file (`docker-compose.prod.yml`) uses a pre-built image from ghcr.io — source file changes have no effect until the image is rebuilt with `docker compose build`.

### Windows: rebuild `re2` before running the unit tests

The `re2` dependency ships a **platform-specific native binary**, and `node_modules` is populated for Linux (the Docker/CI target). On Windows, importing the app — which several unit tests do transitively (`re2` is used by `accountlinking/classifier.js`, `contexts/plugins/manager-hierarchy.js`, and `riskscoring/engine.js`) — crashes with a native-module load error until you rebuild it for your platform:

```bash
cd app/api && npm rebuild re2
```

Run it once after `npm install` (and again after any `npm install` that repopulates `node_modules`). CI and Docker are unaffected — they install and run on Linux.

## Database Schema

**Never modify the schema manually.** All schema changes go through versioned migration files in `app/api/src/db/migrations/`. The web container applies them automatically at startup.

Migration files are numbered sequentially (`001_core_schema.sql`, `002_governance.sql`, etc.). Add a new file for each schema change — never edit existing migration files.

## Key Patterns

- **Column cache:** Use `db/columnCache.js` for column discovery — it has a 5-minute TTL. Don't run `information_schema` queries per-request.
- **Connection pool:** Always use the pool from `db/connection.js`. Never create one-off connections.
- **Error responses:** Return generic messages to clients. Log `err.message` server-side, not the full error object (avoids leaking schema info).
- **Input validation:** Validate IDs with `parseInt(..., 10)` + `isNaN()` check. Validate hex colors with `/^#[0-9a-fA-F]{6}$/`. Cap array inputs at 500 items.
- **SQL parameters:** Always use parameterized queries. Never interpolate user input into SQL strings.

## Route Files

| File | Responsibility |
|------|---------------|
| `routes/permissions.js` | Permissions, AP groups, sync log |
| `routes/categories.js` | Category CRUD, AP list, category assignments |
| `routes/details.js` | User/group/resource detail endpoints with history |
| `routes/resources.js` | Resource CRUD, filtering, column discovery |
| `routes/systems.js` | Systems CRUD, owners, statistics |
| `routes/identities.js` | Identities + linked accounts; per-account analyst override management (confirm/reject/clear) |
| `routes/accountLinking.js` | Account-linking config + run endpoints |
| `routes/riskScores.js` | Risk score reading + analyst override endpoints |
| `routes/contexts.js` | Contexts CRUD, member management, plugin runner |
| `routes/jobs.js` | Crawler config CRUD, job queuing, manifest-driven job type discovery |
| `routes/perf.js` | Performance metrics API |
| `middleware/auth.js` | Entra ID JWT validation (v1+v2 tokens) |
| `middleware/perfMetrics.js` | Request timing + Server-Timing headers |

## Crawler Job System

Crawler types and their config schemas are auto-discovered from `tools/crawlers/*/crawler.json` manifests at startup. See `tools/crawlers/CLAUDE.md` for the manifest schema.

**Key exports from `crawlerManifests.js`** (re-exported by `routes/jobs.js` for existing consumers):
- `VALID_JOB_TYPES` — array of valid job type strings, built from manifests (falls back to `['demo','entra-id','csv','omada']` if manifests are unreachable)
- `validateCrawlerConfig(type, config)` — validates a config object against the crawler's `configSchema`; returns an error string or `null`
- `validateStoredCrawlerConfig(type, config, configId)` — same, but for a config that came from storage (an edit, a "Run Now", a scheduled run) rather than a fresh wizard submission. **Always use this one, not `validateCrawlerConfig` directly, whenever the config might be missing a vaulted `clientSecret`.** Some types' schemas declare `clientSecret` required (directly, like entra-id, or conditionally via an `authMethod` `allOf`/`if-then`, like omada/midPoint's OAuth2CC/OAuth2ROPC) — but `clientSecret` is deliberately stripped out of `CrawlerConfigs.config` once saved (it lives only in the vault, see `secrets/crawlerSecrets.js`), so a config freshly loaded from storage never has it. Calling plain `validateCrawlerConfig` on it always fails the schema's `required` check even though credentials are genuinely present — this broke editing/running/scheduling such a crawler without re-entering the secret every time, for any type whose schema requires it, until this wrapper was added. No crawler-type branching needed in the caller — it generically checks `hasConfigSecret(configId)` only when the plain validation actually failed on a missing `clientSecret`.
- `maskConfig(config)` — redacts credential fields for safe logging/display

**Manifest discovery path** (checked in order):
1. `CRAWLER_MANIFESTS_DIR` env var (set to `/app/crawlers` in Docker, `bundled-scripts/tools/crawlers` in node-launcher)
2. Relative to `src/routes/`: `../../../../tools/crawlers` (works in local dev)

If the directory is unreachable, an error is logged and `VALID_JOB_TYPES` is empty — there is no hardcoded fallback list.

**`scheduler.js`** fires scheduled crawler jobs. It imports `VALID_JOB_TYPES` from `routes/jobs.js` and `validateStoredCrawlerConfig` from `crawlerManifests.js` directly — do not duplicate that logic here.

**Live-discovery endpoint:** `POST /api/admin/crawlers/:type/discover` is a generic route in `routes/jobs.js` that dynamically imports `{CRAWLER_MANIFESTS_DIR}/{type}/discover.js` at request time and calls its default export. To add live discovery to a crawler, drop a `discover.js` into its folder — no route changes needed. The handler signature is:

```js
export default async function handler(req, res, { db, getConfigSecret }) { ... }
```

Types not in `VALID_JOB_TYPES` or without a `discover.js` return 404. The type slug is validated against `/^[a-z][a-z0-9-]*$/` before the filesystem lookup to prevent path traversal.

**Testing a `discover.js` handler:** the test file does **not** live in `routes/` alongside `jobs.js` — it's co-located with the handler at `tools/crawlers/<type>/discover.test.js` (nothing crawler-specific belongs outside its own folder; see `tools/crawlers/CLAUDE.md` → Rules). `vitest.config.js`'s `test.include` adds `'../../tools/crawlers/**/discover.test.js'` alongside `src/**/*.test.js` so `npm test` here still picks these up. See `tools/crawlers/omada/discover.test.js` or `tools/crawlers/entra-id/discover.test.js`.

**Testing a crawler's `configSchema`:** same rule — detailed assertions about which fields one crawler type's schema requires (e.g. Omada's auth-method matrix) live at `tools/crawlers/<type>/configValidation.test.js`, calling `validateCrawlerConfig` from `crawlerManifests.js` directly. `vitest.config.js` adds a matching glob for this filename too. `routes/jobs.configValidation.test.js` keeps only the generic, type-agnostic engine tests (`maskConfig`, `VALID_JOB_TYPES` discovery). See `tools/crawlers/omada/configValidation.test.js`.

## Contract Tests

Contract tests verify that the SQL emitted by API code is correct against the real PostgreSQL 16 schema — catching wrong table names, column names in WHERE clauses, wrong casts, or missing views before they reach production. Unit tests (which mock the DB) cannot catch these.

**Location:** `app/api/contract-tests/` — deliberately outside `src/` so that changes to contract tests do not trigger E2E or load & soak CI jobs (those fire on `app/api/src/**`).

**Run:** `npm run test:contract` (uses `vitest.contract.config.js`). Not included in `npm test`.

**Infrastructure:** `test-utils/withRealDb.js` starts a `postgres:16-alpine` container via testcontainers, runs all migrations, and returns a connection string. `test-utils/contractGlobalSetup.js` wires this into Vitest's `globalSetup` and exposes `CONTRACT_DB_URL` for the test files.

**Writing a contract test:**
- Import `pg` directly and create a `Pool` from `process.env.CONTRACT_DB_URL` in `beforeAll`.
- Use `beforeEach` to `DELETE` test rows (don't `DROP` tables or `TRUNCATE` — schema must survive).
- Insert a `Systems` row first (`systemType`, `displayName`) to satisfy foreign keys on `Principals`/`Resources`/etc.
- If querying a materialized view, call `REFRESH MATERIALIZED VIEW "..."` in `beforeAll` after the pool is ready — migrations create matviews unpopulated.
