import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import { monthOf, periodOf, hoursOf, computeEvidence, getEvidence } from './evidence.js';
import { familyIndex } from '../activity/family.js';

const ID = 'e0000000-0000-4000-8000-000000000001';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('monthOf', () => {
  it('reads Dutch and English month names and abbreviations, any case', () => {
    expect(monthOf('januari')).toBe(1);
    expect(monthOf('March')).toBe(3);
    expect(monthOf('mrt')).toBe(3);
    expect(monthOf(' Mei ')).toBe(5);
    expect(monthOf('okt')).toBe(10);
    expect(monthOf('December')).toBe(12);
  });
  it('reads 1..12 as a number, nothing outside it', () => {
    expect(monthOf('1')).toBe(1);
    expect(monthOf('07')).toBe(7);
    expect(monthOf('12')).toBe(12);
    expect(monthOf('0')).toBeNull();
    expect(monthOf('13')).toBeNull();
    expect(monthOf('123')).toBeNull();
  });
  it('null for anything else', () => {
    expect(monthOf('Contoso')).toBeNull();
    expect(monthOf('')).toBeNull();
    expect(monthOf(null)).toBeNull();
  });
});

describe('periodOf', () => {
  it('YYYY-MM from a year attribute and a month attribute', () => {
    expect(periodOf({ jaar: '2026', maand: 'maart', klant: 'Contoso' })).toBe('2026-03');
    expect(periodOf({ month: 11, year: 2025 })).toBe('2025-11');
  });
  it('January when there is a year but no month', () => {
    expect(periodOf({ jaar: '2026', klant: 'Contoso' })).toBe('2026-01');
  });
  it('null without a 19xx/20xx year', () => {
    expect(periodOf({ maand: 'maart', nummer: '2126' })).toBeNull();
    expect(periodOf({ nummer: '1899' })).toBeNull();
    expect(periodOf(null)).toBeNull();
  });
});

describe('hoursOf', () => {
  it('sums the attributes holding a decimal number, comma or point', () => {
    expect(hoursOf({ uren: '52,00', reis: '1.5', klant: 'Contoso' })).toBe(53.5);
    expect(hoursOf({ correctie: '-2,5', uren: '4,0' })).toBe(1.5);
  });
  it('ignores whole numbers (years, months, ids) and text', () => {
    expect(hoursOf({ jaar: '2026', maand: '3', uren: '8,5', note: '8,5 h' })).toBe(8.5);
    expect(hoursOf(undefined)).toBe(0);
  });
});


