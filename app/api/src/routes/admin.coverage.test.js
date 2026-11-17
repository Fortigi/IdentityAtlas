// Additional unit tests for routes/admin.js — raises line coverage by exercising
// the read endpoints (risk-profile/classifiers happy paths, dashboard-stats,
// dashboard-timeseries, history-retention read + prune, auth-settings),
// the danger-zone clean-database guard + happy path, and error paths. DB + authConfig + tombstonePurge mocked; no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter, mountRouterAs } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// admin handlers use native db.query / db.queryOne (the mssql compat shim was
// removed in #663). getPool() is still awaited by the table-existence + ensure*
// helpers, but it's no longer used as an mssql-style request builder.
vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne, tx } from '../db/connection.js';
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../config/authConfig.js', () => ({
  getAuthState: () => ({
    enabled: true,
    tenantId: 'tid',
    clientId: 'cid',
    requiredRoles: ['Admin'],
    loaded: true,
  }),
}));
const purgeExpiredTombstones = vi.fn(async () => ({ purged: { Principals: 3 } }));
vi.mock('../ingest/tombstonePurge.js', () => ({ purgeExpiredTombstones: (...a) => purgeExpiredTombstones(...a) }));

// The clean itself (db/cleanDatabase.js) has its own tests; here it is a stub so
// the route's handling of success and failure can be pinned.
const cleanDatabase = vi.fn();
vi.mock('../db/cleanDatabase.js', () => ({ cleanDatabase: (...a) => cleanDatabase(...a) }));
const scheduleRefresh = vi.fn();
vi.mock('./ingest/matrixViews.js', () => ({ viewRefresh: { schedule: (...a) => scheduleRefresh(...a) } }));

const { default: router } = await import('./admin.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  purgeExpiredTombstones.mockClear();
  cleanDatabase.mockReset();
  scheduleRefresh.mockClear();
  tx.mockClear();
});

// ── GET /admin/risk-profile ──────────────────────────────────────────────────
describe('GET /admin/risk-profile', () => {
  it('returns the profile when a row exists', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'p1', displayName: 'Prod', domain: 'd', industry: 'i', country: 'c',
        llmProvider: 'openai', llmModel: 'gpt', version: 5, isActive: true,
        createdAt: 'now', updatedAt: 'now', profile: { domain: 'd' },
      }],
    });
    const res = await request(app).get('/api/admin/risk-profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, source: 'sql', id: 'p1', domain: 'd' });
  });

  it('falls back to available:false when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/risk-profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });
});

// ── GET /admin/classifiers ───────────────────────────────────────────────────
describe('GET /admin/classifiers', () => {
  it('reports unavailable when there is no row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/admin/classifiers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });

  it('returns the classifier set when a row exists', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'c1', profileId: 'p1', displayName: 'C', llmProvider: 'openai',
        llmModel: 'gpt', version: 5, isActive: true, createdAt: 'now',
        updatedAt: 'now', classifiers: [{ k: 'v' }], schedules: null,
      }],
    });
    const res = await request(app).get('/api/admin/classifiers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, id: 'c1', profileId: 'p1' });
    expect(res.body.schedules).toEqual([]);
  });

  it('falls back to available:false when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/classifiers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });
});

// ── GET /admin/dashboard-stats ───────────────────────────────────────────────
describe('GET /admin/dashboard-stats', () => {
  it('returns stats with llmConfigured + hasData flags', async () => {
    // 1st queryOne = the big stats SELECT; 2nd = LLM_CONFIG; 3rd = Secrets key
    queryOne
      .mockResolvedValueOnce({ users: 10, resources: 5, systems: 1 })
      .mockResolvedValueOnce({ '?column?': 1 })
      .mockResolvedValueOnce({ '?column?': 1 });
    const res = await request(app).get('/api/admin/dashboard-stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ users: 10, resources: 5, llmConfigured: true, hasData: true });
    // SEC-2026-09 M-06: the built-in worker is excluded by its flag, not its name.
    expect(queryOne.mock.calls[0][0]).toContain('NOT "isBuiltIn"');
    expect(queryOne.mock.calls[0][0]).not.toContain('Built-in Worker');
    // The exact counts are of live rows; a soft-deleted business role or
    // assignment is history, not something the tenant currently has.
    const sql = queryOne.mock.calls[0][0];
    expect(sql).toMatch(/'BusinessRole' AND "deletedAt" IS NULL\)\s+AS "businessRoles"/);
    expect(sql).toMatch(/"governed" = true AND "deletedAt" IS NULL\)\s+AS "governedAssignments"/);
    expect(sql).toMatch(/"identityId" IS NOT NULL AND "deletedAt" IS NULL\)\s+AS "identityAssignments"/);
  });

  it('500 when the stats query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/dashboard-stats');
    expect(res.status).toBe(500);
  });
});

