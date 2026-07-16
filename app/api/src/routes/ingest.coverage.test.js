/**
 * Coverage unit tests for routes/ingest.js — DB + engine mocked.
 *
 * Exercises the generic createIngestHandler path (validation, permission gates,
 * single-batch ingest, session start/continue/end, delete-by-id, systems id
 * lookup) plus the sync-log, presence, and refresh-views endpoints. The
 * classify endpoint is covered by ingest.classify.test.js, so it's not repeated.
 *
 * validation.js and normalization.js are PURE (no DB) so we use the real ones;
 * engine.js / sessions.js / crawlerAuth.js / syncVersion.js / crawlerPresence.js
 * all touch the DB or hold state, so they're mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const UUID = '11111111-1111-1111-1111-111111111111';

const { mockQuery, mockQueryOne, mockIngest, mockStart, mockContinue, mockEnd, mockHasSession } = vi.hoisted(() => {
  process.env.USE_SQL = 'true';
  return {
    mockQuery: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    mockQueryOne: vi.fn().mockResolvedValue(null),
    mockIngest: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 }),
    mockStart: vi.fn().mockResolvedValue({ syncId: 'sid', inserted: 1, updated: 0 }),
    mockContinue: vi.fn().mockResolvedValue({ syncId: 'sid', inserted: 2, updated: 0 }),
    mockEnd: vi.fn().mockResolvedValue({ syncId: 'sid', inserted: 0, updated: 0, deleted: 3, totalRecords: 5 }),
    mockHasSession: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../db/connection.js', () => ({
  query: mockQuery,
  queryOne: mockQueryOne,
  getPool: vi.fn().mockResolvedValue({ query: mockQuery, request: () => ({ query: mockQuery }) }),
  tx: vi.fn(async (fn) => fn({ query: mockQuery })),
}));

vi.mock('../ingest/engine.js', () => ({
  ingest: mockIngest,
  writeSyncLog: vi.fn().mockResolvedValue(undefined),
  SOFT_DELETE_TABLES: new Set(),
}));

vi.mock('../ingest/sessions.js', () => ({
  startSession: mockStart,
  continueSession: mockContinue,
  endSession: mockEnd,
  hasSession: mockHasSession,
}));

vi.mock('../middleware/crawlerAuth.js', () => ({
  crawlerHasPermission: vi.fn().mockReturnValue(true),
  crawlerHasSystemAccess: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/syncVersion.js', () => ({ bumpSyncVersion: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../ingest/crawlerPresence.js', () => ({
  normalizePresenceQuery: (body) => ({ tenantId: body?.tenantId, ids: body?.ids || [] }),
  lookupCrawlerPresence: vi.fn().mockResolvedValue({ crawlerDataAvailable: true, present: [] }),
}));

const { default: router } = await import('./ingest.js');
const crawlerAuth = await import('../middleware/crawlerAuth.js');
const app = express().use(express.json()).use(router);

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockQueryOne.mockResolvedValue(null);
  mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
  mockHasSession.mockReturnValue(true);
  crawlerAuth.crawlerHasPermission.mockReturnValue(true);
  crawlerAuth.crawlerHasSystemAccess.mockReturnValue(true);
});

// A valid principals record for the happy path.
const goodPrincipal = { records: [{ displayName: 'Alice' }], systemId: 1, syncMode: 'full' };

// ── Permission + validation gates ────────────────────────────────────────────

describe('ingest handler — gates', () => {
  it('403 when the crawler lacks the ingest permission', async () => {
    crawlerAuth.crawlerHasPermission.mockReturnValue(false);
    const res = await request(app).post('/ingest/principals').send(goodPrincipal);
    expect(res.status).toBe(403);
  });

  it('403 when the crawler has no access to the target system', async () => {
    crawlerAuth.crawlerHasSystemAccess.mockReturnValue(false);
    const res = await request(app).post('/ingest/principals').send(goodPrincipal);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/does not have access/i);
  });

  it('400 when systemId is missing (envelope validation)', async () => {
    const res = await request(app).post('/ingest/principals').send({ records: [{ displayName: 'A' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it('400 when records fail schema validation', async () => {
    // principalType not in the allowed enum → record validation rejects.
    const res = await request(app).post('/ingest/principals')
      .send({ records: [{ displayName: 'A', principalType: 'Bogus' }], systemId: 1, syncMode: 'full' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/record validation failed/i);
  });
});

// ── Single-batch happy path ──────────────────────────────────────────────────

describe('ingest handler — single batch', () => {
  it('201 with counts on a valid principals batch', async () => {
    mockIngest.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0 });
    const res = await request(app).post('/ingest/principals').send(goodPrincipal);
    expect(res.status).toBe(201);
    expect(res.body.table).toBe('Principals');
    expect(res.body.inserted).toBe(1);
    expect(res.body.records).toBe(1);
    expect(typeof res.body.durationMs).toBe('number');
    expect(mockIngest).toHaveBeenCalledOnce();
  });

  it('ingests a resources batch (governanceResource derivation path)', async () => {
    mockIngest.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0 });
    // Discover governanceResource as a core column so the derived flag stays
    // top-level rather than being folded into extendedAttributes.
    mockQuery.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && /information_schema\.columns/.test(sql)) {
        return { rows: [{ column_name: 'id' }, { column_name: 'display_name' }, { column_name: 'governance_resource' }], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app).post('/ingest/resources')
      .send({ records: [{ displayName: 'BR', resourceType: 'BusinessRole' }], systemId: 1, syncMode: 'full' });
    expect(res.status).toBe(201);
    expect(res.body.table).toBe('Resources');
    // The handler derived governanceResource=true before calling the engine.
    const normalized = mockIngest.mock.calls[0][3];
    expect(normalized[0].governanceResource).toBe(true);
  });

  it('returns 422 when a contexts batch would create a parentContextId cycle (#627)', async () => {
    // The Contexts acyclicity trigger (migration 059) aborts the ingest() commit
    // with a check_violation; the handler surfaces it as a 422 naming the context
    // rather than an opaque 500.
    mockIngest.mockRejectedValueOnce(Object.assign(
      new Error('Context abc is on a parentContextId cycle — the Contexts tree must stay acyclic'),
      { code: '23514' },
    ));
    const res = await request(app).post('/ingest/contexts').send({
      records: [{ displayName: 'X', variant: 'synced', targetType: 'Principal', contextType: 'Department' }],
      systemId: 1, syncMode: 'delta',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cycle/i);
    expect(res.body.message).toMatch(/parentContextId cycle/i);
  });

  it('still returns 500 for a non-cycle ingest failure', async () => {
    mockIngest.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { code: '42P01' }));
    const res = await request(app).post('/ingest/principals').send(goodPrincipal);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ingest failed/i);
  });

  it('returns systemIds after a systems ingest', async () => {
    mockIngest.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0 });
    mockQueryOne.mockResolvedValue({ id: 42 });
    const res = await request(app).post('/ingest/systems')
      .send({ records: [{ displayName: 'EntraID', systemType: 'EntraID', tenantId: 't1' }], syncMode: 'full' });
    expect(res.status).toBe(201);
    expect(res.body.systemIds).toEqual([42]);
  });

  it('500 when the engine throws', async () => {
    mockIngest.mockRejectedValue(new Error('insert blew up'));
    const res = await request(app).post('/ingest/principals').send(goodPrincipal);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ingest failed/i);
  });
});

// ── Session paths ────────────────────────────────────────────────────────────

describe('ingest handler — sessions', () => {
  it('201 + session:started on syncSession=start', async () => {
    const res = await request(app).post('/ingest/principals')
      .send({ ...goodPrincipal, syncSession: 'start' });
    expect(res.status).toBe(201);
    expect(res.body.session).toBe('started');
    expect(res.body.syncId).toBe('sid');
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it('400 on continue with an unknown syncId', async () => {
    mockHasSession.mockReturnValue(false);
    const res = await request(app).post('/ingest/principals')
      .send({ ...goodPrincipal, syncSession: 'continue', syncId: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('200 + session:continued on a valid continue', async () => {
    const res = await request(app).post('/ingest/principals')
      .send({ ...goodPrincipal, syncSession: 'continue', syncId: 'sid' });
    expect(res.status).toBe(200);
    expect(res.body.session).toBe('continued');
    expect(mockContinue).toHaveBeenCalledOnce();
  });

  it('200 + session:completed with deleted count on end', async () => {
    const res = await request(app).post('/ingest/principals')
      .send({ ...goodPrincipal, syncSession: 'end', syncId: 'sid' });
    expect(res.status).toBe(200);
    expect(res.body.session).toBe('completed');
    expect(res.body.deleted).toBe(3);
    expect(mockEnd).toHaveBeenCalledOnce();
  });
});

// ── delete-by-id path ────────────────────────────────────────────────────────

describe('ingest handler — delete-by-id', () => {
  it('400 when a deletedId is not a UUID', async () => {
    const res = await request(app).post('/ingest/principals')
      .send({ records: [{ displayName: 'A' }], systemId: 1, syncMode: 'delta', deletedIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be uuids/i);
  });

  it('counts hard-deleted rows from a valid deletedIds list', async () => {
    mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
    mockQuery.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && /DELETE FROM "Principals"/.test(sql)) return { rowCount: 2, rows: [] };
      return { rows: [{ column_name: 'id' }, { column_name: 'display_name' }], rowCount: 0 };
    });
    const res = await request(app).post('/ingest/principals')
      .send({ records: [{ displayName: 'A' }], systemId: 1, syncMode: 'delta', deletedIds: [UUID] });
    expect(res.status).toBe(201);
    expect(res.body.deleted).toBe(2);
  });
});

// ── POST /ingest/sync-log ────────────────────────────────────────────────────

describe('POST /ingest/sync-log', () => {
  it('400 when syncType or startTime is missing', async () => {
    const res = await request(app).post('/ingest/sync-log').send({ tableName: 'X' });
    expect(res.status).toBe(400);
  });

  it('201 + durationSeconds on a valid payload', async () => {
    const res = await request(app).post('/ingest/sync-log').send({
      syncType: 'Entra', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:01:00Z',
      recordCount: 5, status: 'Success',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.durationSeconds).toBe(60);
  });

  it('500 when the insert fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/ingest/sync-log').send({
      syncType: 'Entra', startTime: '2026-01-01T00:00:00Z',
    });
    expect(res.status).toBe(500);
  });
});

// ── POST /ingest/contexts — DB-enforced acyclicity (#627) ────────────────────
// The old silent breakCycles-after-ingest repair is gone; a cyclic contexts
// batch now aborts its own commit (migration-059 trigger) and is surfaced as a
// 422 (see the 422 test in "single batch" above). A clean batch must not issue
// the old repair UPDATE.
const CYCLE_REPAIR_RE = /UPDATE\s+"Contexts"[\s\S]*"parentContextId"\s*=\s*NULL/i;
const goodContext = {
  records: [{ displayName: 'Dept', variant: 'synced', targetType: 'Identity', contextType: 'Department' }],
  systemId: 1,
  syncMode: 'full',
};

describe('POST /ingest/contexts — DB-enforced acyclicity', () => {
  it('ingests a clean contexts batch with no app-side cycle repair', async () => {
    mockIngest.mockResolvedValueOnce({ inserted: 1, updated: 0, deleted: 0 });
    const res = await request(app).post('/ingest/contexts').send(goodContext);
    expect(res.status).toBe(201);
    expect(mockQuery.mock.calls.some(([sql]) => CYCLE_REPAIR_RE.test(sql))).toBe(false);
  });
});

// ── POST /ingest/principals-presence ─────────────────────────────────────────

describe('POST /ingest/principals-presence', () => {
  it('400 when tenantId is missing', async () => {
    const res = await request(app).post('/ingest/principals-presence').send({ ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenantid is required/i);
  });

  it('200 with the presence lookup result', async () => {
    const res = await request(app).post('/ingest/principals-presence').send({ tenantId: 't1', ids: [UUID] });
    expect(res.status).toBe(200);
    expect(res.body.crawlerDataAvailable).toBe(true);
  });
});

// ── POST /ingest/refresh-views ───────────────────────────────────────────────

describe('POST /ingest/refresh-views', () => {
  it('403 without refreshViews/admin permission', async () => {
    crawlerAuth.crawlerHasPermission.mockReturnValue(false);
    const res = await request(app).post('/ingest/refresh-views').send({});
    expect(res.status).toBe(403);
  });

  it('200 after refreshing the matrix views', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).post('/ingest/refresh-views').send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/refreshed/i);
  });
});
