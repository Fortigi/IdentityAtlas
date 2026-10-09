import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { buildGroups, getLinkedTo } from './linkedTo.js';

const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';
const P = 'p0000000-0000-4000-8000-000000000001';
const I = 'i0000000-0000-4000-8000-000000000001';

const direct = [
  { id: C1, entityType: 'Klant', displayName: 'Contoso Bank', attributes: {}, via: 'eigenaar' },
  { id: C2, entityType: 'Klant', displayName: 'Northwind', attributes: {}, via: 'team' },
  { id: 'm1', entityType: 'Maten', displayName: 'Ann Example', attributes: {}, via: 'displayName' },
  { id: 'u1', entityType: 'Uren', displayName: 'Ann Example', attributes: { c1: '2025', c2: 'maart', c5: '8,50' }, via: 'displayName' },
  { id: 'u2', entityType: 'Uren', displayName: 'Ann Example', attributes: { c1: '2026', c2: 'januari', c5: '4,00' }, via: 'displayName' },
  { id: 'u3', entityType: 'Uren', displayName: 'Ann Example', attributes: { c1: '2024', c2: 'mei', c5: '2' }, via: 'displayName' },
];
const through = [
  { fromId: 'u1', via: 'klant', id: C1, entityType: 'Klant', displayName: 'Contoso Bank' },
  { fromId: 'u2', via: 'klant', id: C1, entityType: 'Klant', displayName: 'Contoso Bank' },
  { fromId: 'u3', via: 'klant', id: C2, entityType: 'Klant', displayName: 'Northwind' },
];

describe('buildGroups', () => {
  const out = buildGroups(direct, through);

  it('one group per entity type and attribute; fact rows are left out of the direct groups', () => {
    expect(out.groups.map(g => [g.label, g.kind, g.count])).toEqual([
      ['Klant · eigenaar', 'direct', 1],
      ['Klant · team', 'direct', 1],
      ['Klant · worked on (Uren)', 'through', 2],
      ['Maten · name', 'direct', 1],
    ]);
    expect(out.total).toBe(5);
  });

  it('a through group sums hours per target and keeps the latest period, most hours first', () => {
    const g = out.groups.find(x => x.kind === 'through');
    expect(g.items).toEqual([
      { entityId: C1, entityType: 'Klant', label: 'Contoso Bank', detail: '12.5 h · 2 rows · until 2026-01', hours: 12.5, lastPeriod: '2026-01' },
      { entityId: C2, entityType: 'Klant', label: 'Northwind', detail: '0 h · 1 rows · until 2024-05', hours: 0, lastPeriod: '2024-05' },
    ]);
    expect(g.sourceType).toBe('Uren');
  });

  it('empty input is no groups', () => {
    expect(buildGroups([], [])).toEqual({ total: 0, groups: [] });
  });
});

describe('getLinkedTo', () => {
  beforeEach(() => query.mockReset());

  it('a principal also looks at its identity, and reads the through links of what it found', async () => {
    query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('"IdentityMembers"')) return { rows: [{ identityId: I }] };
      if (String(sql).includes(`"targetType" = 'OrgEntity'`)) return { rows: through };
      return { rows: direct };
    });
    const out = await getLinkedTo('Principal', P);
    const directCall = query.mock.calls.find(([s]) => String(s).includes('ANY($1::text[])'));
    expect(directCall[1]).toEqual([['Principal', 'Identity'], [P, I]]);
    expect(out.total).toBe(5);
  });

  it('a resource with nothing linked reads no through links', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getLinkedTo('Resource', C1)).toEqual({ total: 0, groups: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
