// Unit tests for the shared resource-contexts helper: the SQL builder both the
// resource-detail endpoint and the matrix sidecar use, the row grouping, and the
// batch fetch's scoping + tolerant failure behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({ timedQuery: (...a) => timedQuery(...a) }));

const { buildResourceContextsSql, groupResourceContexts, fetchResourceContexts } =
  await import('./resourceContexts.js');

const UUID_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const UUID_B = 'bbbbbbbb-2222-2222-2222-222222222222';

beforeEach(() => {
  timedQuery.mockReset();
  timedQuery.mockResolvedValue({ rows: [] });
});

describe('buildResourceContextsSql', () => {
  it('joins ContextMembers to Contexts and orders by type then name', () => {
    const sql = buildResourceContextsSql('cm."memberId"::text = $1');
    expect(sql).toContain('FROM "ContextMembers" cm');
    expect(sql).toContain('JOIN "Contexts" c ON c.id = cm."contextId"');
    expect(sql).toContain('WHERE cm."memberId"::text = $1');
    expect(sql).toContain('ORDER BY c."contextType", c."displayName"');
  });

  it('supports a select/order prefix for the batched (per-resource) form', () => {
    const sql = buildResourceContextsSql('cm."memberType" = \'Resource\'', {
      selectPrefix: 'cm."memberId"::text AS "resourceId", ',
      orderPrefix: 'cm."memberId", ',
    });
    expect(sql).toContain('SELECT cm."memberId"::text AS "resourceId", c.id');
    expect(sql).toContain('ORDER BY cm."memberId", c."contextType"');
  });
});

describe('groupResourceContexts', () => {
  it('groups rows per resource, preserving server order', () => {
    expect(groupResourceContexts([
      { resourceId: 'r1', id: 'c1', displayName: 'Finance', contextType: 'Tag' },
      { resourceId: 'r1', id: 'c2', displayName: 'M365', contextType: 'group-category' },
      { resourceId: 'r2', id: 'c3', displayName: 'Cluster-A', contextType: 'cluster' },
    ])).toEqual([
      {
        resourceId: 'r1',
        contexts: [
          { id: 'c1', displayName: 'Finance', contextType: 'Tag' },
          { id: 'c2', displayName: 'M365', contextType: 'group-category' },
        ],
      },
      { resourceId: 'r2', contexts: [{ id: 'c3', displayName: 'Cluster-A', contextType: 'cluster' }] },
    ]);
  });

  it('tolerates no rows and rows without a resourceId', () => {
    expect(groupResourceContexts(null)).toEqual([]);
    expect(groupResourceContexts([{ id: 'c1' }, null])).toEqual([]);
  });
});

describe('fetchResourceContexts', () => {
  it('queries once, scoped to the distinct uuid resource ids of the grid', async () => {
    timedQuery.mockResolvedValue({
      rows: [{ resourceId: UUID_A, id: 'c1', displayName: 'M365', contextType: 'group-category' }],
    });
    const out = await fetchResourceContexts({}, {}, [UUID_A, UUID_A, UUID_B]);

    expect(timedQuery).toHaveBeenCalledTimes(1);
    const [, label, , sql, params] = timedQuery.mock.calls[0];
    expect(label).toBe('matrix-data-resource-contexts');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain('cm."memberId" = ANY($1::uuid[])');
    expect(params).toEqual([[UUID_A, UUID_B]]); // de-duplicated
    expect(out).toEqual([{ resourceId: UUID_A, contexts: [{ id: 'c1', displayName: 'M365', contextType: 'group-category' }] }]);
  });

  it('skips the query entirely when no resource id is a uuid', async () => {
    expect(await fetchResourceContexts({}, {}, ['not-a-uuid', null, undefined])).toEqual([]);
    expect(await fetchResourceContexts({}, {}, undefined)).toEqual([]);
    expect(timedQuery).not.toHaveBeenCalled();
  });

  it('returns an empty sidecar when the context tables are missing', async () => {
    timedQuery.mockRejectedValue(new Error('relation "ContextMembers" does not exist'));
    expect(await fetchResourceContexts({}, {}, [UUID_A])).toEqual([]);
  });
});
