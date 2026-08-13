// Unit tests for the REAL ingest() full-sync reconcile and sessions.startSession.
//
// The route-level coverage test (routes/ingest.coverage.test.js) mocks engine.js
// and sessions.js wholesale, so neither the engine's full-sync branch nor a
// session's checkout path is ever executed against real code. These tests drive
// the real functions with only db/connection mocked.
//
// What they guard: the full-sync reconcile must build its column-guard set from
// the table's FULL schema, not just the columns present in the payload. Link
// preservation (linkConfidence / analystOverride) and the systemId scope depend
// on that — a payload rarely carries those columns, so a reconcile keyed off the
// payload columns would silently drop the guards and wipe rows it shouldn't.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query, getPool } from '../db/connection.js';
import { ingest } from './engine.js';
import { startSession } from './sessions.js';

// IdentityMembers' full schema — deliberately a superset of the payload, which
// only carries the two key columns. A reconcile keyed off the payload columns
// would lose linkConfidence / analystOverride / systemId.
const IDM_COLUMNS = ['identityId', 'principalId', 'systemId', 'linkConfidence', 'analystOverride'];
const IDM_RECORDS = [{ identityId: 'i1', principalId: 'p1' }];

function stageIdentityMembers() {
  query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/information_schema\.columns/.test(s)) {
      return { rows: IDM_COLUMNS.map((column_name) => ({ column_name })), rowCount: IDM_COLUMNS.length };
    }
    if (/^\s*INSERT INTO "IdentityMembers"/.test(s)) return { rows: [{ wasInsert: true }], rowCount: 1 };
    if (/DELETE FROM "IdentityMembers"/.test(s)) return { rowCount: 4, rows: [] };
    return { rows: [], rowCount: 0 }; // temp create / copy / index / analyze / begin
  });
}

beforeEach(() => {
  query.mockReset();
  stageIdentityMembers();
});

describe('ingest() — full-sync reconcile', () => {
  it('completes and keeps the full-schema delete guards', async () => {
    const res = await ingest(null, 'IdentityMembers', ['identityId', 'principalId'], IDM_RECORDS, {
      syncMode: 'full',
      systemId: 7,
    });
    expect(res).toEqual({ inserted: 1, updated: 0, deleted: 4 });

    const deleteSql = query.mock.calls.map((c) => String(c[0])).find((s) => /DELETE FROM "IdentityMembers"/.test(s));
    expect(deleteSql).toBeTruthy();
    // Present only if tableColumnNames came from the full schema, not the payload.
    expect(deleteSql).toContain('"linkConfidence" IS NULL');
    expect(deleteSql).toContain('"analystOverride" IS NULL');
    expect(deleteSql).toContain('"systemId" = $1');
  });

  it('skips the reconcile entirely on a delta sync', async () => {
    const res = await ingest(null, 'IdentityMembers', ['identityId', 'principalId'], IDM_RECORDS, {
      syncMode: 'delta',
    });
    expect(res.deleted).toBe(0);
    expect(query.mock.calls.some((c) => /DELETE FROM "IdentityMembers"/.test(String(c[0])))).toBe(false);
  });
});

describe('startSession — checkout path', () => {
  beforeEach(() => {
    // A session checks out a dedicated client from the pool for its lifetime.
    getPool.mockResolvedValue({
      connect: async () => ({ query: (...a) => query(...a), release: () => {} }),
    });
  });

  it('starts without a dangling column reference and returns a syncId', async () => {
    const res = await startSession(null, 'IdentityMembers', ['identityId', 'principalId'], IDM_RECORDS, {
      systemId: 7,
    });
    expect(res.syncId).toBeTruthy();
    expect(res).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
  });
});
