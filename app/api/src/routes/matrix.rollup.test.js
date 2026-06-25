// normaliseSortAttributes stays in routes/matrix.js. The roll-up SQL builder
// tests moved to ../matrix/rollupBuilders.test.js when those builders were
// extracted into their own module (Q1 split).
import { describe, it, expect } from 'vitest';
import { normaliseSortAttributes } from './matrix.js';

describe('normaliseSortAttributes', () => {
  it('defaults to [department asc] when missing or empty', () => {
    expect(normaliseSortAttributes(undefined)).toEqual([{ attribute: 'department', dir: 'asc' }]);
    expect(normaliseSortAttributes([])).toEqual([{ attribute: 'department', dir: 'asc' }]);
    expect(normaliseSortAttributes('nope')).toEqual([{ attribute: 'department', dir: 'asc' }]);
  });

  it('keeps valid entries and normalises dir', () => {
    expect(normaliseSortAttributes([
      { attribute: 'department', dir: 'desc' },
      { attribute: 'jobTitle' },
    ])).toEqual([
      { attribute: 'department', dir: 'desc' },
      { attribute: 'jobTitle', dir: 'asc' },
    ]);
  });

  it('caps at 6 attributes', () => {
    const out = normaliseSortAttributes([
      { attribute: 'a' }, { attribute: 'b' }, { attribute: 'c' },
      { attribute: 'd' }, { attribute: 'e' }, { attribute: 'f' }, { attribute: 'g' },
    ]);
    expect(out).toHaveLength(6);
    expect(out.map(a => a.attribute)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('drops entries with no attribute string', () => {
    expect(normaliseSortAttributes([{ dir: 'asc' }, { attribute: '' }, { attribute: 'x' }]))
      .toEqual([{ attribute: 'x', dir: 'asc' }]);
  });
});
