// Boots the real Express app against the contract-test PostgreSQL container so
// contract tests can exercise route handlers (and the inline SQL they emit)
// end-to-end via supertest — not just standalone SQL strings.
//
// Two env vars must be set BEFORE app.js is imported, which is why this helper
// uses a dynamic import:
//   - DATABASE_URL → CONTRACT_DB_URL, so db/connection.js's pool targets the
//     testcontainers database (buildConfig() honours DATABASE_URL first).
//   - USE_SQL=true, read at module load by USE_SQL-gated routes (contexts,
//     resources, identities, matrix/data); without it they return empty mocks.
//
// Auth is left disabled (no auth config loaded → authMiddleware /
// requirePermission are no-ops), so routes are reachable without a token.
//
// singleFork note: USE_SQL leaks across files in the shared process. Each test
// that calls this MUST `delete process.env.USE_SQL` in afterAll.

import request from 'supertest';
import pg from 'pg';

export async function bootContractApp() {
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  process.env.USE_SQL = 'true';
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  return { agent: request(app), pool };
}
