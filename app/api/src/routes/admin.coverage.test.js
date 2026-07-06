// Additional unit tests for routes/admin.js — raises line coverage by exercising
// the read endpoints (risk-profile/classifiers happy paths, dashboard-stats,
// dashboard-timeseries, history-retention read + prune, auth-settings),
// the danger-zone clean-database guard + happy path, the curated export/import
// handlers, and error paths. DB + authConfig + tombstonePurge mocked; no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();

// getPool() returns an object whose .request() builds an mssql-style chainable
// query builder. Tests override poolQuery per-case to control recordset output.
let poolQuery = vi.fn(async () => ({ recordset: [] }));
vi.mock('../db/connection.js', () => ({
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
  getPool: async () => ({
    request: () => {
      const r = { input() { return r; }, query: (...a) => poolQuery(...a) };
      return r;
    },
  }),
  default: {},
}));
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

// tags.js / categories.js / bootstrap / memberCounts are dynamically imported by
// the curated-import handler. Tags are written to Contexts + ContextMembers
// (GraphTags/GraphTagAssignments are read-only views), reusing tags.js helpers.
vi.mock('./tags.js', () => ({
  ensureTagTables: vi.fn(async () => {}),
  ENTITY_TO_TARGET: { user: 'Principal', group: 'Resource', resource: 'Resource', identity: 'Identity' },
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}));
vi.mock('./categories.js', () => ({ ensureCategoryTables: vi.fn(async () => {}) }));
vi.mock('../bootstrap.js', () => ({ getOrCreateTagRoot: vi.fn(async () => 'tag-root') }));
vi.mock('../contexts/memberCounts.js', () => ({ recalcMemberCountsForChain: vi.fn(async () => {}) }));

const { default: router } = await import('./admin.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  purgeExpiredTombstones.mockClear();
  poolQuery = vi.fn(async () => ({ recordset: [] }));
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
  it('wipes existing tables and reports skipped ones', async () => {
    // 1) existence batch check — only two tables "exist"
    query.mockResolvedValueOnce({
      rows: [
        { tbl: 'Identities', oid: 1234 },
        { tbl: 'Systems', oid: 5678 },
      ],
    });
    // every subsequent query (DELETE, _history clean, ANALYZE, sequence lookup,
    // setval, CrawlerConfigs reset) resolves with an empty result.
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(app).post('/api/admin/clean-database');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Database cleaned');
    const wipedTables = res.body.wiped.map(w => w.table);
    expect(wipedTables).toContain('Identities');
    expect(wipedTables).toContain('Systems');
    expect(res.body.skipped.length).toBeGreaterThan(0);
  });

  it('500 when the existence batch check rejects (generic error, no leak)', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/admin/clean-database');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Clean database failed');
    expect(JSON.stringify(res.body)).not.toContain('boom'); // internal detail not leaked
  });
});

// ── GET /admin/export/curated ────────────────────────────────────────────────
describe('GET /admin/export/curated', () => {
  it('exports an empty payload when neither source table exists', async () => {
    // tableExists() -> db.query(SELECT to_regclass) returns oid null for all
    query.mockResolvedValue({ rows: [{ oid: null }] });
    const res = await request(app).get('/api/admin/export/curated');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/FGCuratedData_/);
    expect(res.body).toMatchObject({ version: '1.0', tags: [], categories: [] });
  });

  it('500 when a lookup query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/admin/export/curated');
    expect(res.status).toBe(500);
  });
});

// ── POST /admin/import/curated ───────────────────────────────────────────────
describe('POST /admin/import/curated', () => {
  it('400 when tags is not an array', async () => {
    const res = await request(app).post('/api/admin/import/curated').send({ tags: 'nope' });
    expect(res.status).toBe(400);
  });

  it('imports tags + categories and returns stats', async () => {
    // tableExists() calls (Principals, Resources) -> default poolQuery returns
    // empty recordset, so resolveEntity treats entities as non-existent.
    // db.query is used for: to_regclass checks, tag upsert (Contexts), category
    // upsert, assignment lookups/inserts (ContextMembers). queryOne is used for
    // the existing-tag lookup. Drive them through a default + specific mocks.
    query.mockImplementation(async (sql) => {
      if (/to_regclass/i.test(sql)) return { rows: [{ oid: 1 }] };            // tables exist
      if (/INSERT INTO "Contexts"/i.test(sql)) return { rows: [{ id: 'tag1' }] };
      if (/INSERT INTO "GovernanceCategories"/i.test(sql)) return { rows: [{ id: 'cat1' }] };
      if (/INSERT INTO "ContextMembers"/i.test(sql)) return { rows: [{ inserted: 1 }] };
      if (/FROM "Resources"/i.test(sql)) return { rows: [{ id: 'apid' }] };    // GUID match
      if (/INSERT INTO "GovernanceCategoryAssignments"/i.test(sql)) return { rows: [{ inserted: 1 }] };
      return { rows: [] };
    });
    queryOne.mockResolvedValue(undefined); // no existing tag → insert path
    // resolveEntity uses pool.request().query -> return a hit so the tag
    // assignment resolves via GUID match.
    poolQuery = vi.fn(async () => ({ recordset: [{ n: 1 }] }));

    const body = {
      tags: [{
        name: 'Sensitive', entityType: 'user', color: '#abcdef',
        assignments: [{ entityId: '11111111-1111-1111-1111-111111111111', displayName: 'Alice' }],
      }],
      categories: [{
        name: 'Finance', color: 'bad-color',
        assignments: [{ accessPackageId: 'AP-1', accessPackageDisplayName: 'Finance AP' }],
      }],
    };
    const res = await request(app).post('/api/admin/import/curated').send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stats.tagsInserted).toBe(1);
    expect(res.body.stats.assignmentsInserted).toBe(1);
    expect(res.body.stats.catsInserted).toBe(1);
  });

  it('500 when ensureTagTables setup throws via a rejected query', async () => {
    // tableExists for the first to_regclass resolves, but the tag upsert path
    // is never reached because we make getPool-driven setup blow up: simplest
    // is to reject the to_regclass existence check.
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post('/api/admin/import/curated')
      .send({ tags: [], categories: [] });
    expect(res.status).toBe(500);
  });
});
