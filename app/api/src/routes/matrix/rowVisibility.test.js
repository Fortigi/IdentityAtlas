// Default row visibility, end-to-end across the matrix surfaces (#937).
//
// The mechanism is one clause pushed into the resource fragment that
// buildSubqueries hands out, on the claim that every matrix mode embeds that
// fragment. This file is what tests the claim: the routers run for real (only
// the DB, the SQL timer and the column cache are mocked), every SQL string the
// request emits is captured, and each mode is asserted to constrain its
// resource axis by the clause. A mode that grew its own resource query and
// bypassed the fragment shows up here as a red test, not as business-role rows
// reappearing in one view months later.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true';

const sqls = [];

vi.mock('../../db/connection.js');   // src/db/__mocks__/connection.js
vi.mock('../../perf/sqlTimer.js', () => ({
  timedQuery: async (_p, label, _res, sql) => { sqls.push({ label, sql }); return { rows: [] }; },
}));
vi.mock('../../db/columnCache.js', () => ({
  getPrincipalColumns: async () => [{ name: 'department', rawName: 'department', type: 'text' }],
  getResourceColumns: async () => [{ name: 'resourceType', rawName: 'resourceType', type: 'text' }],
  discoverColumnValues: async () => ({ values: {}, truncated: {} }),
  discoverExtendedAttrValues: async () => ({ values: {}, truncated: {} }),
  mergeValueSets: (a) => a,
  valuePageSize: () => 100,
}));
// The capability-containment branch of the nested-group expansion needs a real
// resource tree; returning null routes the request to the group-membership
// branch, which is the one that embeds the resource fragment.
vi.mock('../../effectiveAccess/engine.js', () => ({ expandCapabilityDown: async () => null }));

const { query, queryOne } = await import('../../db/connection.js');
query.mockResolvedValue({ rows: [] });
queryOne.mockResolvedValue(null);

const { default: dataRouter } = await import('./data.js');
const { default: scopeRouter } = await import('./scope.js');
const { default: matrixRouter } = await import('../matrix.js');
const { default: nestedRouter } = await import('../permissions/nestedGroups.js');

const app = express().use(express.json())
  .use(dataRouter).use(scopeRouter).use(matrixRouter).use(nestedRouter);

const HIDDEN = `"resourceType" NOT IN ('BusinessRole')`;
const UUID = '11111111-1111-1111-1111-111111111111';

// Every captured query that constrains a resource axis at all.
const resourceScopedSqls = () => sqls.filter(q => /FROM "Resources"/.test(q.sql));

beforeEach(() => { sqls.length = 0; });

// One entry per surface that puts resources on an axis. `body` is the request
// body; `path` the endpoint. Each is asserted twice — hidden by default, shown
// with the flag — so a mode that ignores the fragment fails one of the two.
const SURFACES = [
  ['flat per-subject grid', '/matrix/data', { rowType: 'principal' }],
  ['roll-up (resources and roles)', '/matrix/data', { rowType: 'principal', rollup: 'department' }],
  ['roll-up (resources only)', '/matrix/data', { rowType: 'principal', rollup: 'department', rollupContent: 'resources-only' }],
  ['attribute fold', '/matrix/data', { rowType: 'principal', foldAttributes: true, sortAttributes: [{ attribute: 'department' }] }],
  ['context zoom', '/matrix/data', { rowType: 'principal', rollupKind: 'context', rollupContextId: UUID, rollupContent: 'resources-only' }],
  ['wizard preview', '/matrix/preview', { rowType: 'principal' }],
  ['scope stats', '/matrix/scope-stats', { rowType: 'principal' }],
  ['scope breakdown', '/matrix/scope-breakdown', { rowType: 'principal' }],
];

describe('business roles are off the resource axis by default', () => {
  it.each(SURFACES)('%s hides them', async (_name, path, filter) => {
    const res = await request(app).post(path).send({ filter });
    expect(res.status).toBe(200);
    const scoped = resourceScopedSqls();
    // The mode must both query the resource axis and constrain it — asserting
    // only "every query that mentions Resources has the clause" would pass
    // vacuously for a mode that emitted no such query at all.
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every(q => q.sql.includes(HIDDEN))).toBe(true);
  });

  it.each(SURFACES)('%s shows them when the matrix opts in', async (_name, path, filter) => {
    const res = await request(app).post(path).send({ filter: { ...filter, includeBusinessRoles: true } });
    expect(res.status).toBe(200);
    expect(sqls.some(q => q.sql.includes(HIDDEN))).toBe(false);
  });
});

describe('the explicit-scope override', () => {
  const brScope = {
    rowType: 'principal',
    resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['BusinessRole'] }], exclude: [] },
  };

  it('keeps a "which access packages do users hold" matrix buildable', async () => {
    const res = await request(app).post('/matrix/data').send({ filter: brScope });
    expect(res.status).toBe(200);
    // The user's own condition survives; the default exclusion does not fight it.
    expect(sqls.some(q => q.sql.includes(`"resourceType"::text IN`))).toBe(true);
    expect(sqls.some(q => q.sql.includes(HIDDEN))).toBe(false);
  });

  it('does not fire for a scope on a different resource type', async () => {
    await request(app).post('/matrix/data').send({ filter: { ...brScope, resource: {
      include: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }], exclude: [] } } });
    expect(sqls.some(q => q.sql.includes(HIDDEN))).toBe(true);
  });
});

describe('roles-only roll-up and nested-group expansion', () => {
  it('leaves the "business roles only" roll-up untouched — roles ARE the rows there', async () => {
    const res = await request(app).post('/matrix/data')
      .send({ filter: { rowType: 'principal', rollup: 'department', rollupContent: 'roles-only' } });
    expect(res.status).toBe(200);
    // Its rows come from the business-role view keyed by business role, not
    // from the resource axis, so nothing may constrain them away.
    const roleRows = sqls.filter(q => /vw_UserPermissionAssignmentViaBusinessRole/.test(q.sql));
    expect(roleRows.length).toBeGreaterThan(0);
    expect(roleRows.some(q => q.sql.includes(HIDDEN))).toBe(false);
  });

  it('hides business roles when a group row is expanded into its nested resources', async () => {
    const res = await request(app).post(`/group/${UUID}/nested-groups`)
      .send({ filter: { rowType: 'principal' } });
    expect(res.status).toBe(200);
    const nested = sqls.filter(q => /nested-groups/.test(q.label));
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every(q => q.sql.includes(HIDDEN))).toBe(true);
  });

  it('returns every nested resource for a plain GET with no matrix filter', async () => {
    // No filter body → no scope at all, the pre-existing contract. The policy
    // clause must not smuggle a scope into a request that never had one.
    const res = await request(app).get(`/group/${UUID}/nested-groups`);
    expect(res.status).toBe(200);
    expect(sqls.some(q => q.sql.includes(HIDDEN))).toBe(false);
  });
});
