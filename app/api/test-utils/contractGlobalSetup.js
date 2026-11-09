// Vitest globalSetup for contract tests.
// Starts one PostgreSQL container, runs all migrations into its default
// database, then clones that database once per worker (see contractWorkerDb.js).
// The template's URL is exposed as CONTRACT_DB_TEMPLATE_URL; the setupFile
// contractWorkerSetup.js turns it into each worker's own CONTRACT_DB_URL.

import { startDb } from './withRealDb.js';

let db;

export async function setup() {
  db = await startDb({ cloneForWorkers: true });
  process.env.CONTRACT_DB_TEMPLATE_URL = db.connectionString;
}

export async function teardown() {
  await db?.stop();
}
