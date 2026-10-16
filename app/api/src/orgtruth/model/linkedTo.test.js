import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { buildGroups, getLinkedTo, targetsOf } from './linkedTo.js';

const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';
const R1 = 'r0000000-0000-4000-8000-000000000001';
const P = 'p0000000-0000-4000-8000-000000000001';
const I = 'i0000000-0000-4000-8000-000000000001';

const direct = [
  { id: C1, entityType: 'Klant', displayName: 'Contoso Bank', attributes: {}, via: 'eigenaar' },
  { id: C2, entityType: 'Klant', displayName: 'Northwind', attributes: {}, via: 'team' },
  { id: 'm1', entityType: 'Maten', displayName: 'Ann Example', attributes: {}, via: 'displayName' },
];
// activity/sql.js roll-up rows: one per (type, subject, actor)
const act = (o) => ({ activityType: 'Uren', unit: 'h', subjectType: 'OrgEntity', subjectEntityType: 'Klant', actorType: 'Principal', actorId: P, month: null, ...o });
const activity = [
  act({ subjectId: C1, subjectLabel: 'Contoso Bank', rowCount: 1, total: 8.5, firstOn: '2025-03-01', lastOn: '2025-03-01' }),
  // the same customer through the identity: adds up on one item, the later period wins
  act({ subjectId: C1, subjectLabel: 'Contoso Bank', actorType: 'Identity', actorId: I, rowCount: 1, total: 4, firstOn: '2026-01-01', lastOn: '2026-01-01' }),
  act({ subjectId: C2, subjectLabel: 'Northwind', rowCount: 1, total: 0, firstOn: '2024-05-01', lastOn: '2024-05-01' }),
  // a resource as subject: its own group, typed Resource
  act({ subjectType: 'Resource', subjectEntityType: null, subjectId: R1, subjectLabel: 'Finance share', rowCount: 3, total: 2, firstOn: '2026-02-03', lastOn: '2026-02-17' }),
];

describe('buildGroups', () => {
  const out = buildGroups(direct, activity);

  it('one direct group per entity type and attribute, one through group per subject type and activity type', () => {
    expect(out.groups.map(g => [g.label, g.kind, g.count])).toEqual([
      ['Klant · eigenaar', 'direct', 1],
      ['Klant · team', 'direct', 1],
      ['Klant · worked on (Uren)', 'through', 2],
      ['Maten · name', 'direct', 1],
      ['Resource · worked on (Uren)', 'through', 1],
    ]);
    expect(out.total).toBe(6);
  });

  it('a through group sums hours per subject and keeps the latest month, most hours first', () => {
    const g = out.groups.find(x => x.label === 'Klant · worked on (Uren)');
    expect(g.items).toEqual([
      { entityId: C1, entityType: 'Klant', label: 'Contoso Bank', detail: '12.5 h · 2 rows · until 2026-01', hours: 12.5, lastPeriod: '2026-01' },
      { entityId: C2, entityType: 'Klant', label: 'Northwind', detail: '0 h · 1 rows · until 2024-05', hours: 0, lastPeriod: '2024-05' },
    ]);
    expect(g).toMatchObject({ key: 'through|Klant|Uren', via: 'subject', sourceType: 'Uren', unlinkedRows: 0, truncated: false });
  });

  it('rows whose subject is unresolved are counted on their type\'s through group, not listed', () => {
    const o = buildGroups(direct, [...activity, act({ subjectType: null, subjectEntityType: null, subjectId: null, subjectLabel: null, rowCount: 7, total: 3, lastOn: '2026-01-01' })]);
    expect(o.groups.find(x => x.label === 'Klant · worked on (Uren)').unlinkedRows).toBe(7);
    expect(o.total).toBe(6);
  });

  it('a row without a date leaves the period empty', () => {
    const o = buildGroups([], [act({ subjectId: C1, subjectLabel: 'Contoso Bank', rowCount: 2, total: 1.25, lastOn: null })]);
    expect(o.groups[0].items[0]).toMatchObject({ detail: '1.3 h · 2 rows', lastPeriod: null });
  });

  it('empty input is no groups', () => {
    expect(buildGroups([], [])).toEqual({ total: 0, groups: [] });
    expect(buildGroups([])).toEqual({ total: 0, groups: [] });
  });
});

describe('targetsOf', () => {
  beforeEach(() => query.mockReset());

  it('an identity widens to its accounts, a resource to nothing', async () => {
    query.mockResolvedValueOnce({ rows: [{ principalId: P }] });
    expect(await targetsOf('Identity', I)).toEqual([{ targetType: 'Identity', id: I }, { targetType: 'Principal', id: P }]);
    expect(await targetsOf('Resource', R1)).toEqual([{ targetType: 'Resource', id: R1 }]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('getLinkedTo', () => {
  beforeEach(() => query.mockReset());

  it('a principal also looks at its identity, for its links and for its activity', async () => {
    query.mockImplementation(async (sql) => {
      if (String(sql).includes('"IdentityMembers"')) return { rows: [{ identityId: I }] };
      if (String(sql).includes('FROM "OrgActivities" a')) return { rows: activity };
      return { rows: direct };
    });
    const out = await getLinkedTo('Principal', P);
    const directCall = query.mock.calls.find(([s]) => String(s).includes('FROM "OrgLinks" l'));
    expect(directCall[1]).toEqual([['Principal', 'Identity'], [P, I]]);
    const activityCall = query.mock.calls.find(([s]) => String(s).includes('FROM "OrgActivities" a'));
    expect(activityCall[0]).toMatch(/ak\."targetType" = ANY\(\$1::text\[\]\) AND ak\."targetId" = ANY\(\$2::uuid\[\]\)/);
    expect(activityCall[1]).toEqual([['Principal', 'Identity'], [P, I]]);
    expect(out.total).toBe(6);
  });

  it('a resource or context is nobody\'s actor: no activity read', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getLinkedTo('Resource', C1)).toEqual({ total: 0, groups: [] });
    expect(await getLinkedTo('Context', C1)).toEqual({ total: 0, groups: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
