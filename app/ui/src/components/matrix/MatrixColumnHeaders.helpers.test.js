import { describe, it, expect, vi } from 'vitest';
import {
  spanState,
  computeGroupingCell,
  isApCategoryBoundary,
  apLeftBorderClass,
  subjectTitle,
  subjectLabel,
  identityGlyph,
} from './MatrixColumnHeaders.helpers';

describe('spanState', () => {
  it('flags a plain merged group as none of the special kinds', () => {
    expect(spanState({}, 0)).toEqual({ aggHere: false, showChildCount: false, memberOwn: false, memberDeep: false });
    expect(spanState(undefined, 2)).toEqual({ aggHere: false, showChildCount: false, memberOwn: false, memberDeep: false });
  });

  it('treats an aggregate at-or-below its fold level as aggHere, and deeper as a child count', () => {
    const col = { isAggregateCol: true, level: 1 };
    expect(spanState(col, 0).aggHere).toBe(false); // ancestor row
    expect(spanState(col, 1)).toMatchObject({ aggHere: true, showChildCount: false });
    expect(spanState(col, 2)).toMatchObject({ aggHere: true, showChildCount: true });
  });

  it('marks the member-explode header at its own level and inert placeholders below', () => {
    const col = { isMemberCol: true, memberLevel: 1 };
    expect(spanState(col, 1)).toMatchObject({ memberOwn: true, memberDeep: false });
    expect(spanState(col, 2)).toMatchObject({ memberOwn: false, memberDeep: true });
  });
});

describe('computeGroupingCell', () => {
  const span = { value: 'Finance', start: 0, span: 2 };

  it('makes a plain group collapsible when onToggleCollapse is supplied', () => {
    const onToggleCollapse = vi.fn();
    const cell = computeGroupingCell({ col: { sortKeys: ['Finance'] }, rowIdx: 0, span, onToggleCollapse });
    expect(cell.highlight).toBe(false);
    expect(cell.title).toBe('Collapse Finance into one column');
    expect(cell.label).toBe('Finance');
    cell.onClick();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Finance'], 0);
  });

  it('leaves a plain group inert with no handler when onToggleCollapse is absent', () => {
    const cell = computeGroupingCell({ col: {}, rowIdx: 0, span });
    expect(cell.onClick).toBeUndefined();
    expect(cell.title).toBeUndefined();
  });

  it('renders an aggregate as an expandable highlighted cell', () => {
    const onToggleCollapse = vi.fn();
    const col = { isAggregateCol: true, level: 0, value: 'Ops', sortKeys: ['Ops'], childCounts: [0, 5] };
    const cell = computeGroupingCell({ col, rowIdx: 0, span, onToggleCollapse });
    expect(cell.highlight).toBe(true);
    expect(cell.label).toBe('▤ Ops');
    expect(cell.title).toBe('Expand Ops back into its columns');
    cell.onClick();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Ops'], 0);
  });

  it('shows a child count on the rows below an aggregate fold', () => {
    const col = { isAggregateCol: true, level: 0, value: 'Ops', sortKeys: ['Ops'], childCounts: [0, 5] };
    const cell = computeGroupingCell({ col, rowIdx: 1, span, onToggleCollapse: vi.fn() });
    expect(cell.showChildCount).toBe(true);
    expect(cell.childCount).toBe(5);
  });

  it('defaults the child count to 0 when childCounts is missing', () => {
    const col = { isAggregateCol: true, level: 0, value: 'Ops' };
    const cell = computeGroupingCell({ col, rowIdx: 1, span, onToggleCollapse: vi.fn() });
    expect(cell.childCount).toBe(0);
  });

  it('wires a member-own header to onToggleMembers', () => {
    const onToggleMembers = vi.fn();
    const col = { isMemberCol: true, memberLevel: 1, sortKeys: ['x'] };
    const cell = computeGroupingCell({ col, rowIdx: 1, span, onToggleMembers });
    expect(cell.highlight).toBe(true);
    expect(cell.label).toBe('▾ Finance');
    expect(cell.title).toBe('Collapse Finance members back into a count');
    cell.onClick();
    expect(onToggleMembers).toHaveBeenCalledWith(['x'], 1);
  });

  it('leaves member-deep placeholders inert', () => {
    const col = { isMemberCol: true, memberLevel: 0 };
    const cell = computeGroupingCell({ col, rowIdx: 1, span, onToggleCollapse: vi.fn(), onToggleMembers: vi.fn() });
    expect(cell.onClick).toBeUndefined();
    expect(cell.title).toBeUndefined();
  });

  it('falls back to (none) for empty values', () => {
    const cell = computeGroupingCell({ col: {}, rowIdx: 0, span: { value: '' }, onToggleCollapse: vi.fn() });
    expect(cell.label).toBe('(none)');
    expect(cell.title).toBe('Collapse (none) into one column');
  });
});

describe('isApCategoryBoundary', () => {
  const aps = [{ categoryName: 'A' }, { categoryName: 'A' }, { categoryName: 'B' }, {}];
  it('is a boundary at index 0, when the category changes, and treats missing as null', () => {
    expect(isApCategoryBoundary(aps, 0)).toBe(true);
    expect(isApCategoryBoundary(aps, 1)).toBe(false);
    expect(isApCategoryBoundary(aps, 2)).toBe(true);
    expect(isApCategoryBoundary(aps, 3)).toBe(true);
  });
});

describe('apLeftBorderClass', () => {
  it('picks indigo first, grey at a boundary, nothing inside a category', () => {
    expect(apLeftBorderClass(0, true)).toContain('indigo');
    expect(apLeftBorderClass(2, true)).toContain('gray');
    expect(apLeftBorderClass(2, false)).toBe('');
  });
});

describe('subject helpers', () => {
  it('builds a multi-line title with account annotation', () => {
    expect(subjectTitle({ displayName: 'Alice', jobTitle: 'Analyst', department: 'Finance' }))
      .toBe('Alice\nAnalyst\nFinance');
    expect(subjectTitle({ displayName: 'Bob', isAccountCol: true, accountType: 'AAD' }))
      .toBe('Bob (account · AAD)\n\n');
    expect(subjectTitle({ displayName: 'Cy', isAccountCol: true }))
      .toBe('Cy (account)\n\n');
  });

  it('appends the account type to an account label only', () => {
    expect(subjectLabel({ displayName: 'Alice' })).toBe('Alice');
    expect(subjectLabel({ displayName: 'Bob', isAccountCol: true, accountType: 'AAD' })).toBe('Bob · AAD');
    expect(subjectLabel({ displayName: 'Cy', isAccountCol: true })).toBe('Cy');
  });

  it('selects the identity glyph by loading/expanded state', () => {
    expect(identityGlyph(true, false)).toBe('⋯');
    expect(identityGlyph(false, true)).toBe('▾');
    expect(identityGlyph(false, false)).toBe('▸');
  });
});
