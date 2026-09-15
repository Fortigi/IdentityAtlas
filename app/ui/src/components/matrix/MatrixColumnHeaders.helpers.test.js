import { describe, it, expect, vi } from 'vitest';
import {
  spanState,
  computeGroupingCell,
  isApCategoryBoundary,
  apLeftBorderClass,
  subjectTitle,
  subjectLabel,
  identityGlyph,
  splitAccountColumns,
  subjectAccountCount,
  subjectLabelMaxHeight,
  ACCOUNT_ROW_H,
} from './MatrixColumnHeaders.helpers';

describe('splitAccountColumns', () => {
  // Columns as columnModel.buildColumns emits them: an expanded identity has no
  // column of its own — its accounts stand in for it and carry it on `parent`.
  const alice = { id: 'id1', displayName: 'Alice', memberType: 'Identity' };
  const aliceAad = { id: 'acc1', displayName: 'Alice AAD', isAccountCol: true, parentId: 'id1', parent: alice };
  const aliceSap = { id: 'acc2', displayName: 'Alice SAP', isAccountCol: true, parentId: 'id1', parent: alice };
  const bob = { id: 'id2', displayName: 'Bob', memberType: 'Identity' };
  const bobAad = { id: 'acc3', displayName: 'Bob AAD', isAccountCol: true, parentId: 'id2', parent: bob };
  const carl = { id: 'u5', displayName: 'Carl' };

  it('leaves a matrix with no expanded identity untouched', () => {
    const { namesCols, accountsByParent, hasAccountsRow } = splitAccountColumns([alice, carl]);
    expect(namesCols).toEqual([alice, carl]);
    expect(accountsByParent.size).toBe(0);
    expect(hasAccountsRow).toBe(false);
  });

  it('puts the identity back on the names row in its accounts\' place', () => {
    const { namesCols, accountsByParent, hasAccountsRow } =
      splitAccountColumns([aliceAad, aliceSap, carl]);
    // One names cell for Alice (it will span both accounts), then Carl — the
    // identity has no roll-up column of its own any more.
    expect(namesCols).toEqual([alice, carl]);
    expect(accountsByParent.get('id1')).toEqual([aliceAad, aliceSap]);
    expect(hasAccountsRow).toBe(true);
  });

  it('keeps the column order when several identities are expanded', () => {
    const { namesCols, accountsByParent } =
      splitAccountColumns([aliceAad, aliceSap, carl, bobAad]);
    expect(namesCols).toEqual([alice, carl, bob]);
    expect([...accountsByParent.keys()]).toEqual(['id1', 'id2']);
    expect(accountsByParent.get('id2')).toEqual([bobAad]);
  });

  it('keeps an account column with no parent on the names row', () => {
    // Its body column exists either way, so dropping it from the names row
    // would shift every cell to its right by one column.
    const orphan = { id: 'acc9', displayName: 'Ghost', isAccountCol: true, parentId: 'gone' };
    const { namesCols, accountsByParent, hasAccountsRow } = splitAccountColumns([carl, orphan]);
    expect(namesCols).toEqual([carl, orphan]);
    expect(accountsByParent.size).toBe(0);
    expect(hasAccountsRow).toBe(false);
  });

  it('survives a missing column list', () => {
    expect(splitAccountColumns(undefined)).toEqual({
      namesCols: [], accountsByParent: new Map(), hasAccountsRow: false,
    });
  });
});

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

  // #1212 follow-up: the badge is a bare number, so the tooltip is where it says
  // what the number counts.
  it('spells the linked-account count out in the title, pluralised, only when there is one', () => {
    const identity = { displayName: 'Alice', jobTitle: 'Analyst', department: 'Finance', memberType: 'Identity' };
    expect(subjectTitle({ ...identity, accountCount: 3 }))
      .toBe('Alice\nAnalyst\nFinance\n3 linked accounts');
    expect(subjectTitle({ ...identity, accountCount: 1 }))
      .toBe('Alice\nAnalyst\nFinance\n1 linked account');
    expect(subjectTitle({ ...identity, accountCount: 0 }))
      .toBe('Alice\nAnalyst\nFinance');
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

// #1212 follow-up: the badge tells the analyst which identities are worth
// expanding, so it is shown for identities with linked accounts and nobody else.
describe('subjectAccountCount', () => {
  const identity = (accountCount) => ({ displayName: 'Alice', memberType: 'Identity', accountCount });

  it('returns the count for an identity that has linked accounts', () => {
    expect(subjectAccountCount(identity(4))).toBe(4);
    expect(subjectAccountCount(identity(1))).toBe(1);
  });

  it('returns null for an identity with nothing to expand into', () => {
    expect(subjectAccountCount(identity(0))).toBeNull();
    expect(subjectAccountCount(identity(null))).toBeNull();
    expect(subjectAccountCount(identity(undefined))).toBeNull();
  });

  it('returns null for a plain account column, even one carrying a count', () => {
    // An account sub-column inherits fields from its parent identity; the badge
    // would then claim the account expands into 4 accounts of its own.
    expect(subjectAccountCount({ ...identity(4), isAccountCol: true })).toBeNull();
    expect(subjectAccountCount({ displayName: 'Bob', memberType: 'Principal', accountCount: 2 })).toBeNull();
    expect(subjectAccountCount(undefined)).toBeNull();
  });
});

describe('subjectLabelMaxHeight', () => {
  it('gives the badge its own room, so the name does not overflow the header', () => {
    const plain = subjectLabelMaxHeight({ isIdentity: false, hasCount: false });
    const identity = subjectLabelMaxHeight({ isIdentity: true, hasCount: false });
    const badged = subjectLabelMaxHeight({ isIdentity: true, hasCount: true });
    // Each thing stacked above the name (expand control, then count) shortens it.
    expect(identity).toBeLessThan(plain);
    expect(badged).toBeLessThan(identity);
    // The cell is 100px tall — every variant has to fit inside it.
    expect(plain).toBeLessThan(100);
  });

  it('sizes an accounts-row label to that row instead', () => {
    // The accounts row is shorter than the names row and carries no badge.
    expect(subjectLabelMaxHeight({ inAccountsRow: true, isIdentity: false, hasCount: false }))
      .toBe(ACCOUNT_ROW_H - 5);
  });
});
