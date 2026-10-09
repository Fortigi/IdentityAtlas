import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import { monthOf, periodOf, hoursOf, computeEvidence, getEvidence } from './evidence.js';

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
  const sheet = (id, attrs) => ({ id, entityType: 'Timesheet', attributes: attrs });
  const labels = new Map([['ann', 'Ann Example'], ['bob', 'Bob Example'], ['cas', 'Cas Example'], ['dee', 'Dee Example']]);
  const input = {
    entity,
    directLinks: [
      { via: 'eigenaar', targetId: 'ann' },
      { via: 'team', targetId: 'bob' },
      { via: 'team', targetId: 'cas' },
      { via: 'team', targetId: 'bob' },   // listed twice: once
      { via: null, targetId: 'zed' },     // no via: the name itself
    ],
    referrers: [
      sheet('t1', { jaar: '2026', maand: 'januari', uren: '10,5' }),
      sheet('t2', JSON.stringify({ jaar: '2026', maand: 'maart', uren: '4,0' })),
      sheet('t3', { jaar: '2025', maand: 'december', uren: '20,0' }),
      sheet('t4', { jaar: '2026', maand: 'februari', uren: '2,25' }),
      sheet('t5', { uren: '1,0' }),                                // no period
    ],
    referrerLinks: [
      { orgEntityId: 't1', targetId: 'ann' },
      { orgEntityId: 't2', targetId: 'ann' },
      { orgEntityId: 't3', targetId: 'dee' },
      { orgEntityId: 't4', targetId: 'cas' },
      { orgEntityId: 't4', targetId: 'eve' },                       // a row naming two people counts for both
    ],
    labels,
  };
  const out = computeEvidence(input);

  it('shows the entity bare', () => {
    expect(out.entity).toEqual({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
  });

  it('lists the people per attribute, each marked with whether, how much and until when they worked on it', () => {
    expect(out.people).toEqual([
      { via: 'eigenaar', principals: [{ principalId: 'ann', label: 'Ann Example', worked: true, rows: 2, hours: 14.5, lastPeriod: '2026-03' }] },
      { via: 'team', principals: [
        { principalId: 'bob', label: 'Bob Example', worked: false, rows: 0, hours: 0, lastPeriod: null },
        { principalId: 'cas', label: 'Cas Example', worked: true, rows: 1, hours: 2.3, lastPeriod: '2026-02' },
      ] },
      { via: 'displayName', principals: [{ principalId: 'zed', label: null, worked: false, rows: 0, hours: 0, lastPeriod: null }] },
    ]);
  });

  it('sums the activity over all referring rows: rows, hours, first and last period, distinct periods, unlinked rows', () => {
    expect(out.activity).toEqual({
      referrerTypes: ['Timesheet'], rows: 5, hours: 37.8, firstPeriod: '2025-12', lastPeriod: '2026-03', periods: 4, unlinkedRows: 1,
    });
  });

  it('names who worked on it without being listed, most hours first', () => {
    expect(out.workedNotListed).toEqual([
      { principalId: 'dee', label: 'Dee Example', rows: 1, hours: 20, lastPeriod: '2025-12' },
      { principalId: 'eve', label: null, rows: 1, hours: 2.3, lastPeriod: '2026-02' },
    ]);
  });

  it('the last period of a person is the latest of their rows, whatever the order', () => {
    const e = computeEvidence({
      ...input,
      referrers: [sheet('a', { jaar: '2026', maand: 'mei' }), sheet('b', { jaar: '2026', maand: 'jan' }), sheet('c', { uren: '1,0' })],
      referrerLinks: [{ orgEntityId: 'a', targetId: 'ann' }, { orgEntityId: 'b', targetId: 'ann' }, { orgEntityId: 'c', targetId: 'ann' }],
    });
    expect(e.people[0].principals[0]).toMatchObject({ rows: 3, lastPeriod: '2026-05' });
    expect(e.activity).toMatchObject({ firstPeriod: '2026-01', lastPeriod: '2026-05', periods: 2, unlinkedRows: 0 });
  });

  it('no referring rows: activity null, nobody worked', () => {
    const e = computeEvidence({ ...input, referrers: [], referrerLinks: [] });
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

  it('reads the direct links, the referring rows of other types, their people and the labels', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query
      .mockResolvedValueOnce({ rows: [{ via: 'eigenaar', targetId: 'ann' }] })
      .mockResolvedValueOnce({ rows: [{ id: 't1', entityType: 'Timesheet', attributes: { jaar: '2026', maand: '4', uren: '3,5' } }] })
      .mockResolvedValueOnce({ rows: [{ orgEntityId: 't1', targetId: 'bob' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ann', displayName: 'Ann Example' }, { id: 'bob', displayName: 'Bob Example' }] });
    const out = await getEvidence(ID);

    const [direct, referrers, people, labels] = query.mock.calls;
    expect(direct[0]).toMatch(/WHERE "orgEntityId" = \$1 AND "status" = 'accepted' AND "targetType" = 'Principal'/);
    expect(direct[1]).toEqual([ID]);
    expect(referrers[0]).toMatch(/l\."targetType" = 'OrgEntity' AND l\."targetId" = \$1 AND l\."status" = 'accepted'/);
    expect(referrers[0]).toMatch(/l\."via" IS DISTINCT FROM 'displayName'/);
    expect(referrers[0]).toMatch(/r\."status" = 'accepted' AND r\."validTo" IS NULL AND r\."entityType" <> \$2/);
    expect(referrers[1]).toEqual([ID, 'Customer']);
    expect(people[0]).toMatch(/"orgEntityId" = ANY\(\$1::uuid\[\]\) AND "status" = 'accepted' AND "targetType" = 'Principal'/);
    expect(people[1]).toEqual([['t1']]);
    expect(labels[1]).toEqual([['ann', 'bob']]);

    expect(out.people).toEqual([{ via: 'eigenaar', principals: [{ principalId: 'ann', label: 'Ann Example', worked: false, rows: 0, hours: 0, lastPeriod: null }] }]);
    expect(out.workedNotListed).toEqual([{ principalId: 'bob', label: 'Bob Example', rows: 1, hours: 3.5, lastPeriod: '2026-04' }]);
  });

  it('skips the people and label reads when there is nothing to look up', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const out = await getEvidence(ID);
    expect(query).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ entity: { id: ID, entityType: 'Customer', displayName: 'Contoso' }, people: [], activity: null, workedNotListed: [] });
  });
});
