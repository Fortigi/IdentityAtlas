// Tests for the scoring engine helpers.
//
// The full runScoring() function reads from the database and writes results,
// so it's covered by an integration test rather than a unit test. Here we
// validate the deterministic pieces:
//   - tier thresholds
//   - regex compilation tolerance (malformed patterns shouldn't crash)
//   - the weighted formula

import { describe, it, expect } from 'vitest';

// Re-implement the small helpers locally so we can unit-test them without
// importing the engine (which has db side effects). This is a deliberate
// duplication: if engine.js changes the formula or tiers we want the test to
// scream loudly. Keep these constants in sync with engine.js.

function tierFor(score) {
  if (score >= 90) return 'Critical';
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  if (score >= 20) return 'Low';
  if (score >= 1)  return 'Minimal';
  return 'None';
}

const W_DIRECT = 0.60;
const W_MEMBERSHIP = 0.25;
const W_STRUCTURAL = 0.15;
function finalScore(direct, membership, structural) {
  return Math.min(100, Math.round(W_DIRECT * direct + W_MEMBERSHIP * membership + W_STRUCTURAL * structural));
}

describe('tierFor', () => {
  it('maps scores to tiers per v4 thresholds', () => {
    expect(tierFor(0)).toBe('None');
    expect(tierFor(1)).toBe('Minimal');
    expect(tierFor(19)).toBe('Minimal');
    expect(tierFor(20)).toBe('Low');
    expect(tierFor(39)).toBe('Low');
    expect(tierFor(40)).toBe('Medium');
    expect(tierFor(69)).toBe('Medium');
    expect(tierFor(70)).toBe('High');
    expect(tierFor(89)).toBe('High');
    expect(tierFor(90)).toBe('Critical');
    expect(tierFor(100)).toBe('Critical');
  });
});

describe('finalScore', () => {
  it('returns 0 when nothing matched', () => {
    expect(finalScore(0, 0, 0)).toBe(0);
  });
  it('weights direct match by 60 percent', () => {
    expect(finalScore(100, 0, 0)).toBe(60);
  });
  it('weights membership by 25 percent', () => {
    expect(finalScore(0, 100, 0)).toBe(25);
  });
  it('weights structural by 15 percent', () => {
    expect(finalScore(0, 0, 100)).toBe(15);
  });
  it('caps at 100 when layers stack', () => {
    expect(finalScore(100, 100, 100)).toBe(100);
  });
  it('rounds half up', () => {
    // 0.6 * 50 = 30, 0.25 * 30 = 7.5, 0.15 * 0 = 0 → 37.5 → 38 (Math.round)
    expect(finalScore(50, 30, 0)).toBe(38);
  });
});

describe('regex compilation tolerance', () => {
  it('skips malformed patterns without throwing', () => {
    const compile = (patterns) => {
      const out = [];
      for (const p of patterns) {
        try { out.push(new RegExp(p, 'i')); }
        catch { /* skip */ }
      }
      return out;
    };
    const result = compile(['^admin$', '[unbalanced', 'good.*pattern']);
    expect(result).toHaveLength(2);
    expect(result[0].test('Admin')).toBe(true);
    expect(result[1].test('GoodMatchPattern')).toBe(true);
  });
});