// ── GET /admin/dashboard-timeseries ──────────────────────────────────────────
describe('GET /admin/dashboard-timeseries', () => {
  it('returns empty data when the snapshot table does not exist', async () => {
    queryOne.mockResolvedValueOnce({ t: null });
    const res = await request(app).get('/api/admin/dashboard-timeseries');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [] });
  });

  it('returns rows when snapshots exist (clamps the days param)', async () => {
    queryOne.mockResolvedValueOnce({ t: 'DashboardSnapshots' });
    query.mockResolvedValueOnce({ rows: [{ date: '2026-01-01', systems: 1 }] });
    const res = await request(app).get('/api/admin/dashboard-timeseries?days=9999');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(730);
    expect(res.body.data).toHaveLength(1);
  });

  it('500 when the existence check rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/dashboard-timeseries');
    expect(res.status).toBe(500);
  });
});

// ── GET /admin/history-retention ─────────────────────────────────────────────
describe('GET /admin/history-retention', () => {
  it('returns the configured value + row count', async () => {
    queryOne
      .mockResolvedValueOnce({ configValue: '90' })  // WorkerConfig
      .mockResolvedValueOnce({ n: '42' });            // _history count
    const res = await request(app).get('/api/admin/history-retention');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retentionDays: 90, totalRows: 42 });
  });

  it('falls back to the default when no config row exists', async () => {
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ n: '0' });
    const res = await request(app).get('/api/admin/history-retention');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retentionDays: 180 });
  });

  it('500 when the config read rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/history-retention');
    expect(res.status).toBe(500);
  });
});

// ── POST /admin/history-retention/prune ──────────────────────────────────────
describe('POST /admin/history-retention/prune', () => {
  it('prunes history + tombstones when retention is enabled', async () => {
    queryOne.mockResolvedValueOnce({ configValue: '30' });
    query.mockResolvedValueOnce({ rowCount: 7 });   // DELETE FROM _history
    const res = await request(app).post('/api/admin/history-retention/prune');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: 7, retentionDays: 30 });
    expect(purgeExpiredTombstones).toHaveBeenCalledWith(expect.anything(), 30);
  });

  it('does nothing when retention is disabled (0 days)', async () => {
    queryOne.mockResolvedValueOnce({ configValue: '0' });
    const res = await request(app).post('/api/admin/history-retention/prune');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: 0 });
    expect(purgeExpiredTombstones).not.toHaveBeenCalled();
  });

  it('500 when pruning rejects', async () => {
    queryOne.mockResolvedValueOnce({ configValue: '30' });
    purgeExpiredTombstones.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/admin/history-retention/prune');
    expect(res.status).toBe(500);
  });
});

// ── GET /admin/auth-settings ─────────────────────────────────────────────────
describe('GET /admin/auth-settings', () => {
  it('returns the auth snapshot with docker platform', async () => {
    const res = await request(app).get('/api/admin/auth-settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true, tenantId: 'tid', clientId: 'cid', platform: 'docker',
    });
    expect(res.body.requiredRoles).toEqual(['Admin']);
  });
});

