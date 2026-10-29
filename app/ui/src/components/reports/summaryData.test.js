import { describe, it, expect } from 'vitest';
import {
  BLANK_LABEL, chartSeries, groupLabel, matchesFilter, pivotGroups,
} from '@ui/components/reports/summaryData';

// Worst first, as the reports sort them — and deliberately NOT alphabetical,
// so an implementation that sorts the groups gets the order wrong.
const ROWS = [
  { status: 'Never', role: 'Payroll', members: 7, missed: 3 },
  { status: 'Never', role: 'Finance', members: 2, missed: null },
  { status: 'Reviewed', role: 'Audit', members: 40, missed: 0 },
  { status: '', role: 'Legal', members: 'n/a', missed: 1 },
  { status: 'Never', role: 'Payroll', members: 1, missed: 5 },
];

describe('groupLabel', () => {
  it.each([[null], [undefined], ['']])('folds %p into the blank group', (value) => {
    expect(groupLabel(value)).toBe(BLANK_LABEL);
  });

  it('keeps a zero and a false as themselves', () => {
    expect(groupLabel(0)).toBe('0');
    expect(groupLabel(false)).toBe('false');
  });
});

describe('chartSeries', () => {
  it('counts rows per category in the order they first appear, blanks as their own slice', () => {
    expect(chartSeries({ category: 'status' }, ROWS)).toEqual([
      { label: 'Never', value: 3, share: 0.6 },
      { label: 'Reviewed', value: 1, share: 0.2 },
      { label: BLANK_LABEL, value: 1, share: 0.2 },
    ]);
  });

  it('sums the value column when the chart names one, and adds nothing for a non-number', () => {
    const series = chartSeries({ category: 'status', value: 'members' }, ROWS);
    expect(series.map(s => [s.label, s.value])).toEqual([['Never', 10], ['Reviewed', 40], [BLANK_LABEL, 0]]);
    expect(series[1].share).toBe(0.8);
  });

  it('reads numbers sent as text', () => {
    expect(chartSeries({ category: 'k', value: 'v' }, [{ k: 'a', v: '4' }, { k: 'a', v: '2.5' }]))
      .toEqual([{ label: 'a', value: 6.5, share: 1 }]);
  });

  it('gives every slice a zero share when everything sums to zero, instead of dividing by it', () => {
    expect(chartSeries({ category: 'k', value: 'v' }, [{ k: 'a', v: 0 }, { k: 'b', v: null }]))
      .toEqual([{ label: 'a', value: 0, share: 0 }, { label: 'b', value: 0, share: 0 }]);
  });
});

describe('pivotGroups', () => {
  const pivot = { rows: ['status', 'role'], values: ['members', 'missed'] };

  it('groups on the first row key with counts and sums, in first-appearance order', () => {
    const groups = pivotGroups(pivot, ROWS);
    expect(groups.map(g => [g.label, g.count, g.totals.members, g.totals.missed])).toEqual([
      ['Never', 3, 10, 8],
      ['Reviewed', 1, 40, 0],
      [BLANK_LABEL, 1, 0, 1],
    ]);
    expect(groups[0].key).toBe('status');
  });

  it('nests the next row key under each group, summed over that group only', () => {
    const [never] = pivotGroups(pivot, ROWS);
    expect(never.children.map(g => [g.key, g.label, g.count, g.totals.members])).toEqual([
      ['role', 'Payroll', 2, 8],
      ['role', 'Finance', 1, 2],
    ]);
    expect(never.children[0].children).toEqual([]);
  });

  it('counts rows even when the pivot sums nothing', () => {
    const groups = pivotGroups({ rows: ['status'] }, ROWS);
    expect(groups.map(g => [g.label, g.count, g.totals])).toEqual([
      ['Never', 3, {}], ['Reviewed', 1, {}], [BLANK_LABEL, 1, {}],
    ]);
  });

  it('has no groups for a pivot without rows', () => {
    expect(pivotGroups({ values: ['members'] }, ROWS)).toEqual([]);
  });
});

describe('matchesFilter', () => {
  it('needs every condition to hold', () => {
    const filter = [{ key: 'status', label: 'Never' }, { key: 'role', label: 'Payroll' }];
    expect(ROWS.filter(r => matchesFilter(r, filter))).toEqual([ROWS[0], ROWS[4]]);
  });

  it('matches the blank group to blank cells', () => {
    expect(ROWS.filter(r => matchesFilter(r, [{ key: 'status', label: BLANK_LABEL }]))).toEqual([ROWS[3]]);
  });

  it('matches every row when there are no conditions', () => {
    expect(ROWS.every(r => matchesFilter(r, []))).toBe(true);
  });
});
