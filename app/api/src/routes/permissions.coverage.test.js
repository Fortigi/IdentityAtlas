// Coverage unit tests for routes/permissions.js — DB fully mocked.
// Exercises /permissions (filters, userLimit, context filters, effective-access,
// empty/error paths), /user-columns, /sync-log, /groups-with-nested,
// /group/:id/nested-groups. Complements permissions.test.js (which only covers
// the access-package flatten); no overlapping cases here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// Shim callers still in this router (grid, nested-groups) go through
// timedRequest; native #663 callers (access-packages, sync-log) go through
// timedQuery. Both pull the next queued result from stageQuery — timedQuery
// normalises .recordset → .rows so a handler reading either shape gets the
// staged rows without the test staging having to change.
const stageQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => {
    const self = { input() { return self; }, query: (sql) => stageQuery(sql) };
    return self;
  },
  timedQuery: async (_p, _l, _r, text, params) => {
    const r = await stageQuery(text, params);
    if (r == null) return r;
    const arr = r.rows ?? r.recordset ?? [];
    return { ...r, rows: arr, recordset: arr };
  },
  getQueryTimings: () => [],
}));

// db.getPool() → pool whose .request().query() is used for the Principals
// table-check in /permissions. db.query() is used for context-filter +
// effective-access paths.
const dbQuery = vi.fn();
const poolRequestQuery = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ request: () => ({ query: (sql) => poolRequestQuery(sql) }) }),
  query: (...a) => dbQuery(...a),
  queryOne: vi.fn(),
}));

vi.mock('./tags.js', () => ({ ensureTagTables: async () => {} }));
vi.mock('./categories.js', () => ({ ensureCategoryTables: async () => {} }));
vi.mock('../mock/data.js', () => ({ permissionAssignments: [] }));

const getPrincipalOrUserColumns = vi.fn(async () => []);
const getResourceColumns = vi.fn(async () => []);
const getPrincipalOrUserColumnValues = vi.fn(async () => ({}));
vi.mock('../db/columnCache.js', () => ({
  getGroupColumns: vi.fn(async () => []),
  getResourceColumns: (...a) => getResourceColumns(...a),
  getPrincipalOrUserColumns: (...a) => getPrincipalOrUserColumns(...a),
  getPrincipalOrUserColumnValues: (...a) => getPrincipalOrUserColumnValues(...a),
}));

const parseAndResolveContextFilters = vi.fn(async () => []);
const buildContextFilterSql = vi.fn(() => ({
  principalClauses: [], resourceClauses: [],
  innerPrincipalClauses: [], innerResourceClauses: [], bindings: {},
}));
vi.mock('../contexts/contextFilters.js', () => ({
  parseAndResolveContextFilters: (...a) => parseAndResolveContextFilters(...a),
  buildContextFilterSql: (...a) => buildContextFilterSql(...a),
}));

const expandCapabilityDown = vi.fn(async () => null);
const effectiveAccessForNodes = vi.fn(async () => ({ rows: [] }));
vi.mock('../effectiveAccess/engine.js', () => ({
  expandCapabilityDown: (...a) => expandCapabilityDown(...a),
  effectiveAccessForNodes: (...a) => effectiveAccessForNodes(...a),
}));

// matrix/shared.js turns a matrix filter into resource-scope SQL — its own
// suite covers that. Here we stub it so the nested-groups POST path receives a
// deterministic resource subquery and we can assert the nesting query embeds it.
// parseFilter stays trivially truthy/null so the "filter present?" branch works.
const buildSubqueriesMock = vi.fn(async () => ({
  resourceSql: '(SELECT id FROM "Resources" WHERE "resourceType"::text IN (@rf_a_inc_0_0))',
  bindings: { rf_a_inc_0_0: 'Group' },
}));
vi.mock('./matrix/shared.js', () => ({
  parseFilter: (body) => (body && body.filter ? body.filter : null),
  buildSubqueries: (...a) => buildSubqueriesMock(...a),
}));

const { default: router } = await import('./permissions.js');
const app = mountRouter(router);

const rs = (recordset) => ({ recordset });
const PRINCIPALS_EXISTS = rs([{ principalsExists: true }]);

