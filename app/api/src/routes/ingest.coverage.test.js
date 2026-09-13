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
  SessionLimitError: class SessionLimitError extends Error {},
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

// ── Empty batches ────────────────────────────────────────────────────────────
//
// The handler used to skip ingest() whenever records was empty, so the batch a
// crawler sends to say "this scope is empty now" was accepted and then silently
// ignored — an emptied source kept its rows. ingest() owns that decision now;
// these pin that the handler actually hands it over.
describe('ingest handler — an empty batch still reaches the engine', () => {
  const emptyBody = (syncMode) => ({ systemId: 1, syncMode, records: [] });

  it('calls ingest for an empty FULL batch, so the scope can be reconciled away', async () => {
    mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 4 });
    const res = await request(app).post('/ingest/principals')
      .send({ ...emptyBody('full'), scope: { principalType: 'User' } });

    expect(res.status).toBe(201);
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest.mock.calls[0][4]).toMatchObject({ syncMode: 'full', scope: { principalType: 'User' } });
    // The delete count has to reach the caller — a crawler logs it as the
    // number of rows its reconcile removed.
    expect(res.body.deleted).toBe(4);
  });

  it('an UNSCOPED empty full batch is a no-op, not a wipe of the whole system', async () => {
    // Crawlers post unscoped empty batches routinely — harmless while the API
    // rejected them. Treating one as 'this system has nothing' deletes every row
    // it owns in that table, and for ingest/systems that is the system itself,
    // which then breaks the foreign key on everything ingested after it.
    mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
    const res = await request(app).post('/ingest/principals')
      .send({ systemId: 1, syncMode: 'full', records: [] });

    expect(res.status).toBe(201);
    expect(mockIngest.mock.calls[0][4].scope).toEqual({});
    expect(res.body.deleted).toBe(0);
  });

  it('accepts records:null — PowerShell serialises an empty array as null', async () => {
    // A crawler phase with nothing to send posts null, not []. applyIngestDefaults
    // normalises it; this pins that, because every use downstream indexes records
    // like an array and a regression there would surface as a 500 mid-sync.
    mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 2 });
    const res = await request(app).post('/ingest/principals')
      .send({ systemId: 1, syncMode: 'full', records: null });

    expect(res.status).toBe(201);
    expect(res.body.records).toBe(0);
    expect(res.body.deleted).toBe(2);
  });

  it('calls ingest for an empty DELTA batch too, and lets it decide to do nothing', async () => {
    // Delta is rejected earlier by validation unless deletedIds are present, so
    // this is the shape that reaches the handler: empty records + deletes.
    mockIngest.mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
    const res = await request(app).post('/ingest/principals')
      .send({ systemId: 1, syncMode: 'delta', records: [], deletedIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });

    expect(res.status).toBe(201);
    expect(mockIngest.mock.calls[0][4]).toMatchObject({ syncMode: 'delta' });
    expect(res.body.deleted).toBe(0);
  });
});

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

// ── SEC-2026-09: the per-system boundary, driven through the handler ─────────
//
// These requests carry a crawler identity (set by crawlerAuthMiddleware in
// production). crawlerHasPermission answers from that identity's permissions;
// systemBoundary.js runs for real against the SQL-blind query mock.

const RESTRICTED = { id: 21, systemIds: [7], permissions: ['ingest'] };
const WORKER = { id: 1, systemIds: null, permissions: ['ingest', 'refreshViews', 'admin'] };

function appAs(crawler) {
  return express().use(express.json())
    .use((req, _res, next) => { req.crawler = crawler; next(); })
    .use(router);
}

// Principals' real columns (snake_case, as information_schema returns them).
function stagePrincipalColumns() {
  const cols = ['id', 'system_id', 'display_name', 'extended_attributes', 'risk_score', 'deleted_at'];
  mockQuery.mockImplementation(async (sql) => (/information_schema\.columns/.test(String(sql))
    ? { rows: cols.map(column_name => ({ column_name })) } : { rows: [], rowCount: 0 }));
}

function usePermissionsOfCaller() {
  crawlerAuth.crawlerHasPermission.mockImplementation((req, p) => !!req.crawler?.permissions.includes(p));
}

