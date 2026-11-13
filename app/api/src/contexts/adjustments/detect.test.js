import { describe, it, expect } from 'vitest';
import { overlapThreshold, pickSuccessor, pickRenamedValue } from './detect.js';

describe('recognising a re-keyed unit', () => {
  it('needs at least half of the members it had', () => {
    expect(overlapThreshold(1)).toBe(1);
    expect(overlapThreshold(5)).toBe(3);
    expect(overlapThreshold(10)).toBe(5);
    expect(pickSuccessor(10, [{ contextId: 'a', count: 4 }])).toBeNull();
    expect(pickSuccessor(10, [{ contextId: 'a', count: 5 }])).toEqual({ contextId: 'a', count: 5 });
  });

  it('picks the unit holding most of them, and refuses a tie', () => {
    expect(pickSuccessor(10, [{ contextId: 'a', count: 6 }, { contextId: 'b', count: 9 }])).toEqual({ contextId: 'b', count: 9 });
    expect(pickSuccessor(10, [{ contextId: 'a', count: 6 }, { contextId: 'b', count: 6 }])).toBeNull();
    expect(pickSuccessor(0, [{ contextId: 'a', count: 6 }])).toBeNull();
    expect(pickSuccessor(4, [])).toBeNull();
  });

  it('proposes the new value most of the split-off people now share, never the old or an empty one', () => {
    const values = [{ value: 'Facilities', count: 1 }, { value: 'Facility Services', count: 3 }, { value: null, count: 4 }];
    expect(pickRenamedValue(4, values, 'Facilities')).toEqual({ value: 'Facility Services', count: 3 });
    expect(pickRenamedValue(8, values, 'Facilities')).toBeNull();
    expect(pickRenamedValue(4, [{ value: 'Facilities', count: 4 }], 'Facilities')).toBeNull();
  });
});
