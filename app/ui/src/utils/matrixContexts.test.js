import { describe, it, expect } from 'vitest';
import {
  CONTEXTS_SHOWN_LIMIT,
  buildResourceContextsMap,
  contextsForGroup,
  splitContextsForDisplay,
  contextNamesJoined,
} from './matrixContexts.js';

const ctx = (name, type = 'Tag', variant = 'manual') =>
  ({ id: name.toLowerCase(), displayName: name, contextType: type, variant });

describe('buildResourceContextsMap', () => {
  it('keys the sidecar by uppercase resource id', () => {
    const map = buildResourceContextsMap([
      { resourceId: 'abc-1', contexts: [ctx('Finance')] },
      { resourceId: 'DEF-2', contexts: [ctx('M365')] },
    ]);
    expect(map.get('ABC-1')).toEqual([ctx('Finance')]);
    expect(map.get('DEF-2')).toEqual([ctx('M365')]);
    expect(map.size).toBe(2);
  });

  it('tolerates null input and skips malformed entries', () => {
    expect(buildResourceContextsMap(null).size).toBe(0);
    const map = buildResourceContextsMap([
      { resourceId: null, contexts: [ctx('X')] },
      { resourceId: 'ok', contexts: null },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('OK')).toEqual([]);
  });
});

describe('contextsForGroup', () => {
  const map = buildResourceContextsMap([{ resourceId: 'real-id', contexts: [ctx('Finance')] }]);

  it('looks up by group id (case-insensitive)', () => {
    expect(contextsForGroup(map, { id: 'REAL-ID' })).toEqual([ctx('Finance')]);
  });

  it('prefers realGroupId for synthetic (owner/nested) rows', () => {
    expect(contextsForGroup(map, { id: 'parent__nested__real-id', realGroupId: 'real-id' }))
      .toEqual([ctx('Finance')]);
  });

  it('returns [] for unknown resources and missing inputs', () => {
    expect(contextsForGroup(map, { id: 'nope' })).toEqual([]);
    expect(contextsForGroup(null, { id: 'real-id' })).toEqual([]);
    expect(contextsForGroup(map, null)).toEqual([]);
  });
});

describe('splitContextsForDisplay', () => {
  it('shows the first 2 and hides the rest (spec fixture: Finance, M365 +1)', () => {
    const contexts = [ctx('Finance'), ctx('M365', 'group-category'), ctx('Cluster-A', 'resource-cluster')];
    const { shown, hidden } = splitContextsForDisplay(contexts);
    expect(shown.map(c => c.displayName)).toEqual(['Finance', 'M365']);
    expect(hidden.map(c => c.displayName)).toEqual(['Cluster-A']);
  });

  it('shows both with no +N when exactly at the limit', () => {
    const { shown, hidden } = splitContextsForDisplay([ctx('A'), ctx('B')]);
    expect(shown).toHaveLength(CONTEXTS_SHOWN_LIMIT);
    expect(hidden).toHaveLength(0);
  });

  it('handles empty and non-array input', () => {
    expect(splitContextsForDisplay([])).toEqual({ shown: [], hidden: [] });
    expect(splitContextsForDisplay(undefined)).toEqual({ shown: [], hidden: [] });
  });

  it('respects a custom limit', () => {
    const { shown, hidden } = splitContextsForDisplay([ctx('A'), ctx('B'), ctx('C')], 1);
    expect(shown.map(c => c.displayName)).toEqual(['A']);
    expect(hidden.map(c => c.displayName)).toEqual(['B', 'C']);
  });
});

describe('contextNamesJoined', () => {
  it('joins all names untruncated for the Excel export', () => {
    expect(contextNamesJoined([ctx('Finance'), ctx('M365'), ctx('Cluster-A')]))
      .toBe('Finance, M365, Cluster-A');
  });
  it('returns an empty string for no contexts', () => {
    expect(contextNamesJoined([])).toBe('');
    expect(contextNamesJoined(null)).toBe('');
  });
});
