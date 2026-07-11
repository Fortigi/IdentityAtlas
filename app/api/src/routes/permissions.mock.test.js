// Mock-mode (USE_SQL=false) unit tests for the permissions split.
//
// The SQL branches are exercised by permissions.test.js / permissions.coverage.test.js
// (which load the router with USE_SQL=true). This file covers the *other* half —
// the local-dev mock-data and no-database early-return branches that the split
// moved verbatim into permissions/grid.js, syncLog.js, accessPackages.js and
// nestedGroups.js. Loading the router with USE_SQL unset takes every handler's
// `if (!useSql)` path, so shared.js never imports the pg module.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'false';

// Heavy collaborators are inert in mock mode but still statically imported —
// stub them so the import graph stays light and DB-free.
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: async () => ({ recordset: [] }) }),
  getQueryTimings: () => [],
}));
vi.mock('./tags.js', () => ({ ensureTagTables: async () => {} }));
vi.mock('./categories.js', () => ({ ensureCategoryTables: async () => {} }));
vi.mock('../db/columnCache.js', () => ({
  getGroupColumns: async () => [], getResourceColumns: async () => [],
  getPrincipalOrUserColumns: async () => [], getPrincipalOrUserColumnValues: async () => ({}),
}));
vi.mock('../contexts/contextFilters.js', () => ({ buildContextFilterSql: vi.fn(), parseAndResolveContextFilters: vi.fn() }));
vi.mock('../effectiveAccess/engine.js', () => ({ expandCapabilityDown: vi.fn(), effectiveAccessForNodes: vi.fn() }));
vi.mock('../mock/data.js', () => ({ permissionAssignments: [
  { memberId: 'u1', groupId: 'g1', department: 'HR',  groupTypeCalculated: 'Security Group', membershipType: 'Direct' },
  { memberId: 'u2', groupId: 'g1', department: 'Eng', groupTypeCalculated: 'Security Group', membershipType: 'Direct' },
  { memberId: 'u1', groupId: 'g2', department: 'HR',  groupTypeCalculated: 'Microsoft 365',  membershipType: 'Indirect' },
] }));

const { default: router } = await import('./permissions.js');
const app = mountRouter(router);

describe('GET /user-columns (mock)', () => {
  it('derives filterable columns + distinct values from the mock dataset', async () => {
    const res = await request(app).get('/api/user-columns');
    expect(res.status).toBe(200);
    const dept = res.body.find(c => c.column === 'department');
    expect(dept).toBeTruthy();
    expect(dept.values).toEqual(['Eng', 'HR']);
    // The group/member bookkeeping columns are excluded from the user filters.
    expect(res.body.find(c => c.column === 'groupId')).toBeUndefined();
  });

  it('schema=true returns column names with empty value lists (fast path)', async () => {
    const res = await request(app).get('/api/user-columns?schema=true');
    expect(res.status).toBe(200);
    const dept = res.body.find(c => c.column === 'department');
    expect(dept).toBeTruthy();
    expect(dept.values).toEqual([]);
  });
});

describe('GET /permissions (mock)', () => {
  it('returns all assignments + distinct user total', async () => {
    const res = await request(app).get('/api/permissions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.totalUsers).toBe(2);          // u1, u2
    expect(res.body.managedByPackages).toEqual([]);
  });

  it('applies a server-side filter', async () => {
    const res = await request(app).get(`/api/permissions?filters=${encodeURIComponent('{"department":"HR"}')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);         // u1's two rows
  });

  it('userLimit keeps only the top-N busiest users', async () => {
    const res = await request(app).get('/api/permissions?userLimit=1');
    expect(res.status).toBe(200);
    // u1 has 2 assignments, u2 has 1 — top-1 keeps u1's rows only.
    expect(res.body.data.every(r => r.memberId === 'u1')).toBe(true);
    expect(res.body.totalUsers).toBe(2);
  });
});

describe('GET /sync-log (mock)', () => {
  it('generates synthetic sync-log entries', async () => {
    const res = await request(app).get('/api/sync-log');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('SyncType');
  });

  it('honours the limit query param', async () => {
    const res = await request(app).get('/api/sync-log?limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });
});

describe('no-database early returns (mock)', () => {
  it('GET /access-package-groups -> []', async () => {
    const res = await request(app).get('/api/access-package-groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /groups-with-nested -> empty groupIds', async () => {
    const res = await request(app).get('/api/groups-with-nested');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupIds: [] });
  });

  it('GET /group/:groupId/nested-groups -> empty shape', async () => {
    const res = await request(app).get('/api/group/g1/nested-groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [], memberships: [] });
  });
});
