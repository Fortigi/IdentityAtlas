import { describe, it, expect, vi } from 'vitest';
import {
  GROUP_ROW_H, VALUE_ROW_H,
  apBandBorderClass, buildCrossRows, computeHeaderMode, crossGroupingHeight, distinctValueCount, spanInteraction,
} from './headerMode';

// Subjects carry their sort values in `sortKeys`, already sorted on the column
// axis — the shape MatrixView hands the header.
const u = (id, ...sortKeys) => ({ id, displayName: id, sortKeys });
const users = (values) => values.map((v, i) => u(`u${i}`, ...[].concat(v)));

describe('distinctValueCount', () => {
  it('counts distinct values at one level, treating a missing key as empty', () => {
    expect(distinctValueCount(users(['Eng', 'Eng', 'Sales', '']), 0)).toBe(3);
    expect(distinctValueCount([{ id: 'x' }, { id: 'y' }], 0)).toBe(1);
    expect(distinctValueCount([], 0)).toBe(0);
    expect(distinctValueCount(undefined, 0)).toBe(0);
  });
});

describe('computeHeaderMode', () => {
  it('picks the cross table when it is shorter than the rotated stack (AC1)', () => {
    // 12 subjects, 3 distinct departments → 3 × 20px = 60px ≤ 120px.
    const list = users([...Array(5).fill('Eng'), ...Array(4).fill('Sales'), ...Array(3).fill('HR')]);
    expect(computeHeaderMode(list, 1)).toBe('cross');
    expect(3 * VALUE_ROW_H).toBeLessThanOrEqual(GROUP_ROW_H);
  });

  it('falls back to the rotated rows when a level has too many values (AC2)', () => {
    // 8 distinct departments → 160px > 120px.
    const list = users(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'h', 'h']);
    expect(computeHeaderMode(list, 1)).toBe('rotated');
  });

  it('decides for the WHOLE stack, never per level (AC3/AC4)', () => {
    const fits = users([
      ['A', 't1'], ['A', 't2'], ['A', 't3'], ['A', 't4'], ['A', 't5'], ['A', 't6'], ['B', 't6'],
    ]); // 2 + 6 distinct = 8 rows = 160px ≤ 2 × 120px
    expect(computeHeaderMode(fits, 2)).toBe('cross');

    const tooTall = Array.from({ length: 30 }, (_, i) => u(`u${i}`, i < 15 ? 'A' : 'B', `t${i}`));
    expect(computeHeaderMode(tooTall, 2)).toBe('rotated'); // 2 + 30 = 640px > 240px
  });

  it('handles the empty matrix and a zero-level config without crashing (AC7)', () => {
    expect(computeHeaderMode([], 2)).toBe('cross');
    expect(computeHeaderMode(users(['Eng']), 0)).toBe('cross');
  });

  it('is stable under folding — the mode is a property of the definition', () => {
    // Folding replaces subjects with aggregate columns, which can only ever draw
    // a SUBSET of the definition's values, so the mode computed from the
    // unfolded set stays valid (and unchanged) afterwards.
    const list = users([['A', 'x'], ['A', 'y'], ['B', 'z']]);
    const mode = computeHeaderMode(list, 2);
    const folded = [{ id: 'agg', isAggregateCol: true, level: 0, value: 'A', sortKeys: ['A', '@@AGG@@1'] }, list[2]];
    expect(computeHeaderMode(folded, 2)).toBe(mode);
  });
});

describe('buildCrossRows', () => {
  it('derives one row per distinct value in column order, with a run per block', () => {
    const list = users(['Eng', 'Eng', 'Sales', 'Eng']);
    const { rows, spans } = buildCrossRows(list, 0);
    expect(rows.map(r => r.value)).toEqual(['Eng', 'Sales']);
    // Eng appears as two separate runs — the same value under two parents (AC5).
    expect(spans.filter(s => s.value === 'Eng').map(s => [s.start, s.span])).toEqual([[0, 2], [3, 1]]);
    expect(spans.every(s => s.kind === 'value')).toBe(true);
  });

  it('puts the empty value last, labelled by the renderer as (none) (AC8/AC12)', () => {
    const { rows } = buildCrossRows(users(['Eng', '']), 0);
    expect(rows.map(r => r.value)).toEqual(['Eng', '']);
  });

  it('renders a folded aggregate as a value at its own level and a block below', () => {
    const agg = { id: 'agg', isAggregateCol: true, level: 0, value: 'Eng', childCounts: { 1: 4 }, sortKeys: ['Eng', '@@AGG@@agg 1'] };
    expect(buildCrossRows([agg], 0).spans[0].kind).toBe('value');
    const deeper = buildCrossRows([agg], 1);
    expect(deeper.spans[0].kind).toBe('aggregate');
    // The level still shows one (unlabelled) row so the child count has a home.
    expect(deeper.rows).toEqual([{ value: null }]);
  });

  it('treats a member-exploded column as inert below its own level', () => {
    const mem = { id: 'm1', isMemberCol: true, memberLevel: 0, sortKeys: ['Eng', ''] };
    expect(buildCrossRows([mem], 0).spans[0].kind).toBe('value');
    const deeper = buildCrossRows([mem], 1);
    expect(deeper.spans[0].kind).toBe('inert');
    expect(deeper.rows).toEqual([]); // nothing to show at this level
  });

  it('reports no rows for an empty matrix (AC7)', () => {
    expect(buildCrossRows([], 0)).toEqual({ spans: [], rows: [] });
  });
});

