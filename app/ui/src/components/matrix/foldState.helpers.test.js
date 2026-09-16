import { describe, it, expect } from 'vitest';
import { collapseKey } from './columnModel.js';
import { toggleCollapsedGroups, columnFoldState } from './foldState.js';

const sub = (sortKeys) => ({ sortKeys });

describe('toggleCollapsedGroups', () => {
  it('folds an unfolded group by adding its collapse key', () => {
    const users = [sub(['Eng']), sub(['Sales'])];
    const next = toggleCollapsedGroups(new Set(), users, ['Eng'], 0, 1);
    expect([...next]).toEqual([collapseKey(['Eng'], 0)]);
  });

  it('unfolding the deepest level simply removes the key', () => {
    const key = collapseKey(['Eng'], 0);
    const next = toggleCollapsedGroups(new Set([key]), [sub(['Eng'])], ['Eng'], 0, 1);
    expect(next.size).toBe(0);
  });

  it('unfolding a non-deepest level drops to the next level (children stay folded)', () => {
    const users = [sub(['Eng', 'SWE']), sub(['Eng', 'Mgr'])];
    const key0 = collapseKey(['Eng', 'SWE'], 0);
    const next = toggleCollapsedGroups(new Set([key0]), users, ['Eng', 'SWE'], 0, 2);
    expect(next.has(key0)).toBe(false);
    expect(next.has(collapseKey(['Eng', 'SWE'], 1))).toBe(true);
    expect(next.has(collapseKey(['Eng', 'Mgr'], 1))).toBe(true);
  });

  it('folding a group clears any deeper sub-folds it now hides', () => {
    const users = [sub(['Eng', 'SWE'])];
    const deeper = collapseKey(['Eng', 'SWE'], 1);
    const next = toggleCollapsedGroups(new Set([deeper]), users, ['Eng', 'SWE'], 0, 2);
    expect(next.has(collapseKey(['Eng', 'SWE'], 0))).toBe(true);
    expect(next.has(deeper)).toBe(false);
  });
});

describe('columnFoldState', () => {
  const top = new Set(['Eng', 'Sales']);

  it('is none when nothing is folded', () => {
    expect(columnFoldState(top, new Set())).toBe('none');
  });

  // One of two groups folded: a check that looked only at size > 0 would call
  // this 'all', and one that looked for the first key only would too.
  it('is some when only one of the top-level groups is folded', () => {
    expect(columnFoldState(top, new Set(['Sales']))).toBe('some');
    expect(columnFoldState(top, new Set(['Eng']))).toBe('some');
  });

  // Drilling into a folded group replaces its key with deeper ones: columns are
  // still folded, but not every top-level group is.
  it('is some when only deeper levels are folded', () => {
    expect(columnFoldState(top, new Set(['Eng / SWE']))).toBe('some');
  });

  it('is all when every top-level group is folded, extra deeper keys or not', () => {
    expect(columnFoldState(top, new Set(['Eng', 'Sales']))).toBe('all');
    expect(columnFoldState(top, new Set(['Eng', 'Sales', 'x']))).toBe('all');
  });
});
