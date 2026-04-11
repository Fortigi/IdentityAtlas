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

// Apply a single migration file inside a transaction. The transaction wraps
// the whole file so a failure halfway leaves nothing partial — the next run
// will see the file as not-applied and try again from the top.
async function applyMigration(filename) {
  const path = join(MIGRATIONS_DIR, filename);
  const sql  = readFileSync(path, 'utf8');

  await db.tx(async (client) => {
    await client.query(sql);
    await client.query(
      `INSERT INTO _migrations (filename) VALUES ($1)`,
      [filename]
    );
  });
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
      console.log('FAILED');
      throw new Error(`Migration ${filename} failed: ${err.message}`);
    }
  }
  console.log(`Migrations: complete (${available.length} total)`);
}
