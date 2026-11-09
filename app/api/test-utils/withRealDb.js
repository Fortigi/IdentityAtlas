// Starts a real PostgreSQL container (testcontainers) and runs all migrations.
// Used by contract tests that need to verify SQL correctness against a real schema.
//
// Usage (typically called once in contractGlobalSetup.js, not per-test):
//
//   const { pool, stop } = await startDb();
//   // ... run tests using pool or pool.connect()
//   await stop();
//
// The caller is responsible for cleaning up between tests (e.g. DELETE FROM or
// wrapping each test in a transaction that rolls back).

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cloneWorkerDatabases } from './contractWorkerDb.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

// `cloneForWorkers`: after migrating, clone the database once per contract-suite
// worker (contractWorkerDb.js). The migration pool is closed first because
// Postgres refuses to use a database as a TEMPLATE while anyone is connected to it,
// so the clones are made from the `postgres` maintenance database.
export async function startDb({ cloneForWorkers = false } = {}) {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const connectionString = container.getConnectionUri();
  let pool = new Pool({ connectionString, max: 5 });

  await runMigrations(pool);

  if (cloneForWorkers) {
    const { rows } = await pool.query('SELECT current_database() AS db');
    await pool.end();
    const adminUrl = new URL(connectionString);
    adminUrl.pathname = '/postgres';
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await cloneWorkerDatabases(admin, rows[0].db);
    } finally {
      await admin.end();
    }
    pool = new Pool({ connectionString, max: 1 });
  }

  // Cap every connection to this database at a 10s statement timeout so a
  // runaway query (e.g. a recursive CTE over cyclic data) can't wedge the
  // singleFork contract suite. ALTER DATABASE ... SET applies to all sessions
  // that connect after this point — including the per-file pools each contract
  // test opens in its beforeAll. The container DB name isn't always "postgres"
  // (testcontainers defaults to "test"), so resolve it at runtime.
  const { rows } = await pool.query('SELECT current_database() AS db');
  await pool.query(`ALTER DATABASE "${rows[0].db}" SET statement_timeout = '10s'`);

  return {
    connectionString,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
