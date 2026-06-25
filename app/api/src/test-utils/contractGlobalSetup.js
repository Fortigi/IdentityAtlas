// Vitest globalSetup for contract tests.
// Starts one PostgreSQL container, runs all migrations, and exposes the
// connection URL via CONTRACT_DB_URL so individual test files can create
// their own pool without coupling to the global connection module.

import { startDb } from './withRealDb.js';

let db;

export async function setup() {
  db = await startDb();
  process.env.CONTRACT_DB_URL = db.pool.options.connectionString;
}

export async function teardown() {
  await db?.stop();
}