beforeEach(() => {
  stageQuery.mockReset();
  dbQuery.mockReset();
  poolRequestQuery.mockReset();
  getPrincipalOrUserColumns.mockReset().mockResolvedValue([]);
  getResourceColumns.mockReset().mockResolvedValue([]);
  getPrincipalOrUserColumnValues.mockReset().mockResolvedValue({});
  parseAndResolveContextFilters.mockReset().mockResolvedValue([]);
  buildContextFilterSql.mockReset().mockReturnValue({
    principalClauses: [], resourceClauses: [],
    innerPrincipalClauses: [], innerResourceClauses: [], bindings: {},
  });
  expandCapabilityDown.mockReset().mockResolvedValue(null);
  effectiveAccessForNodes.mockReset().mockResolvedValue({ rows: [] });
  buildSubqueriesMock.mockClear();
});

// ─── GET /api/permissions ──────────────────────────────────────────────────
describe('GET /api/permissions', () => {
  it('returns empty data when Principals table is absent', async () => {
    poolRequestQuery.mockResolvedValueOnce(rs([{ principalsExists: null }]));
    const res = await request(app).get('/api/permissions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], totalUsers: 0, managedByPackages: [] });
  });

  it('no-limit happy path returns data + totals + AP mapping', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    getPrincipalOrUserColumns.mockResolvedValue([{ name: 'department' }, { name: 'displayName' }]);
    getResourceColumns.mockResolvedValue([{ name: 'displayName' }]);
    stageQuery
      .mockResolvedValueOnce(rs([{ memberId: 'u1', resourceId: 'r1', membershipType: 'Direct' }])) // main
      .mockResolvedValueOnce(rs([{ totalUsers: 42 }]))                                              // total
      .mockResolvedValueOnce(rs([{ memberId: 'u1', resourceId: 'r1', groupId: 'r1', accessPackageIds: 'ap1,ap2' }])); // AP

    const res = await request(app).get('/api/permissions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.totalUsers).toBe(42);
    expect(res.body.managedByPackages).toEqual([
      { memberId: 'u1', resourceId: 'r1', groupId: 'r1', accessPackageIds: ['ap1', 'ap2'] },
    ]);
  });

  it('swallows a missing AP view (42P01) and still returns data', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    stageQuery
      .mockResolvedValueOnce(rs([{ memberId: 'u1' }]))     // main
      .mockResolvedValueOnce(rs([{ totalUsers: 1 }]))      // total
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: '42P01' })); // AP view absent
    const res = await request(app).get('/api/permissions');
    expect(res.status).toBe(200);
    expect(res.body.managedByPackages).toEqual([]);
  });

  it('applies user + group filters (validated against discovered columns)', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    getPrincipalOrUserColumns.mockResolvedValue([{ name: 'department' }]);
    getResourceColumns.mockResolvedValue([{ name: 'displayName' }]);
    stageQuery
      .mockResolvedValueOnce(rs([]))                 // main
      .mockResolvedValueOnce(rs([{ totalUsers: 0 }])) // total
      .mockResolvedValueOnce(rs([]));                // AP
    const filters = JSON.stringify({ department: 'HR', resourceDisplayName: 'Eng', bogusField: 'x', empty: '' });
    const res = await request(app).get('/api/permissions?filters=' + encodeURIComponent(filters));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('ignores malformed filters JSON', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    stageQuery
      .mockResolvedValueOnce(rs([]))
      .mockResolvedValueOnce(rs([{ totalUsers: 0 }]))
      .mockResolvedValueOnce(rs([]));
    const res = await request(app).get('/api/permissions?filters=%7Bnot-json');
    expect(res.status).toBe(200);
  });

  it('userLimit top-N branch returns data + AP mapping', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    stageQuery
      .mockResolvedValueOnce(rs([{ memberId: 'u9', resourceId: 'r9' }])) // main (limited)
      .mockResolvedValueOnce(rs([{ totalUsers: 7 }]))                    // total
      .mockResolvedValueOnce(rs([{ memberId: 'u9', resourceId: 'r9', groupId: 'r9', accessPackageIds: null }])); // AP
    const res = await request(app).get('/api/permissions?userLimit=25');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.managedByPackages[0].accessPackageIds).toEqual([]);
  });

  it('500s when the main query rejects with a non-schema error', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    stageQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/permissions');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('effective-access path returns engine rows for a Resource context', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    parseAndResolveContextFilters.mockResolvedValue([
      { id: 'ctx-1', includeChildren: false, targetType: 'Resource' },
    ]);
    // member-id lookup, then the formatted eff query, then totals.
    dbQuery
      .mockResolvedValueOnce({ rows: [{ memberId: 'node-1' }] })                 // memberIds
      .mockResolvedValueOnce({ rows: [{ resourceId: 'r1', memberId: 'u1' }] })   // fmt rows
      .mockResolvedValueOnce({ rows: [{ totalUsers: 5 }] });                     // totals
    effectiveAccessForNodes.mockResolvedValue({
      rows: [{ resourceId: 'r1', principalId: 'u1', membershipType: 'Direct', displayName: 'Eng', resourceType: 'AzureRole' }],
    });
    const res = await request(app).get('/api/permissions?contextFilters=%5B%5D');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ resourceId: 'r1', memberId: 'u1' }]);
    expect(res.body.totalUsers).toBe(5);
  });

  it('effective-access path with includeChildren falls through when no engine rows', async () => {
    poolRequestQuery.mockResolvedValueOnce(PRINCIPALS_EXISTS);
    parseAndResolveContextFilters.mockResolvedValue([
      { id: 'ctx-1', includeChildren: true, targetType: 'Resource' },
    ]);
    dbQuery.mockResolvedValueOnce({ rows: [{ memberId: 'node-1' }] }); // memberIds
    effectiveAccessForNodes.mockResolvedValue({ rows: [] });            // no scope nodes → fall through
    stageQuery
      .mockResolvedValueOnce(rs([]))                  // main
      .mockResolvedValueOnce(rs([{ totalUsers: 0 }])) // total
      .mockResolvedValueOnce(rs([]));                 // AP
    const res = await request(app).get('/api/permissions?contextFilters=%5B%5D');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ─── GET /api/user-columns ─────────────────────────────────────────────────
describe('GET /api/user-columns', () => {
  it('schema=true returns column-name objects with empty values', async () => {
    getPrincipalOrUserColumns.mockResolvedValue([{ name: 'department' }, { name: 'jobTitle' }]);
    // tag query inside the try — succeeds with no rows.
    stageQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get('/api/user-columns?schema=true');
    expect(res.status).toBe(200);
    const cols = res.body.map(c => c.column);
    expect(cols).toContain('department');
    expect(cols).toContain('jobTitle');
  });

  it('returns distinct values + a __userTag virtual column', async () => {
    getPrincipalOrUserColumnValues.mockResolvedValue({ department: ['HR', 'Eng'] });
    stageQuery.mockResolvedValueOnce({ recordset: [{ name: 'VIP' }] });
    const res = await request(app).get('/api/user-columns');
    expect(res.status).toBe(200);
    const byCol = Object.fromEntries(res.body.map(c => [c.column, c.values]));
    expect(byCol.department).toEqual(['HR', 'Eng']);
    expect(byCol.__userTag).toEqual(['VIP']);
  });

  it('returns [] on query failure', async () => {
    getPrincipalOrUserColumnValues.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/user-columns');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── GET /api/sync-log ─────────────────────────────────────────────────────
describe('GET /api/sync-log', () => {
  it('returns [] when GraphSyncLog table is absent', async () => {
    stageQuery.mockResolvedValueOnce(rs([{ tableExists: null }]));
    const res = await request(app).get('/api/sync-log');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns sync-log rows when the table exists', async () => {
    stageQuery
      .mockResolvedValueOnce(rs([{ tableExists: 'GraphSyncLog' }]))
      .mockResolvedValueOnce(rs([{ Id: 1, SyncType: 'Users', Status: 'Success' }]));
    const res = await request(app).get('/api/sync-log?limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ Id: 1, SyncType: 'Users', Status: 'Success' }]);
  });

  it('500s when the table-check query rejects', async () => {
    stageQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/sync-log');
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/groups-with-nested ───────────────────────────────────────────
describe('GET /api/groups-with-nested', () => {
  it('returns the discovered group ids', async () => {
    stageQuery.mockResolvedValueOnce(rs([{ groupId: 'g1' }, { groupId: 'g2' }]));
    const res = await request(app).get('/api/groups-with-nested');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupIds: ['g1', 'g2'] });
  });

  it('returns empty groupIds on query failure', async () => {
    stageQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/groups-with-nested');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupIds: [] });
  });
});

// ─── GET /api/group/:groupId/nested-groups ─────────────────────────────────
describe('GET /api/group/:groupId/nested-groups', () => {
  it('returns containment expansion when the group is a scope node', async () => {
    expandCapabilityDown.mockResolvedValue({
      groups: [{ groupId: 'sg1' }], memberships: [{ memberId: 'u1' }],
    });
    const res = await request(app).get('/api/group/abc/nested-groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [{ groupId: 'sg1' }], memberships: [{ memberId: 'u1' }] });
  });

  it('falls through to group-membership expansion for a plain group', async () => {
    expandCapabilityDown.mockResolvedValue(null);
    stageQuery
      .mockResolvedValueOnce(rs([{ groupId: 'p1', resourceId: 'p1', displayName: 'Parent' }])) // groups
      .mockResolvedValueOnce(rs([{ resourceId: 'p1', memberId: 'u1', membershipType: 'Direct' }])); // members
    const res = await request(app).get('/api/group/abc/nested-groups');
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.memberships).toHaveLength(1);
  });

  it('returns empty shape on query failure', async () => {
    expandCapabilityDown.mockResolvedValue(null);
    stageQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/group/abc/nested-groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [], memberships: [] });
  });

  it('GET applies no resource clause (no matrix filter in a GET body)', async () => {
    expandCapabilityDown.mockResolvedValue(null);
    stageQuery.mockResolvedValueOnce(rs([])).mockResolvedValueOnce(rs([]));
    const res = await request(app).get('/api/group/abc/nested-groups');
    expect(res.status).toBe(200);
    expect(buildSubqueriesMock).not.toHaveBeenCalled();
    expect(stageQuery.mock.calls[0][0]).not.toContain('IN (SELECT id FROM "Resources"');
  });
});

// ─── POST /api/group/:groupId/nested-groups (matrix filter forwarded) ──────
describe('POST /api/group/:groupId/nested-groups', () => {
  it('constrains nested resources (groups + members) to the matrix resource filter', async () => {
    expandCapabilityDown.mockResolvedValue(null);
    stageQuery
      .mockResolvedValueOnce(rs([{ groupId: 'p1', resourceId: 'p1', resourceType: 'Group' }])) // groups
      .mockResolvedValueOnce(rs([{ resourceId: 'p1', memberId: 'u1', membershipType: 'Direct' }])); // members
    const res = await request(app)
      .post('/api/group/abc/nested-groups')
      .send({ filter: { resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }] } } });
    expect(res.status).toBe(200);
    expect(buildSubqueriesMock).toHaveBeenCalledTimes(1);
    // Both the resource-list and the member-subquery must carry the IN (subquery).
    expect(stageQuery.mock.calls[0][0]).toContain('ra."resourceId" IN (SELECT id FROM "Resources"');
    expect(stageQuery.mock.calls[1][0]).toContain('ra2."resourceId" IN (SELECT id FROM "Resources"');
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.memberships).toHaveLength(1);
  });

  it('applies no resource clause when the POST body carries no filter', async () => {
    expandCapabilityDown.mockResolvedValue(null);
    stageQuery.mockResolvedValueOnce(rs([])).mockResolvedValueOnce(rs([]));
    const res = await request(app).post('/api/group/abc/nested-groups').send({});
    expect(res.status).toBe(200);
    expect(buildSubqueriesMock).not.toHaveBeenCalled();
    expect(stageQuery.mock.calls[0][0]).not.toContain('IN (SELECT id FROM "Resources"');
  });

  it('still returns containment expansion for a scope node (filter ignored on that path)', async () => {
    expandCapabilityDown.mockResolvedValue({ groups: [{ groupId: 'sg1' }], memberships: [] });
    const res = await request(app)
      .post('/api/group/abc/nested-groups')
      .send({ filter: { resource: { include: [] } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [{ groupId: 'sg1' }], memberships: [] });
  });
});
