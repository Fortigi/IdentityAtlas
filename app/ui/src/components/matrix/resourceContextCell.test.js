import { describe, it, expect } from 'vitest';
import {
  MAX_VISIBLE_CONTEXTS, visibleContexts, buildResourceContextMap, contextsFor, contextNames,
} from './resourceContextCell';

const ctx = (id, displayName, contextType = 'Tag', variant = 'manual') =>
  ({ id, displayName, contextType, variant });

describe('visibleContexts', () => {
  it('shows all contexts with no +N when at or under the cap', () => {
    expect(visibleContexts([], false)).toEqual({ shown: [], hiddenCount: 0 });
    const one = [ctx('c1', 'Finance')];
    expect(visibleContexts(one, false)).toEqual({ shown: one, hiddenCount: 0 });
    const two = [ctx('c1', 'Finance'), ctx('c2', 'M365')];
    expect(visibleContexts(two, false)).toEqual({ shown: two, hiddenCount: 0 });
  });

  it(`truncates to the first ${MAX_VISIBLE_CONTEXTS} and counts the rest when collapsed`, () => {
    const three = [ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')];
    expect(visibleContexts(three, false)).toEqual({
      shown: [three[0], three[1]],
      hiddenCount: 1,
    });
    const five = [...three, ctx('c4', 'D'), ctx('c5', 'E')];
    expect(visibleContexts(five, false).hiddenCount).toBe(3);
  });

  it('shows everything when expanded', () => {
    const three = [ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')];
    expect(visibleContexts(three, true)).toEqual({ shown: three, hiddenCount: 0 });
  });

  it('tolerates non-array input', () => {
    expect(visibleContexts(null)).toEqual({ shown: [], hiddenCount: 0 });
    expect(visibleContexts(undefined)).toEqual({ shown: [], hiddenCount: 0 });
  });
});

describe('buildResourceContextMap', () => {
  it('keys by UPPERCASED resourceId (case-insensitive lookup, like groupTagMap)', () => {
    const map = buildResourceContextMap([
      { resourceId: 'abc-def', contexts: [ctx('c1', 'Finance')] },
      { resourceId: 'GHI', contexts: [] },
    ]);
    expect(map.get('ABC-DEF')).toEqual([ctx('c1', 'Finance')]);
    expect(map.get('GHI')).toEqual([]);
    expect(map.has('abc-def')).toBe(false);
  });

  it('skips entries without a resourceId and tolerates null input', () => {
    expect(buildResourceContextMap(null).size).toBe(0);
    expect(buildResourceContextMap([{ contexts: [] }, null]).size).toBe(0);
  });
});

describe('contextsFor', () => {
  it('looks up case-insensitively via the uppercase key', () => {
    const map = buildResourceContextMap([{ resourceId: 'abc', contexts: [ctx('c1', 'Finance')] }]);
    expect(contextsFor(map, 'abc')).toEqual([ctx('c1', 'Finance')]);
    expect(contextsFor(map, 'ABC')).toEqual([ctx('c1', 'Finance')]);
    expect(contextsFor(map, 'other')).toBeUndefined();
  });

  it('tolerates a missing map', () => {
    expect(contextsFor(undefined, 'abc')).toBeUndefined();
    expect(contextsFor(null, 'abc')).toBeUndefined();
  });
});

describe('contextNames', () => {
  it('joins every displayName, untruncated, for the Excel export', () => {
    expect(contextNames([ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')]))
      .toBe('Finance, M365, Cluster-A');
  });

  it('returns an empty string for missing contexts', () => {
    expect(contextNames(undefined)).toBe('');
    expect(contextNames([])).toBe('');
  });
});
