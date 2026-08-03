import { describe, it, expect, vi } from 'vitest';

vi.mock('../perf/sqlTimer.js', () => ({ timedQuery: vi.fn() }));

const { timedQuery } = await import('../perf/sqlTimer.js');
const { buildResourceContextsSql, groupResourceContexts, fetchResourceContexts } =
  await import('./resourceContexts.js');

describe('buildResourceContextsSql', () => {
  it('restricts to Resource-targeted memberships', () => {
    const sql = buildResourceContextsSql();
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain('JOIN "Contexts" c ON c.id = cm."contextId"');
    // Ordering is server-side so the first chips shown are stable.
    expect(sql).toMatch(/ORDER BY c\."contextType", c\."displayName"/);
  });

  it('applies the member filter for the single-resource lookup', () => {
    const sql = buildResourceContextsSql({ memberFilter: '::text = $1' });
    expect(sql).toContain('cm."memberId" ::text = $1');
    expect(sql).not.toContain('AS "resourceId"');
  });

  it('selects and orders by the member id when batching', () => {
    const sql = buildResourceContextsSql({ memberFilter: 'IN (SELECT id FROM x)', withResourceId: true });
    expect(sql).toContain('cm."memberId"::text AS "resourceId"');
    expect(sql).toContain('cm."memberId" IN (SELECT id FROM x)');
    expect(sql).toMatch(/ORDER BY cm\."memberId", c\."contextType"/);
  });
});

describe('groupResourceContexts', () => {
  it('groups rows per resource, preserving query order', () => {
    const grouped = groupResourceContexts([
      { resourceId: 'r1', id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
      { resourceId: 'r1', id: 'c2', displayName: 'M365', contextType: 'group-category', variant: 'generated' },
      { resourceId: 'r2', id: 'c3', displayName: 'Cluster-A', contextType: 'cluster', variant: 'generated' },
    ]);
    expect(grouped).toEqual([
      {
        resourceId: 'r1',
        contexts: [
          { id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
          { id: 'c2', displayName: 'M365', contextType: 'group-category', variant: 'generated' },
        ],
      },
      {
        resourceId: 'r2',
        contexts: [{ id: 'c3', displayName: 'Cluster-A', contextType: 'cluster', variant: 'generated' }],
      },
    ]);
  });

  it('tolerates no rows and skips rows without a resource id', () => {
    expect(groupResourceContexts()).toEqual([]);
    expect(groupResourceContexts([{ id: 'c1', displayName: 'Orphan' }])).toEqual([]);
  });
});

describe('fetchResourceContexts', () => {
  const built = (sql) => ({ resource: (bind) => ({ sql: sql ? `(SELECT id FROM t WHERE k = ${bind('v')})` : '' }) });

  it('scopes the batch to the grid resource sub-select and binds its params', async () => {
    timedQuery.mockResolvedValueOnce({
      rows: [{ resourceId: 'r1', id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' }],
    });
    const out = await fetchResourceContexts({}, {}, built(true));
    const [, label, , sql, params] = timedQuery.mock.calls[0];
    expect(label).toBe('matrix-data-resource-contexts');
    expect(sql).toContain('cm."memberId" IN (SELECT id FROM t WHERE k = $1)');
    expect(params).toEqual(['v']);
    expect(out).toEqual([{ resourceId: 'r1', contexts: [{ id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' }] }]);
  });

  it('omits the scope predicate when the grid has no resource filter', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [] });
    await fetchResourceContexts({}, {}, built(false));
    const sql = timedQuery.mock.calls.at(-1)[3];
    expect(sql).not.toContain('cm."memberId" IN');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
  });

  it('returns an empty sidecar instead of failing the matrix when the query throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('relation "ContextMembers" does not exist'));
    await expect(fetchResourceContexts({}, {}, built(true))).resolves.toEqual([]);
  });
});