describe('crossGroupingHeight', () => {
  it('sums the value rows of every shown level', () => {
    expect(crossGroupingHeight([{ rows: [1, 2, 3] }, { rows: [1] }])).toBe(4 * VALUE_ROW_H);
    expect(crossGroupingHeight([])).toBe(0);
    expect(crossGroupingHeight(undefined)).toBe(0);
  });
});

describe('apBandBorderClass', () => {
  it('opens the access-package block and every new category with a divider', () => {
    const aps = [{ categoryName: 'Ops' }, { categoryName: 'Ops' }, { categoryName: 'Finance' }, {}];
    expect(apBandBorderClass(aps, 0)).toContain('border-l-indigo-300');
    expect(apBandBorderClass(aps, 1)).toBe('');
    expect(apBandBorderClass(aps, 2)).toContain('border-l-gray-400');
    expect(apBandBorderClass(aps, 3)).toContain('border-l-gray-400'); // uncategorised
  });
});

describe('spanInteraction', () => {
  const span = (value, start = 0, s = 1) => ({ value, start, span: s });

  it('collapses a plain group at the clicked level', () => {
    const onToggleCollapse = vi.fn();
    const list = users([['Eng', 'Payroll']]);
    const it0 = spanInteraction(list, span('Eng'), 0, { onToggleCollapse });
    expect(it0.collapsible).toBe(true);
    expect(it0.title).toBe('Collapse Eng into one column');
    it0.onClick();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Eng', 'Payroll'], 0);
  });

  it('labels an empty value (none)', () => {
    const list = users(['']);
    expect(spanInteraction(list, span(''), 0, { onToggleCollapse: vi.fn() }).title)
      .toBe('Collapse (none) into one column');
  });

  it('unfolds an aggregate at its own level and counts children below it', () => {
    const onToggleCollapse = vi.fn();
    const agg = { id: 'agg', isAggregateCol: true, level: 0, value: 'Eng', childCounts: { 1: 6 }, sortKeys: ['Eng', 'x'] };
    const here = spanInteraction([agg], span('Eng'), 0, { onToggleCollapse });
    expect(here.aggHere).toBe(true);
    expect(here.showChildCount).toBe(false);
    expect(here.title).toBe('Expand Eng back into its columns');
    here.onClick();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Eng', 'x'], 0);

    expect(spanInteraction([agg], span('x'), 1, { onToggleCollapse }).showChildCount).toBe(true);
  });

  it('collapses exploded members back at their own level and is inert below', () => {
    const onToggleMembers = vi.fn();
    const mem = { id: 'm', isMemberCol: true, memberLevel: 1, sortKeys: ['Eng', 'Payroll'] };
    const own = spanInteraction([mem], span('Payroll'), 1, { onToggleMembers, onToggleCollapse: vi.fn() });
    expect(own.memberOwn).toBe(true);
    expect(own.title).toBe('Collapse Payroll members back into a count');
    own.onClick();
    expect(onToggleMembers).toHaveBeenCalledWith(['Eng', 'Payroll'], 1);

    const deep = spanInteraction([mem], span(''), 2, { onToggleMembers, onToggleCollapse: vi.fn() });
    expect(deep.memberDeep).toBe(true);
    expect(deep.onClick).toBeUndefined();
    expect(deep.title).toBeUndefined();
  });

  it('offers no click when the header is read-only', () => {
    const list = users(['Eng']);
    expect(spanInteraction(list, span('Eng'), 0).onClick).toBeUndefined();
    const agg = { id: 'agg', isAggregateCol: true, level: 0, value: 'Eng', sortKeys: ['Eng'] };
    expect(spanInteraction([agg], span('Eng'), 0).onClick).toBeUndefined();
  });
});
