import { describe, it, expect } from 'vitest';
import { SUGGEST_MIN_SCORE, checkTransition, classifyCandidates } from './resolution.js';

const william = { id: 'w1', score: 0.81, inScope: false };
const peterA = { id: 'p1', score: 1, inScope: false };
const peterB = { id: 'p2', score: 1, inScope: false };

describe('classifyCandidates — what the search alone may say', () => {
  it('a missing name is not_found', () => {
    expect(classifyCandidates([])).toEqual({ state: 'not_found', entityId: null, score: null, reason: 'no-candidates' });
    expect(classifyCandidates(undefined).state).toBe('not_found');
  });

  it('one strong candidate is SUGGESTED — not confirmed', () => {
    expect(classifyCandidates([william])).toEqual({ state: 'suggested', entityId: 'w1', score: 0.81, reason: 'single-candidate' });
  });

  it('one candidate exactly at the threshold is suggested; just under it stays unresolved', () => {
    expect(classifyCandidates([{ id: 'x', score: SUGGEST_MIN_SCORE, inScope: false }]).state).toBe('suggested');
    expect(classifyCandidates([{ id: 'x', score: SUGGEST_MIN_SCORE - 0.01, inScope: false }]))
      .toEqual({ state: 'unresolved', entityId: null, score: null, reason: 'weak-match' });
  });

  it('two Peters with perfect scores stay ambiguous — a score never breaks a homonym tie', () => {
    expect(classifyCandidates([peterA, peterB])).toEqual({ state: 'unresolved', entityId: null, score: null, reason: 'ambiguous' });
  });

  it('even when one Peter scores higher than the other', () => {
    expect(classifyCandidates([{ ...peterA, score: 1 }, { ...peterB, score: 0.62 }]).state).toBe('unresolved');
  });

  it('context support may suggest the only Peter in the team — the one in scope, not the first', () => {
    const r = classifyCandidates([peterA, { ...peterB, inScope: true }]);
    expect(r).toEqual({ state: 'suggested', entityId: 'p2', score: 1, reason: 'only-candidate-in-scope' });
  });

  it('two Peters both in the team stay ambiguous', () => {
    expect(classifyCandidates([{ ...peterA, inScope: true }, { ...peterB, inScope: true }]).reason).toBe('ambiguous');
  });

  it('a weak in-scope candidate is not suggested over a homonym', () => {
    expect(classifyCandidates([{ ...peterA, inScope: true, score: 0.4 }, peterB]).state).toBe('unresolved');
  });
});

describe('checkTransition — who may set what', () => {
  it('a detector may suggest, but never confirm, reject or defer', () => {
    expect(checkTransition(null, { state: 'suggested', origin: 'detector', entityId: 'w1' })).toBeNull();
    expect(checkTransition('suggested', { state: 'confirmed', origin: 'detector', entityId: 'w1' })).toMatch(/Only an analyst can set "confirmed"/);
    expect(checkTransition(null, { state: 'rejected', origin: 'detector', entityId: 'w1' })).toMatch(/Only an analyst/);
    expect(checkTransition(null, { state: 'deferred', origin: 'detector' })).toMatch(/Only an analyst/);
  });

  it('an analyst confirms a suggestion', () => {
    expect(checkTransition('suggested', { state: 'confirmed', origin: 'analyst', entityId: 'w1' })).toBeNull();
  });

  it('states that name an entity need one; states that do not must not carry one', () => {
    expect(checkTransition(null, { state: 'confirmed', origin: 'analyst' })).toBe('"confirmed" needs the entityId it is about');
    expect(checkTransition(null, { state: 'not_found', origin: 'analyst', entityId: 'x' })).toBe('"not_found" must not name an entity');
    expect(checkTransition(null, { state: 'deferred', origin: 'analyst', entityId: '' })).toBeNull();
  });

  it('a confirmed link can be withdrawn or deferred, but not handed back to the machine', () => {
    expect(checkTransition('confirmed', { state: 'rejected', origin: 'analyst', entityId: 'w1' })).toBeNull();
    expect(checkTransition('confirmed', { state: 'deferred', origin: 'analyst' })).toBeNull();
    expect(checkTransition('confirmed', { state: 'suggested', origin: 'detector', entityId: 'w1' })).toBe('A mention that is "confirmed" cannot become "suggested"');
    expect(checkTransition('confirmed', { state: 'confirmed', origin: 'analyst', entityId: 'w2' })).toMatch(/cannot become "confirmed"/);
  });

  it('rejecting a second Peter after the first is allowed (choose another)', () => {
    expect(checkTransition('rejected', { state: 'rejected', origin: 'analyst', entityId: 'p2' })).toBeNull();
    expect(checkTransition('rejected', { state: 'confirmed', origin: 'analyst', entityId: 'p2' })).toBeNull();
  });

  it('not_found cannot be rejected (there is nothing to reject) but can be linked by hand', () => {
    expect(checkTransition('not_found', { state: 'rejected', origin: 'analyst', entityId: 'x' })).toMatch(/cannot become "rejected"/);
    expect(checkTransition('not_found', { state: 'confirmed', origin: 'analyst', entityId: 'x' })).toBeNull();
  });

  it('refuses unknown states, origins and current states', () => {
    expect(checkTransition(null, { state: 'accepted', origin: 'analyst' })).toMatch(/^state must be one of/);
    expect(checkTransition(null, { state: 'deferred', origin: 'model' })).toBe('origin must be "analyst" or "detector"');
    expect(checkTransition('weird', { state: 'deferred', origin: 'analyst' })).toBe('Unknown current state "weird"');
  });
});
