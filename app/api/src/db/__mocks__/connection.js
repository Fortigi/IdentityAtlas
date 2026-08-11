// Manual mock for src/db/connection.js — the single source of the DB mock used
// by the route unit tests.
//
// Vitest hoists `vi.mock(...)` above the imports, so a mock factory can't
// reference a value imported from a helper module (see test-utils/routeTestKit.js
// for the same note). A sibling `__mocks__/` module sidesteps that: a test calls
// `vi.mock('../db/connection.js')` with NO factory and vitest auto-loads this
// file, then imports `query` / `queryOne` from the same path to stage results:
//
//   vi.mock('../db/connection.js');
//   import { query, queryOne } from '../db/connection.js';
//   beforeEach(() => { query.mockReset(); queryOne.mockReset(); });
//
// `tx` and `getPool` deliberately route back through the exported `query` spy,
// so transaction/pool queries stage the same way as direct ones. Reset only the
// spies you stage — resetting `tx`/`getPool` would drop that forwarding.
//
// NOTE: these mocks are SQL-blind — they return scripted recordsets without
// parsing the SQL string, so they cannot catch malformed SQL. Real-SQL
// correctness stays the job of the contract tests (real Postgres).

import { vi } from 'vitest';

export const query = vi.fn();
export const queryOne = vi.fn();
export const tx = vi.fn(async (fn) => fn({ query: (...a) => query(...a) }));
export const getPool = vi.fn(async () => ({ query: (...a) => query(...a) }));
export const closePool = vi.fn(async () => {});

export default { query, queryOne, tx, getPool, closePool };
