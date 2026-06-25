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

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

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

export async function startDb() {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString, max: 5 });

  await runMigrations(pool);

  return {
    connectionString,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
