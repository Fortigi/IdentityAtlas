import { describe, it, expect } from 'vitest';
import { checkReview, reviewState } from './review.js';

const fresh = { proposalVersion: 2, latestVersion: 2, currentAction: null };

describe('checkReview — the review gate', () => {
  it('lets an analyst approve the version they read', () => {
    expect(checkReview(fresh, { action: 'approve', targetVersion: 2 })).toBeNull();
  });

  it('refuses a review that names a different version than the proposal is about', () => {
    expect(checkReview(fresh, { action: 'approve', targetVersion: 1 })).toBe('This proposal is about version 2 of the statement, not version 1');
    expect(checkReview(fresh, { action: 'defer', targetVersion: 3 })).toMatch(/not version 3/);
  });

  it('refuses to approve a proposal whose statement was revised since', () => {
    const revised = { ...fresh, latestVersion: 3 };
    expect(checkReview(revised, { action: 'approve', targetVersion: 2 })).toBe('The statement was revised to version 3 after this proposal was made; propose that version instead');
  });

  it('still lets that stale proposal be rejected or deferred', () => {
    const revised = { ...fresh, latestVersion: 3 };
    expect(checkReview(revised, { action: 'reject', targetVersion: 2 })).toBeNull();
    expect(checkReview(revised, { action: 'defer', targetVersion: 2 })).toBeNull();
  });

  it('treats approve and reject as final, defer as not', () => {
    expect(checkReview({ ...fresh, currentAction: 'approve' }, { action: 'reject', targetVersion: 2 })).toMatch(/already approved/);
    expect(checkReview({ ...fresh, currentAction: 'reject' }, { action: 'approve', targetVersion: 2 })).toMatch(/already rejected/);
    expect(checkReview({ ...fresh, currentAction: 'defer' }, { action: 'approve', targetVersion: 2 })).toBeNull();
  });
});

describe('reviewState', () => {
  it('maps the latest decision to the state shown, and no decision to proposed', () => {
    expect(['approve', 'reject', 'defer', null, undefined].map(reviewState)).toEqual(['approved', 'rejected', 'deferred', 'proposed', 'proposed']);
  });
});
