import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { shapeAttributes, shapeVias, getFilterOptions, VALUES_PER_KEY } from './filterOptions.js';

beforeEach(() => query.mockReset());

describe('shapeAttributes', () => {
  it('groups values per key in the order given, sorts keys, and keeps the distinct count', () => {
    const rows = [
      { key: 'sector', value: 'Bank', n: 3, distinctCount: 2 },
      { key: 'iso27001', value: 'Nee', n: 47, distinctCount: 2 },
      { key: 'sector', value: 'Retail', n: 1, distinctCount: 2 },
      { key: 'iso27001', value: 'Ja', n: 14, distinctCount: 2 },
    ];
    expect(shapeAttributes(rows, 61)).toEqual([
      { key: 'iso27001', distinct: 2, free: false, values: [{ value: 'Nee', count: 47 }, { value: 'Ja', count: 14 }] },
      { key: 'sector', distinct: 2, free: false, values: [{ value: 'Bank', count: 3 }, { value: 'Retail', count: 1 }] },
    ]);
  });

  // Free = unique per entity AND too many to list. Each half alone must not do it.
  it.each([
    ['unique and more than the page', VALUES_PER_KEY + 1, VALUES_PER_KEY + 1, true],
    ['unique but few enough to list', VALUES_PER_KEY, VALUES_PER_KEY, false],
    ['many but not unique', VALUES_PER_KEY + 1, VALUES_PER_KEY + 2, false],
  ])('a key that is %s → free %s', (_label, distinct, entityCount, free) => {
    const [a] = shapeAttributes([{ key: 'id', value: 'x1', n: 1, distinctCount: distinct }], entityCount);
    expect(a.free).toBe(free);
    expect(a.values).toEqual(free ? [] : [{ value: 'x1', count: 1 }]);
  });
});

describe('shapeVias', () => {
  it('merges target types per name, sums links, keeps direct and through apart, direct first', () => {
    const direct = [
      { name: 'team', targetType: 'Principal', links: 20 },
      { name: 'eigenaar', targetType: 'Identity', links: 3 },
      { name: 'eigenaar', targetType: 'Principal', links: 55 },
      { name: 'displayName', targetType: 'Resource', links: 40 },
    ];
    const through = [{ name: 'Uren', targetType: 'Principal', links: 839 }, { name: 'team', targetType: 'Principal', links: 2 }];
    expect(shapeVias(direct, through)).toEqual([
      { name: 'displayName', kind: 'direct', targets: ['Resource'], links: 40 },
      { name: 'eigenaar', kind: 'direct', targets: ['Principal', 'Identity'], links: 58 },
      { name: 'team', kind: 'direct', targets: ['Principal'], links: 20 },
      { name: 'team', kind: 'through', targets: ['Principal'], links: 2 },
      { name: 'Uren', kind: 'through', targets: ['Principal'], links: 839 },
    ]);
  });
});

describe('getFilterOptions', () => {
  it('binds the type into all four queries and assembles the answer', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ n: 61 }] })
      .mockResolvedValueOnce({ rows: [{ key: 'iso27001', value: 'Ja', n: 14, distinctCount: 2 }] })
      .mockResolvedValueOnce({ rows: [{ name: 'eigenaar', targetType: 'Principal', links: 58 }] })
      .mockResolvedValueOnce({ rows: [{ name: 'Uren', targetType: 'Principal', links: 839 }] });
    const out = await getFilterOptions('Klant');
    expect(out).toEqual({
      entityType: 'Klant', entityCount: 61,
      attributes: [{ key: 'iso27001', distinct: 2, free: false, values: [{ value: 'Ja', count: 14 }] }],
      vias: [
        { name: 'eigenaar', kind: 'direct', targets: ['Principal'], links: 58 },
        { name: 'Uren', kind: 'through', targets: ['Principal'], links: 839 },
      ],
    });
    const [count, values, direct, through] = query.mock.calls;
    expect(count[1]).toEqual(['Klant']);
    expect(values[1]).toEqual(['Klant', VALUES_PER_KEY]);
    expect(direct[1]).toEqual(['Klant', ['Principal', 'Identity', 'Resource', 'Context']]);
    expect(through[1]).toEqual(['Klant', ['Principal', 'Identity', 'Resource', 'Context']]);
    // Only accepted, current entities count; the through query follows attribute links only.
    for (const [sql] of query.mock.calls) expect(sql).toMatch(/e\."status" = 'accepted' AND e\."validTo" IS NULL/);
    expect(through[0]).toMatch(/COALESCE\(tl\."via", 'displayName'\) <> 'displayName'/);
    expect(through[0]).toMatch(/f\."status" = 'accepted' AND f\."validTo" IS NULL/);
  });

  it('reports zero entities when the count query returns no row', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getFilterOptions('Klant')).toEqual({ entityType: 'Klant', entityCount: 0, attributes: [], vias: [] });
  });
});
