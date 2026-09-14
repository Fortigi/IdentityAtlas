import { describe, it, expect } from 'vitest';
import { stripCountsLabel } from './MatrixFilterSummary.helpers';

describe('stripCountsLabel', () => {
  it('renders nothing before the counts are known', () => {
    expect(stripCountsLabel(null, 'principal')).toBe('');
    expect(stripCountsLabel(undefined, 'identity')).toBe('');
  });

  it('spells the three live numbers, counting users for account matrices', () => {
    // Three different numbers, so a label that swapped two of them fails.
    expect(stripCountsLabel({ subjectCount: 45, resourceCount: 39, assignmentCount: 127 }, 'principal'))
      .toBe('45 users × 39 resources · 127 cells');
  });

  it('counts identities as identities', () => {
    expect(stripCountsLabel({ subjectCount: 12, resourceCount: 3, assignmentCount: 30 }, 'identity'))
      .toBe('12 identities × 3 resources · 30 cells');
  });

  it('uses the singular for exactly one — and only for one', () => {
    expect(stripCountsLabel({ subjectCount: 1, resourceCount: 1, assignmentCount: 1 }, 'principal'))
      .toBe('1 user × 1 resource · 1 cell');
    expect(stripCountsLabel({ subjectCount: 1, resourceCount: 0, assignmentCount: 0 }, 'identity'))
      .toBe('1 identity × 0 resources · 0 cells');
  });

  it('groups thousands and treats missing counts as zero', () => {
    expect(stripCountsLabel({ subjectCount: 12500, resourceCount: 2, assignmentCount: 1001 }, 'principal'))
      .toBe(`${(12500).toLocaleString()} users × 2 resources · ${(1001).toLocaleString()} cells`);
    expect(stripCountsLabel({}, 'principal')).toBe('0 users × 0 resources · 0 cells');
  });
});
