import { describe, it, expect } from 'vitest';
import {
  formatOn, formatMeasure, refDetailKind, monthBars, shortMonth, byTotalDesc, memberText,
  subjectLine, subjectEmpty, actorGroups,
} from './activity';

describe('formatOn / formatMeasure / refDetailKind', () => {
  it('shows a date as its month and nothing for no date', () => {
    expect(formatOn('2026-03-15')).toBe('March 2026');
    expect(formatOn(null)).toBe('');
    expect(formatOn('')).toBe('');
  });

  it('puts the unit after the rounded measure, and leaves it off without one', () => {
    expect(formatMeasure(1152.46, 'h')).toBe('1,152.5 h');
    expect(formatMeasure(3)).toBe('3');
  });

  it('opens another list\'s entity as an org-entity tab and a system object as its own kind', () => {
    expect(refDetailKind('OrgEntity')).toBe('org-entity');
    expect(refDetailKind('Principal')).toBe('user');
    expect(refDetailKind('Identity')).toBe('identity');
    expect(refDetailKind('Nope')).toBeNull();
  });
});

describe('monthBars', () => {
  it('sorts the months and scales each bar to the largest month', () => {
    const bars = monthBars([{ month: '2026-03', total: 40 }, { month: '2026-01', total: 10 }, { month: '2026-02', total: '20' }], 80);
    expect(bars.map(b => [b.month, b.total, b.height, b.label])).toEqual([
      ['2026-01', 10, 20, 'January 2026'],
      ['2026-02', 20, 40, 'February 2026'],
      ['2026-03', 40, 80, 'March 2026'],
    ]);
  });

  it('draws every bar flat when no month has activity, and nothing for no months', () => {
    expect(monthBars([{ month: '2026-01', total: 0 }]).map(b => b.height)).toEqual([0]);
    expect(monthBars(null)).toEqual([]);
  });

  it('uses 80 px as the default height of the largest bar', () => {
    expect(monthBars([{ month: '2026-01', total: 5 }])[0].height).toBe(80);
  });
});

describe('shortMonth', () => {
  it('abbreviates the month and the year', () => {
    expect(shortMonth('2026-09')).toBe('Sep 26');
    expect(shortMonth('bad')).toBe('bad');
  });
});

describe('byTotalDesc / memberText', () => {
  it('orders by total, most first, then by name', () => {
    const rows = [{ label: 'B', total: 5 }, { label: 'C', total: 9 }, { label: 'A', total: 5 }];
    expect([...rows].sort(byTotalDesc).map(r => r.label)).toEqual(['C', 'A', 'B']);
  });

  it('names the member roles, says yes without roles and no for a non-member', () => {
    expect(memberText({ isMember: true, memberRoles: ['eigenaar', '', 'team'] })).toBe('yes · eigenaar, team');
    expect(memberText({ isMember: true, memberRoles: [] })).toBe('yes');
    expect(memberText({ isMember: false, memberRoles: ['team'] })).toBe('no');
    expect(memberText(null)).toBe('no');
  });
});

describe('subjectLine / subjectEmpty', () => {
  it('names the type, the total, the period and the unresolved rows', () => {
    expect(subjectLine({ type: 'Uren', unit: 'h', total: 12.25, firstOn: '2025-11-01', lastOn: '2026-02-01', unresolvedRows: 1 }))
      .toBe('Uren: 12.3 h · from November 2025 to February 2026 · 1 row whose person is not resolved yet');
    expect(subjectLine({ type: 'Uren', total: 4, firstOn: '2025-11-01', unresolvedRows: 2 }))
      .toBe('Uren: 4 · 2 rows whose person is not resolved yet');
    expect(subjectLine({ type: 'Uren', total: 4, unresolvedRows: 0 })).toBe('Uren: 4');
    expect(subjectLine(null)).toBe('');
  });

  it('is empty without months and without actors, not when either is there', () => {
    expect(subjectEmpty(null)).toBe(true);
    expect(subjectEmpty({ months: [], actors: [] })).toBe(true);
    expect(subjectEmpty({ months: [{ month: '2026-01', total: 1 }], actors: [] })).toBe(false);
    expect(subjectEmpty({ months: [], actors: [{ label: 'Ann Example' }] })).toBe(false);
  });
});

describe('actorGroups', () => {
  it('drops groups without subjects and sorts the subjects by total', () => {
    const groups = actorGroups({ groups: [
      { type: 'Uren', unit: 'h', subjects: [{ label: 'Contoso', total: 2 }, { label: 'Northwind', total: 8 }] },
      { type: 'Log', subjects: [] },
    ] });
    expect(groups.map(g => [g.type, g.subjects.map(s => s.label)])).toEqual([['Uren', ['Northwind', 'Contoso']]]);
    expect(actorGroups(null)).toEqual([]);
  });
});
