import { describe, it, expect } from 'vitest';
import { collapseKey } from './columnModel.js';
import { toggleCollapsedGroups } from './foldState.js';

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