describe('ingest handler — per-system boundary (H-04)', () => {
  beforeEach(usePermissionsOfCaller);

  it('403 for a record that names another system, and nothing is written', async () => {
    stagePrincipalColumns();
    const res = await request(appAs(RESTRICTED)).post('/ingest/principals').send({
      systemId: 7, syncMode: 'delta', records: [{ displayName: 'x', systemId: 1 }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Record 0: systemId 1 is outside this crawler's systems/);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('403 when the batch would overwrite a row another system owns', async () => {
    mockQuery.mockImplementation(async (sql) => (/jsonb_populate_recordset/.test(String(sql))
      ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const res = await request(appAs(RESTRICTED)).post('/ingest/principals').send({
      systemId: 7, syncMode: 'delta', records: [{ id: UUID, displayName: 'x' }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/would modify a Principals row owned by a system outside/);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('403 for an unscoped full sync of a table without a systemId column', async () => {
    const res = await request(appAs(RESTRICTED)).post('/ingest/identities').send({
      systemId: 7, syncMode: 'full', records: [{ id: UUID, displayName: 'x' }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/needs a scope/);
  });

  it('an in-bounds batch reaches the engine with the allow-list for the reconcile and deletedIds', async () => {
    const res = await request(appAs(RESTRICTED)).post('/ingest/principals').send({
      systemId: 7, syncMode: 'full', records: [{ id: UUID, displayName: 'x' }], deletedIds: [UUID],
    });
    expect(res.status).toBe(201);
    expect(mockIngest.mock.calls[0][4].restrictSystemIds).toEqual([7]);
    const del = mockQuery.mock.calls.find(([sql]) => /DELETE FROM|SET "deletedAt" = now\(\)/.test(String(sql)));
    expect(del[1]).toEqual([[UUID], [7]]);
  });

  it('the built-in worker is not boundary-checked: no lookup, and no allow-list reaches the engine', async () => {
    const res = await request(appAs(WORKER)).post('/ingest/principals').send({
      systemId: 7, syncMode: 'full', records: [{ id: UUID, displayName: 'x', systemId: 1 }],
    });
    expect(res.status).toBe(201);
    expect(mockQuery.mock.calls.some(([sql]) => /jsonb_populate_recordset/.test(String(sql)))).toBe(false);
    expect(mockIngest.mock.calls[0][4].restrictSystemIds).toBeNull();
  });

  it('a session is opened with the caller identity (per-crawler cap + ownership)', async () => {
    await request(appAs(RESTRICTED)).post('/ingest/principals')
      .send({ systemId: 7, syncMode: 'full', syncSession: 'start', scope: { principalType: 'User' }, records: [{ displayName: 'x' }] });
    expect(mockStart.mock.calls[0][4]).toMatchObject({ crawlerId: 21, isWorker: false, restrictSystemIds: [7] });
  });

  it('429 when the session cap is reached', async () => {
    const { SessionLimitError } = await import('../ingest/sessions.js');
    mockStart.mockRejectedValueOnce(new SessionLimitError('Too many open ingest sessions for this crawler (limit 3)'));
    const res = await request(appAs(RESTRICTED)).post('/ingest/principals')
      .send({ systemId: 7, syncMode: 'full', syncSession: 'start', records: [{ displayName: 'x' }] });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/limit 3/);
  });
});

describe('ingest handler — server-managed columns are not writable (H-04)', () => {
  it('a record field named after a server-managed column is kept as an attribute, never written to the column', async () => {
    mockQuery.mockImplementation(async (sql) => (/information_schema\.columns/.test(String(sql))
      ? { rows: ['id', 'system_id', 'display_name', 'risk_score', 'deleted_at'].map(column_name => ({ column_name })) }
      : { rows: [], rowCount: 0 }));
    const res = await request(app).post('/ingest/principals').send({
      systemId: 1, syncMode: 'delta', records: [{ displayName: 'x', riskScore: 0, deletedAt: '2020-01-01' }],
    });
    expect(res.status).toBe(201);
    const rec = mockIngest.mock.calls[0][3][0];
    expect(rec).not.toHaveProperty('riskScore');
    expect(rec).not.toHaveProperty('deletedAt');
    expect(JSON.parse(rec.extendedAttributes)).toEqual({ riskScore: 0, deletedAt: '2020-01-01' });
  });
});

describe('ingest/systems — never reconciled (C-01)', () => {
  it('runs a full sync of systems as a delta', async () => {
    mockQueryOne.mockResolvedValue({ id: 42 });
    const res = await request(app).post('/ingest/systems')
      .send({ records: [{ displayName: 'X', systemType: 'X', tenantId: 'y' }], syncMode: 'full' });
    expect(res.status).toBe(201);
    expect(mockIngest.mock.calls[0][4].syncMode).toBe('delta');
  });

  it('still validates the required fields of a full batch before running it as a delta', async () => {
    const res = await request(app).post('/ingest/systems')
      .send({ records: [{ tenantId: 'y' }], syncMode: 'full' });
    expect(res.status).toBe(400);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('ingest handler — extendedAttributes bounds (L-16)', () => {
  it('400 for a record with more extendedAttributes keys than the limit', async () => {
    stagePrincipalColumns();
    const extendedAttributes = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, 'v']));
    const res = await request(app).post('/ingest/principals')
      .send({ systemId: 1, syncMode: 'delta', records: [{ displayName: 'x', extendedAttributes }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Record 0: extendedAttributes has more than 500 keys/);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('data-plane endpoints (M-05)', () => {
  beforeEach(usePermissionsOfCaller);

  it('sync-log stamps the calling crawler and a system it may access', async () => {
    const res = await request(appAs(RESTRICTED)).post('/ingest/sync-log')
      .send({ syncType: 'X', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:10Z', systemId: 7 });
    expect(res.status).toBe(201);
    const [sql, params] = mockQuery.mock.calls.find(([s]) => /INSERT INTO "GraphSyncLog"/.test(String(s)));
    expect(sql).toContain('"crawlerId", "systemId"');
    expect(params.slice(-2)).toEqual([21, 7]);
  });

  it('sync-log refuses a system the crawler cannot access', async () => {
    const res = await request(appAs(RESTRICTED)).post('/ingest/sync-log')
      .send({ syncType: 'X', startTime: '2026-01-01T00:00:00Z', systemId: 1 });
    expect(res.status).toBe(403);
  });

  it('classify needs refreshViews — an ingest-only key is refused before any UPDATE', async () => {
    const res = await request(appAs(RESTRICTED)).post('/ingest/classify-business-role-assignments').send({});
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('classify from a restricted refreshViews key only flags its own systems', async () => {
    const caller = { ...RESTRICTED, permissions: ['ingest', 'refreshViews'] };
    const res = await request(appAs(caller)).post('/ingest/classify-business-role-assignments').send({});
    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls.find(([s]) => /UPDATE "ResourceAssignments"/.test(String(s)));
    expect(sql).toContain('AND ra."systemId" = ANY($1::int[])');
    expect(params).toEqual([[7]]);
  });

  it('principals-presence passes a restricted key its own systems, and the worker none', async () => {
    const presence = await import('../ingest/crawlerPresence.js');
    await request(appAs(RESTRICTED)).post('/ingest/principals-presence').send({ tenantId: 't1', ids: [UUID] });
    expect(presence.lookupCrawlerPresence.mock.calls.at(-1)[3]).toEqual([7]);
    await request(appAs(WORKER)).post('/ingest/principals-presence').send({ tenantId: 't1', ids: [UUID] });
    expect(presence.lookupCrawlerPresence.mock.calls.at(-1)[3]).toBeNull();
  });

  it('matrix-default-filter is worker-only: an ingest key is refused, the worker is not', async () => {
    const body = { name: 'Default', filter: { rowType: 'user' } };
    expect((await request(appAs(RESTRICTED)).post('/ingest/matrix-default-filter').send(body)).status).toBe(403);
    expect((await request(appAs(WORKER)).post('/ingest/matrix-default-filter').send(body)).status).toBe(201);
  });
});
