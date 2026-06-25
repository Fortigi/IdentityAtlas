// Unit tests for the no-duplicate-dark-color rule's matching logic.
//
// Exercises findDuplicateProps directly (no RuleTester) so the test is robust
// and fast: it pins that two plain dark: color utilities for the same property
// are flagged, while the correct `dark:` + `dark:hover:` pairing is not.
import { describe, it, expect } from 'vitest';
import { findDuplicateProps } from './no-duplicate-dark-color.js';

describe('findDuplicateProps', () => {
  it('flags the doubled dark:text (C1) pattern', () => {
    const dupes = findDuplicateProps('text-gray-500 dark:text-gray-400 dark:text-gray-500');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].prop).toBe('text');
  });

  it('flags a missing-hover dark:text pair (M6: hover:text-X dark:text-Y)', () => {
    expect(findDuplicateProps('dark:text-gray-400 hover:text-gray-700 dark:text-gray-300')).toHaveLength(1);
  });

  it('does NOT flag the correct dark + dark:hover pairing', () => {
    expect(findDuplicateProps('dark:text-gray-400 dark:hover:text-gray-300')).toHaveLength(0);
  });

  it('does NOT flag the post-codemod class string', () => {
    expect(findDuplicateProps('text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700')).toHaveLength(0);
  });

  it('does NOT flag distinct dark color properties (text vs bg vs border)', () => {
    expect(findDuplicateProps('bg-white dark:bg-gray-800 dark:border-gray-700 dark:text-white')).toHaveLength(0);
  });

  it('flags a doubled dark:bg color and reports the offending tokens', () => {
    const dupes = findDuplicateProps('dark:bg-gray-700 dark:bg-gray-800');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].prop).toBe('bg');
    expect(dupes[0].second).toBe('dark:bg-gray-800');
  });

  it('ignores non-color dark utilities (e.g. sizing/spacing)', () => {
    // dark:text-sm is not a color; dark:p-2 is spacing — neither should count.
    expect(findDuplicateProps('dark:text-sm dark:text-gray-400')).toHaveLength(0);
  });

  it('flags the M6 red-variant missing-hover pattern', () => {
    // text-red-600 dark:text-red-400 hover:text-red-800 dark:text-red-300
    expect(findDuplicateProps('text-red-600 dark:text-red-400 hover:text-red-800 dark:text-red-300')).toHaveLength(1);
  });

  it('does NOT flag the codemod output (base dark + dark:hover variant)', () => {
    // This is the shape the M6 fix produces — must stay clean once the rule is an error.
    expect(findDuplicateProps('text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300')).toHaveLength(0);
    expect(findDuplicateProps('text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400')).toHaveLength(0);
  });
});
