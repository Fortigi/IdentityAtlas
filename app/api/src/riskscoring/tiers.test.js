import { describe, it, expect } from 'vitest';
import { tierFor } from './tiers.js';

// Locks the single-source risk-tier cutoffs (tiers.js). This is the exact drift
// that bit before — the engine used 90/70 for Critical/High while the override
// path used 80/60 — so a reintroduced local mapping with different cutoffs would
// re-tier entities inconsistently. Assert the boundary on BOTH sides of every
// cutoff (90 / 70 / 40 / 20 / 1), so moving any threshold by one point fails.
describe('tierFor — risk-tier cutoffs', () => {
  it.each([
    [Number.MAX_SAFE_INTEGER, 'Critical'],
    [100, 'Critical'],
    [90, 'Critical'], [89, 'High'],   // Critical cutoff
    [70, 'High'], [69, 'Medium'],     // High cutoff
    [40, 'Medium'], [39, 'Low'],      // Medium cutoff
    [20, 'Low'], [19, 'Minimal'],     // Low cutoff
    [1, 'Minimal'], [0, 'None'],      // Minimal cutoff
    [-5, 'None'],
  ])('score %i -> %s', (score, tier) => {
    expect(tierFor(score)).toBe(tier);
  });

  it('covers exactly the six tiers and no others', () => {
    const tiers = new Set([...Array(120).keys(), -1].map((s) => tierFor(s)));
    expect([...tiers].sort()).toEqual(['Critical', 'High', 'Low', 'Medium', 'Minimal', 'None']);
  });
});