describe('computeEvidence', () => {
  const entity = { id: ID, entityType: 'Customer', displayName: 'Contoso', extra: 'dropped' };
  // activity/sql.js roll-up rows (byMonth): one per (type, subject, actor, month)
  const row = (actorType, actorId, month, rowCount, total) => ({
    activityType: 'Timesheet', unit: 'h', subjectType: 'OrgEntity', subjectId: ID, actorType, actorId, month, rowCount, total,
    firstOn: month ? `${month}-01` : null, lastOn: month ? `${month}-01` : null,
  });
  // ann has two records: account 'ann' and identity 'idAnn'; bob's account 'bob2' is a sibling of listed 'bob'
  const family = familyIndex([
    { principalId: 'ann', identityId: 'idAnn' },
    { principalId: 'bob', identityId: 'idBob' }, { principalId: 'bob2', identityId: 'idBob' },
  ]);
  const labels = new Map([
    ['Principal:ann', { label: 'Ann Example' }], ['Principal:bob', { label: 'Bob Example' }], ['Principal:cas', { label: 'Cas Example' }],
    ['Principal:dee', { label: 'Dee Example' }], ['Identity:idEve', { label: 'Eve Example' }],
  ]);
  const input = {
    entity,
    directLinks: [
      { via: 'eigenaar', targetId: 'ann' },
      { via: 'team', targetId: 'bob' },
      { via: 'team', targetId: 'cas' },
      { via: 'team', targetId: 'bob' },   // listed twice: once
      { via: null, targetId: 'zed' },     // no via: the name itself
    ],
    activities: [
      row('Principal', 'ann', '2026-01', 1, 10.5),
      row('Identity', 'idAnn', '2026-03', 1, 4),          // ann's identity counts for her listed account
      row('Principal', 'dee', '2025-12', 1, 20),
      row('Principal', 'bob2', '2026-02', 2, 2.25),        // bob's other account counts for bob
      row('Identity', 'idEve', '2026-02', 1, 1.04),         // an identity nobody listed
      row(null, null, '2026-02', 3, 1),                      // actor unresolved
    ],
    family,
    labels,
  };
  const out = computeEvidence(input);

  it('shows the entity bare', () => {
    expect(out.entity).toEqual({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
  });

  it('lists the people per attribute, crediting work done under any record of the same person', () => {
    expect(out.people).toEqual([
      { via: 'eigenaar', principals: [{ principalId: 'ann', label: 'Ann Example', worked: true, rows: 2, hours: 14.5, lastPeriod: '2026-03' }] },
      { via: 'team', principals: [
        { principalId: 'bob', label: 'Bob Example', worked: true, rows: 2, hours: 2.3, lastPeriod: '2026-02' },
        { principalId: 'cas', label: 'Cas Example', worked: false, rows: 0, hours: 0, lastPeriod: null },
      ] },
      { via: 'displayName', principals: [{ principalId: 'zed', label: null, worked: false, rows: 0, hours: 0, lastPeriod: null }] },
    ]);
  });

  it('sums the activity over all rows: rows, hours, first and last month, distinct months, rows without a resolved person', () => {
    expect(out.activity).toEqual({
      referrerTypes: ['Timesheet'], rows: 9, hours: 38.8, firstPeriod: '2025-12', lastPeriod: '2026-03', periods: 4, unlinkedRows: 3,
    });
  });

  it('names who worked on it without being listed, most hours first, with the record type', () => {
    expect(out.workedNotListed).toEqual([
      { principalId: 'dee', targetType: 'Principal', label: 'Dee Example', rows: 1, hours: 20, lastPeriod: '2025-12' },
      { principalId: 'idEve', targetType: 'Identity', label: 'Eve Example', rows: 1, hours: 1, lastPeriod: '2026-02' },
    ]);
  });

  it('a row without a month takes the period of its last date', () => {
    const e = computeEvidence({ ...input, activities: [{ ...row('Principal', 'ann', null, 1, 1), lastOn: '2026-05-14' }] });
    expect(e.people[0].principals[0]).toMatchObject({ rows: 1, lastPeriod: '2026-05' });
    expect(e.activity).toMatchObject({ firstPeriod: '2026-05', lastPeriod: '2026-05', periods: 1, unlinkedRows: 0 });
  });

  it('no activity: activity null, nobody worked', () => {
    const e = computeEvidence({ ...input, activities: [] });
    expect(e.activity).toBeNull();
    expect(e.workedNotListed).toEqual([]);
    expect(e.people[0].principals[0]).toMatchObject({ worked: false, rows: 0 });
  });
});

describe('getEvidence', () => {
  it('null for an unknown entity, without further reads', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await getEvidence(ID)).toBeNull();
    expect(queryOne.mock.calls[0]).toEqual(['SELECT "id", "entityType", "displayName" FROM "OrgEntities" WHERE "id" = $1', [ID]]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the direct links, the accepted activity on the entity, the people\'s identity links and labels', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query
      .mockResolvedValueOnce({ rows: [{ via: 'eigenaar', targetId: 'ann' }] })
      .mockResolvedValueOnce({ rows: [{ activityType: 'Timesheet', subjectId: ID, actorType: 'Principal', actorId: 'bob', month: '2026-04', rowCount: 1, total: 3.5, lastOn: '2026-04-01' }] })
      .mockResolvedValueOnce({ rows: [] })                                                    // IdentityMembers
      .mockResolvedValueOnce({ rows: [{ id: 'ann', label: 'Ann Example' }, { id: 'bob', label: 'Bob Example' }] });
    const out = await getEvidence(ID);

    const [direct, activity, family, labels] = query.mock.calls;
    expect(direct[0]).toMatch(/WHERE "orgEntityId" = \$1 AND "status" = 'accepted' AND "targetType" = 'Principal'/);
    expect(direct[1]).toEqual([ID]);
    expect(activity[0]).toMatch(/FROM "OrgActivities" a/);
    expect(activity[0]).toMatch(/sk\."targetType" = 'OrgEntity' AND sk\."targetId" = \$1/);
    expect(activity[0]).toMatch(/to_char\(a\."occurredOn", 'YYYY-MM'\) AS month/);
    expect(activity[1]).toEqual([ID]);
    expect(family[1]).toEqual([['ann', 'bob']]);
    expect(labels[1]).toEqual([['ann', 'bob']]);

    expect(out.people).toEqual([{ via: 'eigenaar', principals: [{ principalId: 'ann', label: 'Ann Example', worked: false, rows: 0, hours: 0, lastPeriod: null }] }]);
    expect(out.workedNotListed).toEqual([{ principalId: 'bob', targetType: 'Principal', label: 'Bob Example', rows: 1, hours: 3.5, lastPeriod: '2026-04' }]);
  });

  it('skips the identity and label reads when there is nobody to look up', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const out = await getEvidence(ID);
    expect(query).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ entity: { id: ID, entityType: 'Customer', displayName: 'Contoso' }, people: [], activity: null, workedNotListed: [] });
  });
});
