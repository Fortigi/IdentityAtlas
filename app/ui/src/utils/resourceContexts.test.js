import { describe, it, expect } from 'vitest';
import { buildResourceContextMap, contextsFor, splitContexts, contextNames, CONTEXT_CHIP_LIMIT } from './resourceContexts';

const ctx = (id, displayName, contextType = 'Tag') => ({ id, displayName, contextType });

describe('buildResourceContextMap', () => {
  it('keys contexts by uppercase resource id', () => {
    const map = buildResourceContextMap([
      { resourceId: 'abc-123', contexts: [ctx('c1', 'Finance')] },
    ]);
    expect(map.get('ABC-123')).toEqual([ctx('c1', 'Finance')]);
  });

  it('skips entries without a resource id or with no contexts', () => {
    const map = buildResourceContextMap([
      { resourceId: null, contexts: [ctx('c1', 'X')] },
      { resourceId: 'r2', contexts: [] },
      { resourceId: 'r3' },
      { resourceId: 42, contexts: [ctx('c2', 'Y')] },
    ]);
    expect(map.size).toBe(0);
  });

  it('returns an empty map for a missing sidecar', () => {
    expect(buildResourceContextMap(undefined).size).toBe(0);
  });
});

describe('contextsFor', () => {
  const map = buildResourceContextMap([{ resourceId: 'ABC-123', contexts: [ctx('c1', 'Finance')] }]);

  it('looks a resource up case-insensitively', () => {
    expect(contextsFor(map, 'abc-123')).toEqual([ctx('c1', 'Finance')]);
    expect(contextsFor(map, 'ABC-123')).toEqual([ctx('c1', 'Finance')]);
  });

  it('always returns an array — unknown resource, missing map, missing id', () => {
    expect(contextsFor(map, 'nope')).toEqual([]);
    expect(contextsFor(undefined, 'abc-123')).toEqual([]);
    expect(contextsFor(map, null)).toEqual([]);
  });
});

describe('splitContexts', () => {
  it('shows the first two and counts the rest', () => {
    const all = [ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')];
    expect(splitContexts(all)).toEqual({ shown: all.slice(0, 2), hiddenCount: 1 });
  });

  it('hides nothing when the resource is in exactly the limit', () => {
    const all = [ctx('c1', 'Finance'), ctx('c2', 'M365')];
    expect(splitContexts(all)).toEqual({ shown: all, hiddenCount: 0 });
    expect(CONTEXT_CHIP_LIMIT).toBe(2);
  });

  it('handles an empty / missing list and a custom limit', () => {
    expect(splitContexts([])).toEqual({ shown: [], hiddenCount: 0 });
    expect(splitContexts(undefined)).toEqual({ shown: [], hiddenCount: 0 });
    expect(splitContexts([ctx('c1', 'A'), ctx('c2', 'B')], 1)).toEqual({ shown: [ctx('c1', 'A')], hiddenCount: 1 });
  });
});

describe('contextNames', () => {
  it('comma-joins every display name (untruncated) for the export', () => {
    expect(contextNames([ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')]))
      .toBe('Finance, M365, Cluster-A');
  });

  it('drops nameless entries and tolerates a missing list', () => {
    expect(contextNames([ctx('c1', 'Finance'), { id: 'c2' }])).toBe('Finance');
    expect(contextNames(null)).toBe('');
  });
});
