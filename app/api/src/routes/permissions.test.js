// Unit tests for routes/permissions.js — the access-package → resource flatten.
// permissions.js has no 400 paths and pulls in many helpers; all are mocked so
// the import is inert and we exercise the grouped→flat transform in Node.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
  getQueryTimings: () => [],
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: vi.fn() }));
vi.mock('./tags.js', () => ({ ensureTagTables: async () => {}, buildFilterWhere: () => '' }));
vi.mock('./categories.js', () => ({ ensureCategoryTables: async () => {} }));
vi.mock('../mock/data.js', () => ({ permissionAssignments: [] }));
vi.mock('../db/columnCache.js', () => ({
  getGroupColumns: vi.fn(async () => []), getResourceColumns: vi.fn(async () => []),
  getPrincipalOrUserColumns: vi.fn(async () => []), getPrincipalOrUserColumnValues: vi.fn(async () => []),
}));
vi.mock('../contexts/contextFilters.js', () => ({ buildContextFilterSql: vi.fn(), parseAndResolveContextFilters: vi.fn() }));
vi.mock('../effectiveAccess/engine.js', () => ({ expandCapabilityDown: vi.fn(), effectiveAccessForNodes: vi.fn() }));

const { default: router } = await import('./permissions.js');
const app = mountRouter(router);

beforeEach(() => timedQuery.mockReset());

const apRow = (over) => ({
  accessPackageId: 'ap1', businessRoleId: 'ap1', accessPackageName: 'AP One',
  systemId: 1, catalogName: 'Cat', totalAssignments: 0,
  categoryId: null, categoryName: null, categoryColor: null, resources: [], ...over,
});

describe('GET /access-package-groups', () => {
  it('flattens grouped resources into (ap, resource) rows', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [apRow({
      resources: [{ resourceId: 'r1', groupId: 'r1', resourceName: 'Eng', groupName: 'Eng', resourceType: 'Group', systemId: 1, roleName: null }],
    })] });
    const res = await request(app).get('/api/access-package-groups');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ accessPackageId: 'ap1', resourceId: 'r1', resourceName: 'Eng' });
  });

  it('emits a single null-resource row for an AP with no resources', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [apRow({ accessPackageId: 'ap2', resources: [] })] });
    const res = await request(app).get('/api/access-package-groups');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ accessPackageId: 'ap2', resourceId: null, resourceName: null });
  });
});
