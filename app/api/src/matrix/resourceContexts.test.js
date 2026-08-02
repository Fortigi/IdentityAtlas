import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../perf/sqlTimer.js', () => ({ timedQuery: vi.fn() }));

const { timedQuery } = await import('../perf/sqlTimer.js');
const { buildResourceContextsSql, groupResourceContexts, fetchResourceContexts } =
  await import('./resourceContexts.js');

describe('buildResourceContextsSql', () => {
  it('embeds the caller-supplied WHERE and keeps the stable ordering', () => {
    const sql = buildResourceContextsSql(`cm."memberId"::text = $1`);
    expect(sql).toContain('FROM "ContextMembers" cm');
    expect(sql).toContain('JOIN "Contexts" c ON c.id = cm."contextId"');
    expect(sql).toContain(`WHERE cm."memberId"::text = $1`);
    expect(sql).toContain('ORDER BY cm."memberId", c."contextType", c."displayName"');
    // The sidecar key + everything the chips render.
    for (const col of ['"resourceId"', '"displayName"', '"contextType"', '"targetType"', 'c.variant']) {
      expect(sql).toContain(col);
    }
  });
});

describe('groupResourceContexts', () => {
  it('groups flat rows per resource, preserving server order', () => {
    const rows = [
      { resourceId: 'r1', id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
      { resourceId: 'r1', id: 'c2', displayName: 'M365', contextType: 'group-category', variant: 'generated' },
      { resourceId: 'r2', id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
    ];
    expect(groupResourceContexts(rows)).toEqual([
      {
        resourceId: 'r1',
        contexts: [
          { id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
          { id: 'c2', displayName: 'M365', contextType: 'group-category', variant: 'generated' },
        ],
      },
      {
        resourceId: 'r2',
        contexts: [{ id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' }],
      },
    ]);
  });

  it('skips rows without a resourceId and tolerates null/empty input', () => {
    expect(groupResourceContexts(null)).toEqual([]);
    expect(groupResourceContexts([])).toEqual([]);
    expect(groupResourceContexts([{ resourceId: null, id: 'c1' }])).toEqual([]);
  });
});

describe('fetchResourceContexts', () => {
  beforeEach(() => vi.clearAllMocks());

  const res = {};
  const pool = {};

  it('scopes to the visible resources and filters to Resource memberships', async () => {
    timedQuery.mockResolvedValue({ rows: [
      { resourceId: 'r1', id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
    ] });
    const built = { resource: (bind) => ({ sql: `(SELECT id FROM "Resources" WHERE "systemId" = ${bind(7)})` }) };

    const out = await fetchResourceContexts(pool, res, built);

    expect(timedQuery).toHaveBeenCalledTimes(1);
    const [, label, , sql, params] = timedQuery.mock.calls[0];
    expect(label).toBe('matrix-data-resource-contexts');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain('cm."memberId" IN (SELECT id FROM "Resources"');
    expect(params).toEqual([7]);
    expect(out).toEqual([{ resourceId: 'r1', contexts: [
      { id: 'c1', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
    ] }]);
  });

  it('omits the IN clause when the filter has no resource scope', async () => {
    timedQuery.mockResolvedValue({ rows: [] });
    const built = { resource: () => ({ sql: '' }) };

    const out = await fetchResourceContexts(pool, res, built);

    const [, , , sql, params] = timedQuery.mock.calls[0];
    expect(sql).not.toContain('cm."memberId" IN');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(params).toEqual([]);
    expect(out).toEqual([]);
  });
});
