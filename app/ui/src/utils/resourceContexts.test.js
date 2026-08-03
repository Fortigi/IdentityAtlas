import { describe, it, expect } from 'vitest';
import {
  CONTEXT_CHIP_LIMIT,
  buildResourceContextMap,
  contextsForResource,
  splitContextChips,
  formatContextsForExport,
} from './resourceContexts.js';

const ctx = (displayName, contextType = 'Tag') => ({ id: displayName, displayName, contextType, variant: 'manual' });

describe('buildResourceContextMap', () => {
  it('keys the sidecar by upper-cased resource id', () => {
    const map = buildResourceContextMap([{ resourceId: 'abc-1', contexts: [ctx('Finance')] }]);
    expect(map.get('ABC-1')).toEqual([ctx('Finance')]);
  });

  it('tolerates a missing sidecar, blank ids and a missing contexts array', () => {
    expect(buildResourceContextMap().size).toBe(0);
    expect(buildResourceContextMap([null, { contexts: [ctx('X')] }]).size).toBe(0);
    expect(buildResourceContextMap([{ resourceId: 'r1' }]).get('R1')).toEqual([]);
  });
});

describe('contextsForResource', () => {
  const map = buildResourceContextMap([{ resourceId: 'r1', contexts: [ctx('Finance')] }]);

  it('looks up case-insensitively', () => {
    expect(contextsForResource(map, 'R1')).toEqual([ctx('Finance')]);
    expect(contextsForResource(map, 'r1')).toEqual([ctx('Finance')]);
  });

  it('returns an empty array for an unknown resource, a null map or a null id', () => {
    expect(contextsForResource(map, 'nope')).toEqual([]);
    expect(contextsForResource(null, 'r1')).toEqual([]);
    expect(contextsForResource(map, null)).toEqual([]);
  });
});

describe('splitContextChips', () => {
  const three = [ctx('Finance'), ctx('M365'), ctx('Cluster-A')];

  it('shows the first two and counts the rest', () => {
    expect(CONTEXT_CHIP_LIMIT).toBe(2);
    const { shown, hiddenCount } = splitContextChips(three);
    expect(shown.map(c => c.displayName)).toEqual(['Finance', 'M365']);
    expect(hiddenCount).toBe(1);
  });

  it('shows everything with no expander when the row is at or under the limit', () => {
    expect(splitContextChips(three.slice(0, 2))).toEqual({ shown: three.slice(0, 2), hiddenCount: 0 });
    expect(splitContextChips([])).toEqual({ shown: [], hiddenCount: 0 });
    expect(splitContextChips(undefined)).toEqual({ shown: [], hiddenCount: 0 });
  });

  it('shows everything once expanded', () => {
    expect(splitContextChips(three, true)).toEqual({ shown: three, hiddenCount: 0 });
  });

  it('honours a custom limit', () => {
    expect(splitContextChips(three, false, 1)).toEqual({ shown: [three[0]], hiddenCount: 2 });
  });
});

describe('formatContextsForExport', () => {
  it('comma-joins every context name, untruncated', () => {
    expect(formatContextsForExport([ctx('Finance'), ctx('M365'), ctx('Cluster-A')]))
      .toBe('Finance, M365, Cluster-A');
  });

  it('drops nameless entries and handles an empty list', () => {
    expect(formatContextsForExport([{ id: 'x' }, ctx('Finance')])).toBe('Finance');
    expect(formatContextsForExport([])).toBe('');
    expect(formatContextsForExport()).toBe('');
  });
});
