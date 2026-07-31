// Unit tests for the shared resource-contexts join (#870): the SQL builder used
// by both GET /resources/:id/contexts and the /matrix/data batch, the
// per-resource grouping, and the failure-tolerant batch fetcher.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: (...a) => timedQuery(...a),
}));

const { buildResourceContextsSql, groupResourceContexts, fetchMatrixResourceContexts } =
  await import('./resourceContexts.js');

describe('buildResourceContextsSql', () => {
  it('renders the single-resource shape (no memberId column, caller-supplied WHERE)', () => {
    const sql = buildResourceContextsSql({ where: `cm."memberId"::text = $1` });
    expect(sql).toContain('JOIN "Contexts" c ON c.id = cm."contextId"');
    expect(sql).toContain(`WHERE cm."memberId"::text = $1`);
    expect(sql).not.toContain('AS "resourceId"');
    expect(sql).toContain('ORDER BY c."contextType", c."displayName"');
  });

  it('renders the batch shape (memberId aliased to resourceId, grouped ordering)', () => {
    const sql = buildResourceContextsSql({ where: `cm."memberType" = 'Resource'`, batch: true });
    expect(sql).toContain('cm."memberId"::text AS "resourceId"');
    expect(sql).toContain('ORDER BY cm."memberId", c."contextType", c."displayName"');
  });
});

describe('groupResourceContexts', () => {
  it('groups rows per resource, preserving the server-side row order', () => {
    const out = groupResourceContexts([
      { resourceId: 'r1', id: 'c1', displayName: 'M365', contextType: 'category', targetType: 'Resource', variant: 'generated' },
      { resourceId: 'r1', id: 'c2', displayName: 'Finance', contextType: 'tag', targetType: 'Resource', variant: 'manual' },
      { resourceId: 'r2', id: 'c3', displayName: 'Cluster A', contextType: 'cluster', targetType: 'Resource', variant: 'generated' },
    ]);
    expect(out).toEqual([
      {
        resourceId: 'r1',
        contexts: [
          { id: 'c1', displayName: 'M365', contextType: 'category', targetType: 'Resource', variant: 'generated' },
          { id: 'c2', displayName: 'Finance', contextType: 'tag', targetType: 'Resource', variant: 'manual' },
        ],
      },
      {
        resourceId: 'r2',
        contexts: [{ id: 'c3', displayName: 'Cluster A', contextType: 'cluster', targetType: 'Resource', variant: 'generated' }],
      },
    ]);
  });

  it('returns [] for empty or missing rows', () => {
    expect(groupResourceContexts([])).toEqual([]);
    expect(groupResourceContexts(null)).toEqual([]);
    expect(groupResourceContexts(undefined)).toEqual([]);
  });
});

describe('fetchMatrixResourceContexts', () => {
  // Braces matter: mockReset() returns the mock, and a function returned from
  // a hook is run as teardown — which would CALL the mock after each test.
  beforeEach(() => { timedQuery.mockReset(); });

  const built = (sql) => ({ resource: () => ({ sql }) });

  it('scopes the batch to the visible resources when a resource filter exists', async () => {
    timedQuery.mockResolvedValue({ rows: [
      { resourceId: 'r1', id: 'c1', displayName: 'M365', contextType: 'category', targetType: 'Resource', variant: 'generated' },
    ] });
    const out = await fetchMatrixResourceContexts({}, {}, built('(SELECT id FROM "Resources")'));
    expect(out).toEqual([
      { resourceId: 'r1', contexts: [{ id: 'c1', displayName: 'M365', contextType: 'category', targetType: 'Resource', variant: 'generated' }] },
    ]);
    const sql = timedQuery.mock.calls[0][3];
    expect(timedQuery.mock.calls[0][1]).toBe('matrix-data-resource-contexts');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain(`cm."memberId" IN (SELECT id FROM "Resources")`);
  });

  it('only filters on memberType when the resource scope is empty', async () => {
    timedQuery.mockResolvedValue({ rows: [] });
    await fetchMatrixResourceContexts({}, {}, built(null));
    const sql = timedQuery.mock.calls[0][3];
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).not.toContain('cm."memberId" IN');
  });

  it('swallows query failures and returns [] (Contexts tables may be absent)', async () => {
    timedQuery.mockImplementation(() => { throw new Error('relation "ContextMembers" does not exist'); });
    await expect(fetchMatrixResourceContexts({}, {}, built(null))).resolves.toEqual([]);
  });
});
