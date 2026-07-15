// Mode-dispatch tests for /matrix/data. With USE_SQL='true' and the DB layer
// mocked, each request drives the dispatcher into a specific extracted handler
// (flat grid / roll-up / roll-up-roles / attribute-fold / context zoom /
// context layered) and asserts the shape that handler assembles. The SQL builders
// run for real (they're pure string builders); timedQuery returns empty rows.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true';

let currentFilter;
// Render-closure shape: each query re-invokes subject()/resource() with its own
// binder; here they return an empty (no-scope) fragment.
const BUILT = {
  subject: () => ({ sql: null }),
  resource: () => ({ sql: null }),
  hasSubject: false,
  hasResource: false,
  principalCols: [], identityCols: [], resourceCols: [], warnings: [],
};

vi.mock('../../db/connection.js', () => ({ getPool: vi.fn(async () => ({})), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({
  timedQuery: async () => ({ rows: [] }),
}));
vi.mock('./shared.js', async (orig) => ({
  ...(await orig()),
  parseFilter: () => currentFilter,
  buildSubqueries: async () => ({ ...BUILT, warnings: [] }),
  scopeCounts: async () => ({ subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0 }),
}));

const { default: dataRouter } = await import('./data.js');
const app = express().use(express.json()).use(dataRouter);

const UUID = '11111111-1111-1111-1111-111111111111';
const post = (filter) => { currentFilter = filter; return request(app).post('/matrix/data').send({ filter }); };

describe('POST /matrix/data — mode dispatch (mocked DB)', () => {
  it('flat grid: a plain filter returns the per-subject data payload', async () => {
    const res = await post({ rowType: 'principal', rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('managedByPackages');
    expect(res.body.rowType).toBe('principal');
  });

  it('roll-up (resources): filter.rollup routes to handleRollupResources', async () => {
    const res = await post({ rowType: 'principal', rollup: 'ext.costCenter', rollupContent: 'resources-only', rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body.rollup).toBe('ext.costCenter');
    expect(res.body).toHaveProperty('resources');
    expect(res.body).toHaveProperty('groupValues');
    expect(res.body).toHaveProperty('counts');
  });

  it('roll-up (roles-only): routes to handleRollupRoles', async () => {
    const res = await post({ rowType: 'principal', rollup: 'ext.costCenter', rollupContent: 'roles-only', rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body.rollupContent).toBe('roles-only');
    expect(res.body).toHaveProperty('roleRows');
  });

  it('attribute fold: foldAttributes routes to handleAttributeFold', async () => {
    const res = await post({ rowType: 'principal', foldAttributes: true, sortAttributes: [{ attribute: 'ext.costCenter' }], rollupCollapsed: [], rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body.layeredAttributes).toBe(true);
    expect(res.body.rollupKind).toBe('context');
  });

  it('context zoom: rollupKind=context routes to handleContextZoom', async () => {
    const res = await post({ rowType: 'principal', rollupKind: 'context', rollupContextId: UUID, rollupContent: 'resources-only', rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body.rollupKind).toBe('context');
    expect(res.body).toHaveProperty('breadcrumb');
  });

  it('context layered: sortHierarchy routes to handleContextLayered', async () => {
    const res = await post({ rowType: 'principal', sortHierarchy: { contextId: UUID }, rollupExpanded: [], rollupPath: [] });
    expect(res.status).toBe(200);
    expect(res.body.layered).toBe(true);
    expect(res.body.rollupKind).toBe('context');
  });

  it('rejects an invalid context id with 400', async () => {
    const res = await post({ rowType: 'principal', rollupKind: 'context', rollupContextId: 'not-a-uuid', rollupPath: [] });
    expect(res.status).toBe(400);
  });
});
