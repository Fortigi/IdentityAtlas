import { describe, it, expect } from 'vitest';
import {
  MAX_VISIBLE_CONTEXTS, buildResourceContextsMap, contextsForGroup,
  splitContexts, contextNames,
} from './matrixContexts.js';

const ctx = (name, over = {}) => ({ id: name.toLowerCase(), displayName: name, contextType: 'tag', ...over });

describe('buildResourceContextsMap', () => {
  it('keys the sidecar by uppercase resource id', () => {
    const map = buildResourceContextsMap([
      { resourceId: 'res-1', contexts: [ctx('Finance')] },
      { resourceId: 'RES-2', contexts: [ctx('M365')] },
    ]);
    expect(map.get('RES-1')).toEqual([ctx('Finance')]);
    expect(map.get('RES-2')).toEqual([ctx('M365')]);
  });

  it('tolerates a missing/empty sidecar and malformed entries', () => {
    expect(buildResourceContextsMap(null).size).toBe(0);
    expect(buildResourceContextsMap(undefined).size).toBe(0);
    const map = buildResourceContextsMap([{ resourceId: null }, { resourceId: 'r1' }]);
    expect(map.get('R1')).toEqual([]);
  });
});

describe('contextsForGroup', () => {
  const map = buildResourceContextsMap([{ resourceId: 'res-1', contexts: [ctx('Finance')] }]);

  it('resolves by group id, case-insensitively', () => {
    expect(contextsForGroup(map, { id: 'RES-1' })).toEqual([ctx('Finance')]);
  });

  it('resolves synthetic rows through realGroupId', () => {
    expect(contextsForGroup(map, { id: 'res-1__owner', realGroupId: 'res-1' })).toEqual([ctx('Finance')]);
  });

  it('returns [] for unknown resources or missing inputs', () => {
    expect(contextsForGroup(map, { id: 'nope' })).toEqual([]);
    expect(contextsForGroup(null, { id: 'res-1' })).toEqual([]);
    expect(contextsForGroup(map, null)).toEqual([]);
  });
});

describe('splitContexts', () => {
  const three = [ctx('A'), ctx('B'), ctx('C')];

  it('shows the first two with the rest counted when collapsed', () => {
    const { shown, hiddenCount } = splitContexts(three, false);
    expect(shown.map(c => c.displayName)).toEqual(['A', 'B']);
    expect(hiddenCount).toBe(1);
    expect(MAX_VISIBLE_CONTEXTS).toBe(2);
  });

  it('shows everything when expanded', () => {
    const { shown, hiddenCount } = splitContexts(three, true);
    expect(shown).toHaveLength(3);
    expect(hiddenCount).toBe(0);
  });

  it('shows all with no counter at or under the cap', () => {
    expect(splitContexts([ctx('A'), ctx('B')], false)).toEqual({ shown: [ctx('A'), ctx('B')], hiddenCount: 0 });
    expect(splitContexts([], false)).toEqual({ shown: [], hiddenCount: 0 });
    expect(splitContexts(undefined, false)).toEqual({ shown: [], hiddenCount: 0 });
  });
});

describe('contextNames', () => {
  it('joins the full, untruncated list for the export', () => {
    expect(contextNames([ctx('Finance'), ctx('M365'), ctx('Cluster A')])).toBe('Finance, M365, Cluster A');
    expect(contextNames([])).toBe('');
    expect(contextNames(undefined)).toBe('');
  });
});
