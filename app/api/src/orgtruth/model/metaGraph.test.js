import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getMetaGraph, groupAttributeKeys, ATTRIBUTE_KEY_CAP } from './metaGraph.js';

const SRC = 'a0000000-0000-4000-8000-0000000000aa';
const LAST = new Date('2026-09-30T00:00:00.000Z');

// Query order in getMetaGraph: types, attribute keys, predicates, links, sources, system counts.
function stage({ withSystem = true } = {}) {
  query
    .mockResolvedValueOnce({ rows: [
      { type: 'Person', count: 51, proposed: 2, sources: 1, lastObservedAt: LAST },
      { type: 'Project', count: 87, proposed: 0, sources: 2, lastObservedAt: LAST },
    ] })
    .mockResolvedValueOnce({ rows: [
      { type: 'Project', key: 'budget', n: 80 },
      { type: 'Project', key: 'costCenter', n: 12 },
    ] })
    .mockResolvedValueOnce({ rows: [{ predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85, proposed: 3 }] })
    .mockResolvedValueOnce({ rows: [
      { entityType: 'Person', targetType: 'Principal', accepted: 51, proposed: 9 },
      { entityType: 'Project', targetType: 'Resource', accepted: 7, proposed: 0 },
    ] })
    .mockResolvedValueOnce({ rows: [{ n: 2 }] });
  if (withSystem) query.mockResolvedValueOnce({ rows: [{ Principal: 1127, Resource: 1385, Identity: 600, Context: 42 }] });
}

beforeEach(() => { query.mockReset(); });

describe('getMetaGraph', () => {
  it('shapes types (with their attribute keys), predicates, links, system types and totals', async () => {
    stage();
    const out = await getMetaGraph();
    expect(out).toEqual({
      entityTypes: [
        { type: 'Person', count: 51, proposed: 2, sources: 1, lastObservedAt: LAST, attributeKeys: [] },
        { type: 'Project', count: 87, proposed: 0, sources: 2, lastObservedAt: LAST, attributeKeys: ['budget', 'costCenter'] },
      ],
      predicates: [{ predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85, proposed: 3 }],
      links: [
        { entityType: 'Person', targetType: 'Principal', accepted: 51, proposed: 9 },
        { entityType: 'Project', targetType: 'Resource', accepted: 7, proposed: 0 },
      ],
      systemTypes: [
        { targetType: 'Principal', count: 1127 }, { targetType: 'Resource', count: 1385 },
        { targetType: 'Identity', count: 600 }, { targetType: 'Context', count: 42 },
      ],
      totals: { entities: 140, relations: 88, links: 67, sources: 2 },
    });
    expect(query).toHaveBeenCalledTimes(6);
  });

  it('filters open, non-rejected rows by default and binds nothing', async () => {
    stage();
    await getMetaGraph();
    for (const i of [0, 1, 2]) {
      const [sql, params] = query.mock.calls[i];
      expect(sql).toMatch(/status <> 'rejected'/);
      expect(sql).toMatch(/"validTo" IS NULL/);
      expect(params).toEqual([]);
    }
    expect(query.mock.calls[3][0]).toMatch(/l\.status <> 'rejected' AND e\.status <> 'rejected' AND e\."validTo" IS NULL/);
    expect(query.mock.calls[4][1]).toEqual([null]);
  });

  it('includes closed rows and binds the source on request', async () => {
    stage();
    await getMetaGraph({ includeClosed: true, sourceId: SRC });
    for (const i of [0, 1, 2, 3]) {
      const [sql, params] = query.mock.calls[i];
      expect(sql).not.toMatch(/"validTo" IS NULL/);
      expect(sql).toMatch(/"sourceId" = \$1::uuid/);
      expect(params).toEqual([SRC]);
    }
    expect(query.mock.calls[4][1]).toEqual([SRC]);
  });

  it('skips the system counts when asked, and survives empty result sets', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await getMetaGraph({ withSystemCounts: false });
    expect(query).toHaveBeenCalledTimes(5);
    expect(out).toEqual({
      entityTypes: [], predicates: [], links: [], systemTypes: [],
      totals: { entities: 0, relations: 0, links: 0, sources: 0 },
    });
  });

  it('reports zero for a system table the count row lacks', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await getMetaGraph();
    expect(out.systemTypes).toEqual([
      { targetType: 'Principal', count: 0 }, { targetType: 'Resource', count: 0 },
      { targetType: 'Identity', count: 0 }, { targetType: 'Context', count: 0 },
    ]);
  });
});

describe('groupAttributeKeys', () => {
  it('keeps the row order per type and caps each type', () => {
    const rows = [
      { type: 'A', key: 'x' }, { type: 'B', key: 'y' }, { type: 'A', key: 'z' }, { type: 'A', key: 'w' },
    ];
    const byType = groupAttributeKeys(rows, 2);
    expect(byType.get('A')).toEqual(['x', 'z']);
    expect(byType.get('B')).toEqual(['y']);
  });

  it('caps at 50 by default', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ type: 'A', key: `k${i}` }));
    expect(ATTRIBUTE_KEY_CAP).toBe(50);
    expect(groupAttributeKeys(rows).get('A')).toHaveLength(50);
    expect(groupAttributeKeys(rows).get('A')[49]).toBe('k49');
  });
});
