import { describe, it, expect } from 'vitest';
import {
  formatPeriod, monthsSince, activityVerdict, summarizePeople, formatHours, workedText,
  activityLine, evidenceEmpty, verdictPillClass, ACTIVE_MONTHS, QUIET_MONTHS,
} from './evidence';

// 15 October 2026 (month index 9): exactly 3 months back is 2026-07, 12 back is 2025-10.
const TODAY = new Date(2026, 9, 15);

describe('formatPeriod', () => {
  it('names the month and the year', () => {
    expect(formatPeriod('2024-03')).toBe('March 2024');
    expect(formatPeriod('2024-01')).toBe('January 2024');
    expect(formatPeriod('2023-12')).toBe('December 2023');
    expect(formatPeriod('2026-10')).toBe('October 2026');
  });

  it('returns anything that is not a period as given', () => {
    expect(formatPeriod(null)).toBe('');
    expect(formatPeriod(undefined)).toBe('');
    expect(formatPeriod('2024-13')).toBe('2024-13');
    expect(formatPeriod('2024-00')).toBe('2024-00');
    expect(formatPeriod('2024-3')).toBe('2024-3');
    expect(formatPeriod('x2024-03')).toBe('x2024-03');
    expect(formatPeriod('2024-03x')).toBe('2024-03x');
  });
});

describe('monthsSince', () => {
  it('counts whole calendar months to today', () => {
    expect(monthsSince('2026-10', TODAY)).toBe(0);
    expect(monthsSince('2026-07', TODAY)).toBe(3);
    expect(monthsSince('2025-10', TODAY)).toBe(12);
    expect(monthsSince('2024-11', TODAY)).toBe(23);
    expect(monthsSince('2026-12', TODAY)).toBe(-2);
  });

  it('is null without a period', () => {
    expect(monthsSince(null, TODAY)).toBeNull();
    expect(monthsSince('soon', TODAY)).toBeNull();
  });

  it('defaults to the current date', () => {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(monthsSince(period)).toBe(0);
  });
});

describe('activityVerdict', () => {
  const at = (lastPeriod) => activityVerdict({ rows: 4, hours: 10, lastPeriod }, TODAY);

  it('says none when no other list refers to the entity', () => {
    expect(activityVerdict(null, TODAY)).toEqual({ kind: 'none', text: 'No other list refers to this entity' });
  });

  it('is active up to and including exactly 3 months', () => {
    expect(ACTIVE_MONTHS).toBe(3);
    expect(at('2026-10')).toEqual({ kind: 'active', text: 'Hours written until October 2026' });
    expect(at('2026-07')).toEqual({ kind: 'active', text: 'Hours written until July 2026' });
  });

  it('is quiet from 4 months up to and including exactly 12', () => {
    expect(QUIET_MONTHS).toBe(12);
    expect(at('2026-06')).toEqual({ kind: 'quiet', text: 'Quiet: last hours in June 2026' });
    expect(at('2025-10')).toEqual({ kind: 'quiet', text: 'Quiet: last hours in October 2025' });
  });

  it('is inactive past 12 months', () => {
    expect(at('2025-09')).toEqual({ kind: 'inactive', text: 'No hours since September 2025' });
    expect(at('2019-01')).toEqual({ kind: 'inactive', text: 'No hours since January 2019' });
  });

  it('treats a future period as active', () => {
    expect(at('2027-02').kind).toBe('active');
  });

  it('is inactive when no row carries a period', () => {
    expect(at(null)).toEqual({ kind: 'inactive', text: 'No dated hours found' });
  });

  it('defaults today to now', () => {
    expect(activityVerdict({ lastPeriod: '2000-01' }).kind).toBe('inactive');
  });
});

describe('verdictPillClass', () => {
  it('colours active green, quiet amber, the rest gray', () => {
    expect(verdictPillClass('active')).toContain('bg-green-50');
    expect(verdictPillClass('quiet')).toContain('bg-amber-50');
    expect(verdictPillClass('inactive')).toContain('bg-gray-100');
    expect(verdictPillClass('none')).toContain('bg-gray-100');
    expect(verdictPillClass('active')).toContain('dark:bg-green-900/20');
  });
});

describe('summarizePeople', () => {
  it('counts distinct people and who of them worked', () => {
    const people = [
      { via: 'eigenaar', principals: [{ principalId: 'p1', worked: true }] },
      { via: 'team', principals: [
        { principalId: 'p1', worked: false },
        { principalId: 'p2', worked: false },
        { principalId: 'p3', worked: true },
      ] },
    ];
    expect(summarizePeople(people)).toEqual({ listed: 3, worked: 2, notWorked: 1 });
  });

  it('counts a person as worked when any group says so, in either order', () => {
    const people = [
      { via: 'team', principals: [{ principalId: 'p1', worked: false }] },
      { via: 'eigenaar', principals: [{ principalId: 'p1', worked: true }] },
    ];
    expect(summarizePeople(people)).toEqual({ listed: 1, worked: 1, notWorked: 0 });
  });

  it('is zero for nothing', () => {
    expect(summarizePeople(null)).toEqual({ listed: 0, worked: 0, notWorked: 0 });
    expect(summarizePeople([{ via: 'team' }])).toEqual({ listed: 0, worked: 0, notWorked: 0 });
  });
});

describe('formatHours', () => {
  it('rounds to one decimal with separators', () => {
    expect(formatHours(1234.56)).toBe('1,234.6');
    expect(formatHours(8)).toBe('8');
    expect(formatHours('7.25')).toBe('7.3');
  });

  it('is 0 for a non-number', () => {
    expect(formatHours(undefined)).toBe('0');
    expect(formatHours('abc')).toBe('0');
  });
});

describe('workedText', () => {
  it('says until when, in words', () => {
    expect(workedText({ worked: true, lastPeriod: '2024-03' })).toBe('yes, until March 2024');
    expect(workedText({ worked: true, lastPeriod: null })).toBe('yes');
    expect(workedText({ worked: false, lastPeriod: '2024-03' })).toBe('no hours found');
    expect(workedText(null)).toBe('no hours found');
  });
});

describe('activityLine', () => {
  it('lists rows, hours, the period range and unlinked rows', () => {
    expect(activityLine({ rows: 1200, hours: 340.5, firstPeriod: '2023-02', lastPeriod: '2024-03', unlinkedRows: 3 }))
      .toBe('1,200 rows · 340.5 hours · from February 2023 to March 2024 · 3 rows whose person is not linked to an account');
  });

  it('uses the singular for one row and leaves out what is missing', () => {
    expect(activityLine({ rows: 1, hours: 2, firstPeriod: '2023-02', lastPeriod: null, unlinkedRows: 1 }))
      .toBe('1 row · 2 hours · 1 row whose person is not linked to an account');
    expect(activityLine({ rows: 2, hours: 2, firstPeriod: null, lastPeriod: '2024-03', unlinkedRows: 0 }))
      .toBe('2 rows · 2 hours');
    expect(activityLine({})).toBe('0 rows · 0 hours');
  });

  it('is empty without activity', () => {
    expect(activityLine(null)).toBe('');
  });
});

describe('evidenceEmpty', () => {
  it('is empty only with no people and no activity', () => {
    expect(evidenceEmpty(null)).toBe(true);
    expect(evidenceEmpty({ people: [], activity: null })).toBe(true);
    expect(evidenceEmpty({ activity: null })).toBe(true);
    expect(evidenceEmpty({ people: [{ via: 'team', principals: [] }], activity: null })).toBe(false);
    expect(evidenceEmpty({ people: [], activity: { rows: 1 } })).toBe(false);
  });
});