// ── POST /admin/clean-database (danger zone) ─────────────────────────────────
describe('POST /admin/clean-database', () => {
  const CONFIRM = { confirm: 'DELETE ALL DATA' };
  // The destructive limiter (5/min) is keyed per signed-in caller, so each test
  // acts as its own admin instead of sharing the loopback address's bucket.
  let adminSeq = 0;
  const asAdmin = (oid = `admin-${++adminSeq}`) => mountRouterAs(router, () => ({ oid }));

  it('limits destructive calls per admin, not per shared address (SEC-2026-09 M-09)', async () => {
    const busy = asAdmin('busy-admin');
    for (let i = 0; i < 5; i++) {
      expect((await request(busy).post('/api/admin/clean-database').send({})).status).toBe(400);
    }
    expect((await request(busy).post('/api/admin/clean-database').send({})).status).toBe(429);
    // A different admin arriving from the same address still has their own quota.
    expect((await request(asAdmin('other-admin')).post('/api/admin/clean-database').send({})).status).toBe(400);
  });

  // SEC-2026-09 H-07: the wipe needs an explicit confirmation body.
  for (const [label, send] of [
    ['no body', undefined],
    ['a text/plain body', 'confirm=DELETE ALL DATA'],
    ['the wrong phrase', { confirm: 'delete all data' }],
    ['the phrase under another key', { confirmation: 'DELETE ALL DATA' }],
  ]) {
    it(`400 without touching the database for ${label}`, async () => {
      let req = request(asAdmin()).post('/api/admin/clean-database');
      if (typeof send === 'string') req = req.set('Content-Type', 'text/plain');
      const res = await (send === undefined ? req : req.send(send));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Confirmation required/);
      expect(query).not.toHaveBeenCalled();
    });
  }

  it('runs the clean inside one transaction, analyzes what it touched and rebuilds the matrix views', async () => {
    cleanDatabase.mockResolvedValueOnce({
      wiped: [{ table: 'Principals', rowsAffected: 4 }],
      alsoRemoved: [{ table: 'SystemOwners', rowsAffected: 1 }],
      historyRowsRemoved: 9,
      touched: ['Principals', 'Systems'],
    });
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(asAdmin()).post('/api/admin/clean-database').send(CONFIRM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Database cleaned',
      wiped: [{ table: 'Principals', rowsAffected: 4 }],
      alsoRemoved: [{ table: 'SystemOwners', rowsAffected: 1 }],
      historyRowsRemoved: 9,
    });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(cleanDatabase).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(c => c[0])).toEqual(['ANALYZE "Principals"', 'ANALYZE "Systems"']);
    expect(scheduleRefresh).toHaveBeenCalledWith('clean-database');
  });

  it('still answers 200 when ANALYZE fails after the clean committed', async () => {
    cleanDatabase.mockResolvedValueOnce({ wiped: [], alsoRemoved: [], historyRowsRemoved: 0, touched: ['Principals'] });
    query.mockRejectedValue(new Error('analyze broke'));
    const res = await request(asAdmin()).post('/api/admin/clean-database').send(CONFIRM);
    expect(res.status).toBe(200);
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
  });

  it('500 with no SQL detail and no follow-up work when the clean fails (the transaction rolls back)', async () => {
    cleanDatabase.mockRejectedValueOnce(new Error('update or delete on table "Systems" violates foreign key constraint'));
    const res = await request(asAdmin()).post('/api/admin/clean-database').send(CONFIRM);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Clean database failed. Nothing was removed.' });
    expect(JSON.stringify(res.body)).not.toMatch(/Systems|foreign key/);
    expect(query).not.toHaveBeenCalled();
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });
});

describe('GET /admin/clean-database/plan', () => {
  it('returns the classification-built lists the dialog shows, with the confirmation phrase', async () => {
    const res = await request(app).get('/api/admin/clean-database/plan');
    expect(res.status).toBe(200);
    expect(res.body.confirmation).toBe('DELETE ALL DATA');
    expect(res.body.removed.map(g => g.key)).toContain('source');
    expect(res.body.kept.map(g => g.key)).toContain('manual');
    expect(res.body.alsoRemoved.find(a => a.tables.includes('ManagerHierarchyOverrides'))).toBeTruthy();
    expect(query).not.toHaveBeenCalled(); // no database needed to describe the clean
  });
});
