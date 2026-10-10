import { describe, it, expect } from 'vitest';
import { applyActivity, dayOf, monthPeriod, measureOf, distinctKeys } from './activityParse.js';

const recipe = (over = {}) => ({
  version: 1, template: 'activity',
  activity: {
    type: 'Hours',
    actor: { column: 'c3', targetTypes: ['Principal'] },
    subject: { column: 'c4', targetType: 'OrgEntity' },
    when: { yearColumn: 'c1', monthColumn: 'c2' },
    measure: { column: 'c5', unit: 'h' },
    attributes: [{ column: 'c6', name: 'note' }],
    ...over,
  },
});
const row = (c1, c2, c3, c4, c5, c6 = '') => ({ c1, c2, c3, c4, c5, c6 });

describe('dayOf', () => {
  it.each([
    ['2026-03-07', '2026-03-07'],
    ['2026-03-07T00:00:00.000Z', '2026-03-07'],
    ['2026-03-07 10:30', '2026-03-07'],
    ['7-3-2026', '2026-03-07'],
    ['07/03/2026', '2026-03-07'],
    ['7.3.2026', '2026-03-07'],
    ['2026/3/7', '2026-03-07'],
  ])('%s → %s (day first)', (v, out) => expect(dayOf(v)).toBe(out));

  it.each(['2026-02-30', '31-04-2026', '2026-13-01', '2026-03-07x', '2026-03-07Tnoon', 'maart', '', null])('refuses %s', (v) => {
    expect(dayOf(v)).toBeNull();
  });
});

describe('monthPeriod', () => {
  it('a Dutch or English month name or number, with the period\'s first and last day', () => {
    expect(monthPeriod('2026', 'maart')).toEqual({ occurredOn: '2026-03-01', periodEnd: '2026-03-31' });
    expect(monthPeriod(' 2024 ', 'February')).toEqual({ occurredOn: '2024-02-01', periodEnd: '2024-02-29' });
    expect(monthPeriod('2025', 'feb')).toEqual({ occurredOn: '2025-02-01', periodEnd: '2025-02-28' });
    expect(monthPeriod('2026', '12')).toEqual({ occurredOn: '2026-12-01', periodEnd: '2026-12-31' });
    expect(monthPeriod('2026', 'april').periodEnd).toBe('2026-04-30');
  });
  it('null when the year or the month does not read', () => {
    expect(monthPeriod('26', 'maart')).toBeNull();
    expect(monthPeriod('2126', 'maart')).toBeNull();
    expect(monthPeriod('2026', '13')).toBeNull();
    expect(monthPeriod('2026', 'maartje')).toBeNull();
    expect(monthPeriod('', '')).toBeNull();
  });
});

describe('measureOf', () => {
  it.each([
    ['7,5', 7.5], ['7.5', 7.5], ['8', 8], ['1.234,5', 1234.5], ['1,234.5', 1234.5], ['-2,25', -2.25], [' 1 000,5 ', 1000.5], ['+3', 3],
  ])('%s → %s', (v, n) => expect(measureOf(v)).toBe(n));
  it('blank is null, text is NaN', () => {
    expect(measureOf('  ')).toBeNull();
    expect(measureOf(undefined)).toBeNull();
    expect(measureOf('abc')).toBeNaN();
    expect(measureOf('7,5h')).toBeNaN();
    expect(measureOf('1.2.3,4.5')).toBeNaN();
  });
});

describe('applyActivity', () => {
  it('turns each row into a fact: raw actor/subject, the month as a period, the measure as a number, extra attributes', () => {
    const { facts, skipped } = applyActivity([row('2026', 'maart', ' Ann Example ', 'Contoso', '7,5', 'on site')], recipe());
    expect(skipped).toEqual([]);
    expect(facts).toEqual([{
      row: 1, sourceLocator: 'row:1', actor: 'Ann Example', subject: 'Contoso',
      occurredOn: '2026-03-01', periodEnd: '2026-03-31', measure: 7.5, unit: 'h', attributes: { note: 'on site' },
    }]);
  });

  it('a date column gives a point in time; no measure in the recipe gives a null measure and unit', () => {
    const r = recipe({ when: { dateColumn: 'c1' }, measure: undefined, attributes: [] });
    const { facts } = applyActivity([row('2026-03-07', '', 'Ann', 'Contoso', 'x')], r);
    expect(facts[0]).toMatchObject({ occurredOn: '2026-03-07', periodEnd: null, measure: null, unit: null, attributes: {} });
  });

  it('skips a row without actor, subject, readable date or numeric measure — and says why, with the file row', () => {
    const rows = [
      row('2026', 'maart', '', 'Contoso', '1'),
      row('2026', 'maart', 'Ann', '', '1'),
      row('2026', 'smarch', 'Ann', 'Contoso', '1'),
      row('2026', 'maart', 'Ann', 'Contoso', 'veel'),
      row('2026', 'maart', 'Ann', 'Contoso', ''),
    ];
    const { facts, skipped } = applyActivity(rows, recipe());
    expect(skipped).toEqual([
      { row: 1, reason: 'row 1 has no c3' },
      { row: 2, reason: 'row 2 has no c4' },
      { row: 3, reason: 'row 3 has no readable date' },
      { row: 4, reason: 'row 4: "veel" is not a number' },
    ]);
    // a blank measure is no reason to skip
    expect(facts).toEqual([expect.objectContaining({ row: 5, measure: null })]);
  });

  it('a fully blank row is neither a fact nor skipped, and keeps the row numbers of the rest', () => {
    const { facts, skipped } = applyActivity([row('', '', '', '', ''), row('2026', '3', 'Ann', 'Contoso', '2')], recipe());
    expect(skipped).toEqual([]);
    expect(facts.map(f => f.row)).toEqual([2]);
  });
});

describe('distinctKeys', () => {
  it('counts the facts per distinct value and role, in first-seen order', () => {
    const facts = [{ actor: 'Ann', subject: 'Contoso' }, { actor: 'Bob', subject: 'Contoso' }, { actor: 'Ann', subject: 'Northwind' }];
    const d = distinctKeys(facts);
    expect([...d.actor]).toEqual([['Ann', 2], ['Bob', 1]]);
    expect([...d.subject]).toEqual([['Contoso', 2], ['Northwind', 1]]);
  });
});
