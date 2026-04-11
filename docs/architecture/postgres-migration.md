# PostgreSQL Migration Plan

**Status:** Structurally complete (April 2026). End-to-end testing in progress.
**Branch (when started):** `feature/postgres-migration`
**Owner:** Wim
**Target:** Identity Atlas v5.0 — drop Microsoft SQL Server entirely, ship on PostgreSQL.

!!! note "Current state"
    The development Docker stack (`docker-compose.yml`) runs PostgreSQL 16. Schema migrations, the Ingest API, and the web container are fully ported. The production compose file (`docker-compose.prod.yml`) still uses SQL Server 2022 and has not been updated yet. See [postgres-migration-status.md](postgres-migration-status.md) for the detailed overnight migration report.

---

## Why

1. **Licensing.** SQL Server Developer Edition is free but the EULA forbids production use. SQL Server Express is free for production but capped at 10 GB per database — far too small for the tenant sizes Identity Atlas targets. Standard/Enterprise costs thousands per core. We refuse to ship a product that requires customers to bring a paid license.
2. **Cost predictability for customers.** Postgres is free at any scale. No surprise bills, no audits, no licensing complexity in the sales conversation.
3. **No artificial limits.** Postgres has no row count, no database size, no CPU socket cap.
4. **Operational simplicity.** Postgres runs everywhere — bare metal, every cloud's managed service, in a docker container, on a Raspberry Pi. SQL Server doesn't.

## Trade-offs we accept

- **Lose temporal tables.** SQL Server's `SYSTEM_VERSIONING = ON` has no built-in Postgres equivalent. We will drop history tracking entirely in the first cut. If we want it back later we add audit triggers per-table; the SQL Server temporal feature was nice but not load-bearing for any current product feature.
- **Rewrite SQL.** Significant T-SQL → PL/pgSQL translation. Mechanical for most things; some thinking required for the views and the ingest engine.
- **Two-DB-backend transition is rejected.** We do not support both at the same time. One commit removes MS SQL, replaces with Postgres. No `if (dbType === 'pg')` switches anywhere.

## Trade-offs we reject

- **NoSQL / document store.** Identity Atlas is fundamentally relational (joins between users, groups, assignments). Postgres is the right fit.
- **SQLite.** Tempting for single-node simplicity, but doesn't handle the concurrent crawler-vs-UI write/read pattern well, and we'd need to migrate again later when we want HA.
- **Cloud-managed-only.** Some customers will run on-prem; we need a database that runs in a docker container.

---

## Inventory — what changes

### File counts

| Layer | Files | Notes |
|---|---|---|
| PowerShell DB helpers (`app/db/*.ps1`) | 36 | All `Invoke-FGSQLQuery` and friends — every one needs to either go away or get a Postgres equivalent. |
| PowerShell crawler/ingest call sites (`Invoke-FGSQL*`) | ~35 | Every call site reviewed; most should be deleted because the crawler talks to the API now, not SQL directly. |
| Node API routes (`app/api/src/routes/*.js`) | 19 | Each one has SQL strings that need translation. Most queries are simple SELECTs; a few are gnarly. |
| `mssql` import sites | 5 | Connection pool, ingest engine, perf timer, etc. |
| Views (`CREATE VIEW`) | 4 file groups, ~12 views | Most are recursive CTEs — Postgres syntax is essentially identical, mechanical port. |
| Schema initializers | ~8 files | Replaced with Postgres equivalents. |

### Breaking changes summary

