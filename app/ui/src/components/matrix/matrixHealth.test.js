// The wording behind the broken-matrix marker. Pure; no rendering.
//
// Singular and plural are tested separately throughout: this copy has four
// words that inflect ("context/contexts", "exists/exist", "that/those",
// "condition was/conditions were"), and a one-element case is the only input
// that separates a correct sentence from a plausible-looking wrong one.

import { describe, it, expect } from 'vitest';
import {
  missingContextCount, isMatrixBroken, brokenMatrixTitle, brokenMatrixExplanation,
} from './matrixHealth';

describe('missingContextCount / isMatrixBroken', () => {
  it('counts the contexts a matrix names that are gone', () => {
    expect(missingContextCount({ missingContextIds: ['a', 'b'] })).toBe(2);
    expect(isMatrixBroken({ missingContextIds: ['a'] })).toBe(true);
  });

  it('reads an empty list as healthy', () => {
    expect(missingContextCount({ missingContextIds: [] })).toBe(0);
    expect(isMatrixBroken({ missingContextIds: [] })).toBe(false);
  });

  it('never marks a row broken just because the field is absent', () => {
    // An older API, or a row from a surface that does not report health: silence
    // is not a fault, and marking it would cry wolf on every matrix.
    expect(isMatrixBroken({ id: 'sf-1', name: 'Sales' })).toBe(false);
    expect(isMatrixBroken(undefined)).toBe(false);
    expect(missingContextCount({ missingContextIds: 'two' })).toBe(0);
  });
});

describe('brokenMatrixTitle', () => {
  it('reads as a singular sentence for one missing context', () => {
    expect(brokenMatrixTitle({ missingContextIds: ['a'] }))
      .toBe('Refers to 1 context that no longer exists. Those conditions are ignored, so this matrix no longer filters the way it was saved.');
  });

  it('reads as a plural sentence for more than one', () => {
    expect(brokenMatrixTitle({ missingContextIds: ['a', 'b'] }))
      .toBe('Refers to 2 contexts that no longer exist. Those conditions are ignored, so this matrix no longer filters the way it was saved.');
  });

  it('says nothing about a healthy matrix', () => {
    expect(brokenMatrixTitle({ missingContextIds: [] })).toBe('');
  });
});

describe('brokenMatrixExplanation', () => {
  it('explains one missing context in the singular throughout', () => {
    expect(brokenMatrixExplanation(['a']))
      .toBe('This matrix refers to 1 context that no longer exists, so that condition was ignored. Adjust the matrix to pick a context that still exists.');
  });

  it('explains several in the plural throughout', () => {
    expect(brokenMatrixExplanation(['a', 'b']))
      .toBe('This matrix refers to 2 contexts that no longer exist, so those conditions were ignored. Adjust the matrix to pick contexts that still exist.');
  });

  it('offers no explanation when nothing is missing, so the caller shows its plain empty state', () => {
    expect(brokenMatrixExplanation([])).toBe('');
    expect(brokenMatrixExplanation(undefined)).toBe('');
  });
});
