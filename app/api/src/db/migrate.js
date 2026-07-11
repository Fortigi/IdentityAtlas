// Identity Atlas database migrations runner.
//
// Reads SQL files from `migrations/` in alphabetical order, applies any that
// have not yet been recorded in the `_migrations` tracking table, and records
// each successful application. Each file runs in its own transaction so a
// partial failure leaves the database in a consistent state.
//
// Why we rolled our own instead of using node-pg-migrate or similar:
//   - 60 lines of code, no dependency
//   - We don't need up/down — migrations are forward-only by design
//   - JS file format would force us to learn another tool's API; SQL files
//     are universally readable and version-controllable
//   - Future maintainers can extend by dropping a new file in the directory
//
// Naming convention: NNN_short_description.sql, sorted lexically.
// Numbers are not validated to be sequential — gaps are fine.
//
// To add a new migration: create the next-numbered file, restart the web
// container. The migration runs once and is recorded.

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    )
  `);
}

async function listAppliedMigrations() {
  const r = await db.query(`SELECT filename FROM _migrations`);
  return new Set(r.rows.map(row => row.filename));
}

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

// Extensions that PGlite pre-loads natively at init time.
// Calling CREATE EXTENSION for these in DESKTOP_MODE causes a fatal WASM abort
// because the extension is already registered at the C level — there is no SQL
// exception to catch. Strip those statements before execution.
const PGLITE_NATIVE_EXTENSIONS = new Set(['pg_trgm']);

export function stripNativeExtensions(sql) {
  return sql.replace(
    /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*;/gi,
    (match, name) => PGLITE_NATIVE_EXTENSIONS.has(name.toLowerCase())
      ? `-- [DESKTOP_MODE] skipped: ${match.trim()}`
      : match
  );
}

// Warning emitted when a migration aborts with "already exists" and is recorded
// as applied WITHOUT re-running its body. The message names the file and calls
// out the real hazard: a mixed DDL+DML migration whose DML half (backfill /
// UPDATE / REFRESH) was silently skipped. It's built here as a pure function so
// the wording (and the presence of the filename) is unit-tested, and so a
// skipped backfill is greppable in boot logs by filename or by "SKIPPED".
export function alreadyExistsWarning(filename) {
  return `⚠ ${filename}: objects already exist — recorded as applied WITHOUT re-running its body. `
    + `If this migration also made data changes (backfill / UPDATE / REFRESH), they were SKIPPED — verify manually. `
    + `Make new migrations idempotent (IF NOT EXISTS) so this branch is never load-bearing.`;
}

// Apply a single migration file inside a transaction. The transaction wraps
// the whole file so a failure halfway leaves nothing partial — the next run
// will see the file as not-applied and try again from the top.
async function applyMigration(filename) {
  const path = join(MIGRATIONS_DIR, filename);
  let sql = readFileSync(path, 'utf8');
  if (process.env.DESKTOP_MODE === 'true') sql = stripNativeExtensions(sql);

  await db.tx(async (client) => {
    await client.query(sql);
    await client.query(
      `INSERT INTO _migrations (filename) VALUES ($1)`,
      [filename]
    );
  });
}

// Compare the migrations the DB has applied against the ones THIS web image
// ships. Pure so it's trivially unit-testable.
//   - ahead:   an applied migration this image does not ship → the DB schema is
//              NEWER than the running code (a rollback or half-applied update).
//   - pending: a shipped migration not yet applied → migrations haven't run.
//              Can't happen for a healthy web (fail-closed at boot), but surfaced
//              for completeness.
export function computeMigrationStatus(applied, shipped) {
  const appliedSet = new Set(applied);
  const shippedSet = new Set(shipped);
  return {
    applied: applied.length,
    latest: [...applied].sort().pop() || null,
    ahead: applied.some((f) => !shippedSet.has(f)),
    pending: shipped.some((f) => !appliedSet.has(f)),
  };
}

// Snapshot of the schema's migration state for the Admin → Updates "database"
// indicator. `client` is injectable for tests / contract tests.
export async function getMigrationStatus(client = db) {
  const r = await client.query(`SELECT filename FROM _migrations`);
  return computeMigrationStatus(
    r.rows.map((row) => row.filename),
    listMigrationFiles()
  );
}

export async function runMigrations(_pool) {
  await ensureMigrationsTable();
  const applied   = await listAppliedMigrations();
  const available = listMigrationFiles();
  const pending   = available.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log(`Migrations: up to date (${applied.size} applied)`);
    return;
  }

  console.log(`Migrations: applying ${pending.length} pending migration(s)`);
  for (const filename of pending) {
    process.stdout.write(`  ${filename} ... `);
    try {
      await applyMigration(filename);
      console.log('OK');
    } catch (err) {
      // PGlite DDL transactions may commit the DDL but fail to record the
      // migration (transaction boundary quirk). If objects already exist,
      // record the migration as applied and continue rather than aborting.
      if (/already exists/i.test(err.message)) {
        console.warn(`    ${alreadyExistsWarning(filename)}`);
        await db.query(
          `INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [filename]
        );
        continue;
      }
      console.log('FAILED');
      throw new Error(`Migration ${filename} failed: ${err.message}`);
    }
  }
  console.log(`Migrations: complete (${available.length} total)`);
}