| MS SQL feature | Postgres replacement | Effort |
|---|---|---|
| `UNIQUEIDENTIFIER` | `UUID` (native type, requires no extension in PG ≥13) | Mechanical |
| `NVARCHAR(N)`, `NVARCHAR(MAX)` | `TEXT` (no length limits in Postgres, no Unicode wrapper needed) | Mechanical |
| `BIT` | `BOOLEAN` | Mechanical |
| `DATETIME2` | `TIMESTAMP WITH TIME ZONE` | Mechanical, but watch out for TZ handling in app code |
| `INT IDENTITY(1,1)` | `BIGSERIAL` or `GENERATED ALWAYS AS IDENTITY` | Mechanical |
| `TOP N` | `LIMIT N` | Mechanical |
| `GETDATE()`, `SYSUTCDATETIME()` | `now() AT TIME ZONE 'utc'` or `clock_timestamp()` | Mechanical |
| `OBJECT_ID('dbo.X','U')` (table-exists check) | `to_regclass('public.X')` | Mechanical |
| `MERGE ... OUTPUT $action` | `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING (xmax = 0) AS inserted` | **Non-trivial** — see ingest engine section |
| `SYSTEM_VERSIONING = ON` (temporal tables) | **Removed.** Single table, no history. | Schema simplification |
| `bulkRequest.bulk(table)` (mssql Node bulk insert) | `pg-copy-streams` `COPY FROM STDIN BINARY` | Different API, similar performance |
| Recursive CTE views | Identical syntax, just `WITH RECURSIVE` | Mechanical |
| `Initialize-FGSQLTable` (PowerShell schema evolution) | **Removed.** We use a SQL migration file (or a node-pg-migrate setup) instead. | Architectural simplification |
| `dbo.` schema prefix | `public.` (Postgres default) or omit entirely | Mechanical |
| `[bracketed]` identifiers | `"double-quoted"` identifiers (only when reserved) | Mechanical |
| `READ_COMMITTED_SNAPSHOT` (RCSI we just enabled) | **Default behavior in Postgres.** MVCC means reads never block writes. Free win. | None — Postgres just does this |
| `WITH (NOLOCK)` hints | **Not needed.** MVCC. | Delete the hints |
| `NEWID()` | `gen_random_uuid()` (built into PG ≥13) | Mechanical |
| `OPENJSON`, `JSON_VALUE` | `jsonb_each`, `->`, `->>` operators, `jsonb_path_query` | Some thinking needed where used |

### Things that map cleanly with no work

- All the stored data — Resources, Principals, ResourceAssignments, Identities, OrgUnits, etc. The data model is relational and doesn't depend on any SQL Server quirk.
- All the API contracts — endpoints, payloads, query parameters. The `/api/permissions`, `/api/users`, `/api/resources`, etc. shapes don't change.
- The frontend — zero changes. It only talks to the API.
- Microsoft Graph crawler — talks to the API via `Send-IngestBatch`, not directly to SQL. Should need almost no changes.
- CSV crawler — same. Talks to API.
- Risk scoring engine — talks to API for reads, talks to LLMs for inference. Direct SQL access via PowerShell needs to go.
- Auth, JWKS, MSAL — unchanged.
- Docker compose structure — `sql` service is replaced with `postgres`, `sql-init` and `sql-table-init` collapse into a single `db-init` step.

---

## Architectural decisions

### 1. Drop the "PowerShell talks directly to SQL" pattern entirely

The old `Invoke-FGSQLQuery` helper exists in dozens of places. Most of those call sites are inside the worker container and predate the ingest API. Now that everything goes through the API:

- **All PowerShell SQL helpers (`Invoke-FGSQLQuery`, `Invoke-FGSQLBulkMerge`, `Connect-FGSQLServer`, `Initialize-FGSyncTable`, etc.) are deleted.**
- The worker container no longer needs a database driver at all.
- The worker reads/writes via `/api/ingest/*` and `/api/admin/*`.
- The progress reporter, scheduler, and account correlation are the only PowerShell paths that touch the DB; they all migrate to API calls.
- Net effect: ~36 PowerShell files in `app/db/` shrink to ~5 (or move out of `app/db/` entirely since they're no longer DB-layer files).

**Why this matters for Postgres:** otherwise we'd need to find a Postgres equivalent of the `SqlServer` PowerShell module (none exist that are both first-party and good). Eliminating the dependency removes the question.

### 2. Schema migrations as a directory of SQL files

Instead of `Initialize-FGSyncTable` evolving schemas at runtime, we use a versioned migrations folder:

```
app/api/src/db/migrations/
├── 001_initial_schema.sql       — Systems, Resources, Principals, Assignments, etc.
├── 002_governance_tables.sql    — Catalogs, Policies, Requests, CertificationDecisions
├── 003_risk_scoring_tables.sql
├── 004_crawler_jobs.sql         — CrawlerConfigs, CrawlerJobs, WorkerConfig
├── 005_views.sql                — All the recursive CTEs
└── 006_indexes.sql
```

Bootstrap reads the highest-numbered file already applied (tracked in a `_migrations` table) and runs anything newer. No runtime schema evolution. Adding a column means writing a new `00N_add_column_X.sql` file.

**Why:** Postgres doesn't have the temporal-table-locking trap that made `Initialize-FGSyncTable` necessary, and migration files are auditable, version-controlled, and trivially reproducible.

### 3. Drop temporal tables, keep last-known-state only

- Tables become flat: just the current row, no `ValidFrom`/`ValidTo`, no history tables.
- The `vw_*` views that referenced `ValidTo = '9999-12-31...'` get simplified.
- The "version history" sections of the user/resource/AP detail pages just disappear (or become "data updated at: ..." showing the row's `updatedAt` column).
- Risk: people might miss the history feature. Mitigation: it was barely used, and we can add audit triggers later if a customer asks.

### 4. Use `INSERT ... ON CONFLICT` instead of MERGE

The ingest engine's MERGE statement becomes:

```sql
INSERT INTO resources (id, system_id, display_name, ...)
SELECT id, system_id, display_name, ... FROM temp_ingest_xxx
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  ...
RETURNING id, (xmax = 0) AS was_insert;
```

`(xmax = 0)` is a Postgres trick to detect whether a row was inserted (true) vs updated (false). Lets us return `{ inserted, updated }` counts the same way the current MERGE does via `OUTPUT $action`.

### 5. Use `COPY FROM STDIN` for bulk insert

The current `bulkRequest.bulk(table)` is replaced with a streamed `COPY` via `pg-copy-streams`. This is **the** Postgres bulk-load primitive — equivalent or faster than SqlBulkCopy.

```javascript
import { from as copyFrom } from 'pg-copy-streams';

const stream = client.query(copyFrom(`COPY temp_ingest (col1, col2, ...) FROM STDIN BINARY`));
for (const row of records) {
  stream.write(encodeBinaryRow(row));
}
stream.end();
```

### 6. Connection pooling: `pg.Pool` instead of `mssql.ConnectionPool`

The driver swap is mostly mechanical. The `pg` package is the de-facto standard. Same pool/request shape.

### 7. snake_case column names

Postgres convention is `snake_case` for table and column names. SQL Server is camelCase here. **We will rename in the migration** — `displayName` → `display_name`, `systemId` → `system_id`, etc. This is more invasive but it's the right time to do it: we have to touch every query anyway.

The API response keys stay in camelCase (the frontend doesn't change). The DAO layer maps `display_name` → `displayName` on read.

---

## Step-by-step plan

### Phase 0 — Preparation (before we touch any code)

**Goal:** be able to abort and revert without losing work.

1. **Wait for the current crawler to finish** (or kill it cleanly). Don't start migration work mid-crawl.
2. **Tag the current state** as `pre-postgres-migration` so we can roll back: `git tag pre-postgres-migration && git push origin pre-postgres-migration`.
3. **Branch from `dev`**: `git checkout dev && git pull && git checkout -b feature/postgres-migration`.
4. **Reset `CHANGES.md`** to a fresh header.
5. **Snapshot the current SQL Server schema** for reference: `docker compose exec sql /opt/mssql-tools18/bin/sqlcmd ... -Q "..."` → save to `docs/architecture/legacy-mssql-schema.sql` (committed, for reference only — never executed).
6. **Capture a baseline screenshot** of the working app so we can compare the migrated version against it.

### Phase 1 — Schema design in Postgres

**Goal:** every table that exists in SQL Server has a Postgres equivalent, written down, agreed on.

1. **Inventory every table** in the current SQL Server database. Export `INFORMATION_SCHEMA.COLUMNS` to CSV.
2. **Write `001_initial_schema.sql`** as a single canonical Postgres DDL file containing all the universal-resource-model tables: `systems`, `system_owners`, `resources`, `resource_assignments`, `resource_relationships`, `principals`, `identities`, `identity_members`, `org_units` (now `contexts`), and the auth-config rows live in `worker_config`.
3. **Write `002_governance_tables.sql`** for catalogs, policies, requests, certification decisions, tags, categories.
4. **Write `003_risk_scoring_tables.sql`** for risk profiles, classifiers, scores, clusters, correlation rulesets.
5. **Write `004_crawler_tables.sql`** for `crawler_jobs`, `crawler_configs`, `crawlers`, `crawler_audit_log`, `worker_config`, `sync_log`.
6. **Write `005_views.sql`** with the simplified versions of the views currently in `Initialize-FGAccessPackageViews.ps1`, `Initialize-FGGroupMembershipViews.ps1`, `Initialize-FGResourceViews.ps1`. Drop the temporal `ValidTo` filter throughout.
7. **Write `006_indexes.sql`** for all secondary indexes (FK supports, search indexes, etc.).
8. **Write `007_seed_data.sql`** if any (probably none — bootstrap creates the built-in worker via API logic).
9. **Manually apply** to a throwaway local Postgres container and verify every CREATE succeeds.
10. **Have a good night's sleep**, re-read the schema files, fix obvious mistakes.

**Deliverable:** a working Postgres database with the right shape, tested locally.

### Phase 2 — Migrations runner

**Goal:** the bootstrap step at web startup applies any pending migrations.

1. Decide: use `node-pg-migrate` (popular library, JS migrations, supports up/down) **or** roll our own (read `migrations/*.sql` in order, track applied filenames in `_migrations` table).
2. **Recommendation: roll our own.** ~80 lines of code, no dependency, full control, future maintainers don't need to learn another tool.
3. Implement `app/api/src/db/migrate.js`:
   - Reads `migrations/*.sql` sorted by filename
   - Checks `_migrations` table for what's already applied
   - Applies the rest in a transaction each
   - Inserts a row into `_migrations` with the filename + applied_at timestamp
4. Bootstrap calls `await runMigrations(pool)` before anything else.
5. Test: blow away Postgres volume, start fresh, see all migrations apply cleanly.

**Deliverable:** every fresh stack auto-applies the schema.

### Phase 3 — Connection layer + DAO swap

**Goal:** Node API talks to Postgres.

1. **Replace `mssql` with `pg`** in [app/api/package.json](app/api/package.json). Add `pg-copy-streams`.
2. **Rewrite [app/api/src/db/connection.js](app/api/src/db/connection.js)** to export a `pg.Pool` instead. Same `getPool()` signature so callers don't all need updating.
3. **Add a small DAO helper layer** that translates between `snake_case` DB columns and `camelCase` API response keys. Keep it simple — just `toCamel(row)` and `toSnake(obj)` utility functions, used in route handlers.
4. **Translate query strings** in each route file. This is the bulk of the work. Approach:
   - Pick the simplest route first (`/api/systems`)
   - Translate, test, commit
   - Move to the next
   - The order: `systems` → `users` → `resources` → `contexts` → `identities` → `tags` → `categories` → `details` → `permissions` → `access-package-groups` → `risk-scores` → `clusters` → `org-chart` → `governance` → `preferences` → `crawlers` → `jobs` → `ingest` → `admin` → `perf`
5. **Drop `WITH (NOLOCK)` hints** wherever they appear (Postgres MVCC doesn't need them).
6. **Replace `OBJECT_ID('dbo.X', 'U')` table-exists checks** with `to_regclass('public.X')`.
7. **Replace `OPENJSON` / `JSON_VALUE`** in any query that touches `extended_attributes` with Postgres `jsonb` operators.
8. **Run vitest unit tests** as you go — if you have any backend integration tests, they should keep passing or be updated.

**Deliverable:** every API endpoint that returns data works against Postgres. Frontend renders.

### Phase 4 — Ingest engine rewrite

**Goal:** crawlers can write data via the existing `/api/ingest/*` endpoints, with the same JSON contract.

1. **Rewrite [app/api/src/ingest/engine.js](app/api/src/ingest/engine.js)**:
   - Replace MERGE with `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING (xmax = 0) AS inserted`.
   - Replace `bulkRequest.bulk(table)` with `pg-copy-streams` writing to a `TEMPORARY` table.
   - Keep the same input/output shape so the crawlers don't have to change.
2. **Rewrite the scoped delete logic** for `syncMode: 'full'` — Postgres syntax for `DELETE FROM ... USING ...` is slightly different.
3. **Verify ingest performance** with a synthetic large batch (50k rows). Should be at least as fast as the SQL Server path.
4. **Drop the `systemIdColumn` parameter** if it turns out we don't need it after schema cleanup.

**Deliverable:** `POST /api/ingest/principals` with 4435 rows works. Same for resources, assignments, relationships, identities, etc.

### Phase 5 — PowerShell crawler & worker cleanup

**Goal:** the worker container has zero direct database dependencies.

1. **Delete the entire `app/db/` PowerShell folder** — every `Initialize-FG*`, `Invoke-FGSQL*`, `Get-FGSQL*`, etc. is gone. If anything still calls these, find a different path.
2. **Audit `tools/crawlers/entra-id/Start-EntraIDCrawler.ps1`** for any `Invoke-FGSQLQuery` calls — there should be none, but verify.
3. **Audit `tools/crawlers/csv/Start-CSVCrawler.ps1`** for the same.
4. **Audit `tools/riskscoring/*.ps1`** — risk scoring currently reads from SQL directly. Move it to API reads via new endpoints if needed (`GET /api/principals/risk-context`, etc.) or call existing endpoints.
5. **Audit `setup/docker/scheduler.ps1`** and `Invoke-CrawlerJob.ps1` — these may use SQL directly to update job progress; if so, switch to the new `POST /api/crawlers/job-progress` endpoint we already built.
6. **Remove `Install-Module SqlServer`** from `setup/docker/Dockerfile.powershell`.
7. **Test the worker container** still starts cleanly with no SQL module installed.

**Deliverable:** worker image is smaller and has zero dependency on a SQL driver.

### Phase 6 — Docker compose changes

**Goal:** `docker compose up` starts a Postgres-backed Identity Atlas stack.

1. **Replace the `sql` service** with a `postgres` service:
   ```yaml
   postgres:
     image: postgres:16-alpine
     environment:
       POSTGRES_DB: identity_atlas
       POSTGRES_USER: identity_atlas
       POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-identity_atlas_local}
     ports:
       - "5432:5432"
     volumes:
       - postgres_data:/var/lib/postgresql/data
     healthcheck:
       test: ["CMD-SHELL", "pg_isready -U identity_atlas"]
       interval: 10s
       timeout: 5s
       retries: 30
   ```
2. **Delete `sql-init` and `sql-table-init` services** entirely. Schema is now applied by the web container at startup.
3. **Update web service env vars**:
   - Drop `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`, `SQL_TRUST_SERVER_CERT`
   - Add `DATABASE_URL=postgres://identity_atlas:identity_atlas_local@postgres:5432/identity_atlas`
4. **Rename volume** `sql_data` → `postgres_data`.
5. **Update worker env vars** — drop SQL-related ones; the worker doesn't need DB access anymore.
6. **Update [setup/config/.env.example](setup/config/.env.example)** to match.
7. **Test:** `docker compose down -v && docker compose up -d` — verify clean start.

**Deliverable:** Postgres image is what runs, no SQL Server image referenced anywhere in the repo.

### Phase 7 — Tests

**Goal:** every existing test still passes against Postgres, plus new tests for the migration logic.

1. **Pester unit tests** ([test/unit/IdentityAtlas.Tests.ps1](test/unit/IdentityAtlas.Tests.ps1)):
   - Remove file-existence checks for deleted PowerShell files (`Initialize-FGSyncTable`, `Invoke-FGSQLQuery`, etc.).
   - Update function-availability lists to drop SQL helpers.
   - Update function counts.
   - Rename references from `SqlServer` module to none.
2. **Backend tests** (Vitest):
   - Update mocks from `mssql` to `pg`.
   - Add a new test suite for the migrations runner: empty DB → run migrations → verify expected tables exist.
   - Add a test for the ingest engine that inserts, updates, and full-sync deletes a small set of records.
3. **Docker integration tests** ([test/run-docker-tests.ps1](test/run-docker-tests.ps1)):
   - Rewrite the SQL connection setup to use Postgres.
   - All 87 existing checks should pass with minor query syntax updates.
   - Add a new check: "schema migration count matches expected".
4. **Nightly Entra ID crawler tests** ([test/nightly/Test-EntraIdCrawler.ps1](test/nightly/Test-EntraIdCrawler.ps1)):
   - Should work with no changes — it talks to the API, not SQL directly.
5. **Nightly auth tests**: same — API only.
6. **Playwright E2E tests**: should work with no changes — UI only.
7. **CSV crawler tests**: should work with no changes — uploads via API.

**Deliverable:** `pwsh -File test\nightly\Run-NightlyLocal.ps1` reports green against the Postgres-backed stack.

### Phase 8 — Documentation

**Goal:** every doc that mentions SQL Server is updated.

1. **[CLAUDE.md](https://github.com/Fortigi/IdentityAtlas/blob/main/CLAUDE.md)**: rewrite the architecture section. Drop temporal table mentions. Drop SQL Server mentions. Drop the `app/db/*.ps1` references. Update function counts (down ~36 files).
2. **[docs/architecture/docker-setup.md](docker-setup.md)**: replace SQL Server section with Postgres. Update the folder mapping table.
3. **[docs/architecture/demo-dataset.md](demo-dataset.md)**: schema references.
4. **[docs/reference/sql-views.md](../reference/sql-views.md)**: rewrite for Postgres syntax (or rename to `database-views.md`).
5. **[docs/reference/troubleshooting.md](../reference/troubleshooting.md)**: replace `sqlcmd` examples with `psql` examples.
6. **[docs/reference/config.md](../reference/config.md)**: replace `SQL_*` env vars with `DATABASE_URL`.
7. **[docs/quickstart.md](../quickstart.md)**: should largely Just Work — only env vars change.
8. **[docs/index.md](../index.md)**: drop "SQL Server" from any feature list.
9. **[docs/architecture/testing-plan.md](testing-plan.md)**: update to mention Postgres.
10. **[test/TESTING-GUIDE.md](https://github.com/Fortigi/IdentityAtlas/blob/main/test/TESTING-GUIDE.md)**: same.
11. **[README.md](https://github.com/Fortigi/IdentityAtlas/blob/main/README.md)** if it mentions SQL Server.
12. **New doc**: `docs/architecture/database.md` — short explainer of the Postgres schema, the migrations directory, the rationale for dropping temporal tables.
13. **New doc**: `docs/reference/migrations.md` — how to add a new migration file, naming convention, dos and don'ts.

**Deliverable:** zero search hits for "SQL Server" or "T-SQL" or "mssql" outside of the legacy reference file in `docs/architecture/legacy-mssql-schema.sql` and the CHANGES.md entry that records the migration.

### Phase 9 — End-to-end verification

**Goal:** prove the migrated stack does everything the old one did.

1. **Spin up a fresh stack** (`docker compose down -v && docker compose up -d`).
2. **Configure the iidemo Entra ID crawler** via the wizard.
3. **Run a full sync** — verify all phases complete cleanly.
4. **Verify the matrix view** renders correctly.
5. **Verify the user/resource/AP detail pages** render.
6. **Verify risk scoring** runs end-to-end.
7. **Verify CSV import** works.
8. **Run the nightly test suite**.
9. **Compare the morning report against the SQL-Server-era baseline** captured in Phase 0.
10. **Manually click through every UI page** with a checklist.

**Deliverable:** confidence to merge the branch.

### Phase 10 — Merge & release

1. Open PR `feature/postgres-migration` → `dev`. Description = `CHANGES.md`.
2. After review, merge.
3. Bump `dev` to `Major.Minor` matching the new milestone.
4. Open PR `dev` → `main` for the v5.0 cut.
5. Merge with approval.
6. Tag `v5.0.0`.
7. Update GitHub Releases page with migration notes.
8. **Delete the old `pre-postgres-migration` tag** or keep it forever as a recovery point — your call.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **Recursive CTE views behave differently** in Postgres | Postgres recursive CTE syntax is essentially identical. We'll test each view against known data after migration. Two-day cushion in the plan for view debugging. |
| **`ON CONFLICT` semantics differ from MERGE** | The "did this insert or update" detection uses the `xmax = 0` trick. We'll write a unit test specifically for the inserted/updated count returned by the ingest engine. |
| **Bulk insert performance regression** | `COPY FROM STDIN` is widely used for high-volume Postgres ingest and is typically as fast as or faster than SQL bulk copy. We'll benchmark with 50k rows during Phase 4. If it's slower, fallback is `INSERT ... VALUES (...), (...), (...)` in 1000-row batches — slower but acceptable. |
| **`extendedAttributes` JSON queries** | We use `jsonb` instead of `nvarchar(max)`. Indexed via GIN if we need to query inside it. Better than SQL Server's JSON support. |
| **Date/time handling subtly different** | Use `TIMESTAMPTZ` everywhere, set `pg` driver to return JS `Date` objects. Test the temporal queries thoroughly. |
| **Customer demands SQL Server support** | They can use a different product. Or we accept it as a hard "no". This decision is intentional. |
| **We discover halfway through that some feature really did need temporal tables** | Add audit triggers for that one table. Don't reintroduce SQL Server. |
| **Migration takes longer than estimated** | This plan estimates ~1.5–2 weeks of focused work. If it slips by a week, that's fine — we're not under deadline pressure. If it slips by a month, something's gone wrong and we should reassess. |
| **The branch gets too far behind `dev`** | Avoid merging anything else into `dev` while this is in flight. Park other PRs. Or merge them into the migration branch as we go (slower but safer). |

---

## Estimated effort

| Phase | Effort | Notes |
|---|---|---|
| 0. Preparation | 0.5 day | Tag, branch, snapshot |
| 1. Schema design | 1.5 days | Most thinking happens here |
| 2. Migrations runner | 0.5 day | Small code |
| 3. Connection + DAO swap | 3 days | The grind — every route file |
| 4. Ingest engine rewrite | 1 day | Concentrated effort |
| 5. PowerShell cleanup | 1 day | Mostly deletion |
| 6. Docker compose changes | 0.5 day | Small but fiddly |
| 7. Tests | 1.5 days | Updating + writing new ones |
| 8. Documentation | 1 day | Lots of files but mechanical |
| 9. End-to-end verification | 1 day | Click everything, fix edge cases |
| 10. Merge & release | 0.5 day | Process |
| **Total** | **~11 days** | Plus a 30% buffer = ~14 calendar days of focused work |

---

## What we will NOT do in this migration

To keep scope tight:

- **No new features.** No "while we're at it, let's also add X". Absolutely none.
- **No re-architecting beyond what the database swap requires.** The route layer stays as-is structurally.
- **No moving to Drizzle / Prisma / TypeORM.** Raw SQL via `pg`. The query strings get translated, the abstraction layer stays the same.
- **No GraphQL.** The REST API surface stays identical.
- **No moving the frontend off React.** Zero frontend churn.
- **No replacing PowerShell with anything.** The crawlers stay as PowerShell scripts.
- **No multi-tenancy work.** Same single-DB-per-deployment model.
- **No partial-data migration tooling.** Customers running the SQL Server preview start fresh after upgrading. There aren't any production deployments yet, so this is fine.

If anything in this list becomes tempting during the migration, **write it down and move on**. Add to a "post-migration backlog" doc.

---

## Open questions to resolve before starting

1. **Postgres version?** Recommend `postgres:16-alpine`. Stable, fast, alpine = ~80 MB image.
2. **Roll our own migration runner or use `node-pg-migrate`?** Recommend rolling our own (~80 lines, zero dependencies, easy to read).
3. **Keep camelCase or move to snake_case in the DB?** Recommend snake_case (Postgres convention; the alternative is double-quoted identifiers everywhere which is ugly). DAO layer maps to camelCase for API responses.
4. **Drop temporal tables entirely or keep audit triggers on a few high-value tables?** Recommend drop entirely in v5.0; revisit if anyone misses it.
5. **What's the target version number?** Recommend bumping straight to **v5.0** since this is a hard breaking change with no upgrade path.

---

## When to start

**Not yet.** Let the current crawler finish. Wait for a clean baseline. Then we go heads-down on this branch and don't surface for ~2 weeks.
