// Unit tests for the pure derivations extracted from the access-package detail
// handler (#1029): the assignment-type label and the review compliance status.
// The DB-bound fetch helpers are covered through details.test.js +
// accessPackageDetail.contract.test.js.

import { describe, it, expect } from 'vitest';
import { deriveAssignmentType, deriveCompliance } from './accessPackageDetail.js';

describe('deriveAssignmentType', () => {
  it('returns null when there are no policies', () => {
    expect(deriveAssignmentType({ policyCount: 0, autoAddPolicyCount: 0, autoRemovePolicyCount: 0 })).toBeNull();
  });
  it('is Both when auto-add coexists with request-based', () => {
    expect(deriveAssignmentType({ policyCount: 2, autoAddPolicyCount: 1, autoRemovePolicyCount: 0 })).toBe('Both');
  });
  it('is Both when auto-add coexists with auto-removal', () => {
    expect(deriveAssignmentType({ policyCount: 2, autoAddPolicyCount: 1, autoRemovePolicyCount: 1 })).toBe('Both');
  });
  it('is Auto-assigned when every policy auto-adds', () => {
    expect(deriveAssignmentType({ policyCount: 2, autoAddPolicyCount: 2, autoRemovePolicyCount: 0 })).toBe('Auto-assigned');
  });
  it('is Request-based with auto-removal when only auto-removal is present', () => {
    expect(deriveAssignmentType({ policyCount: 2, autoAddPolicyCount: 0, autoRemovePolicyCount: 1 }))
      .toBe('Request-based with auto-removal');
  });
  it('is Request-based when policies are neither auto-add nor auto-remove', () => {
    expect(deriveAssignmentType({ policyCount: 3, autoAddPolicyCount: 0, autoRemovePolicyCount: 0 })).toBe('Request-based');
  });
});

describe('deriveCompliance', () => {
  const NOW = new Date('2026-08-13T00:00:00Z');
  it('returns nulls when there is no review row', () => {
    expect(deriveCompliance(null, NOW)).toEqual({ complianceStatus: null, daysOverdue: 0 });
  });
  it('is Compliant when nothing is unreviewed or late', () => {
    expect(deriveCompliance({ deadline: '2026-09-01', notReviewed: 0, late: 0 }, NOW))
      .toEqual({ complianceStatus: 'Compliant', daysOverdue: 0 });
  });
  it('reports daysOverdue independently of the status label (past deadline, still Compliant)', () => {
    // The original sets daysOverdue whenever the deadline has passed, regardless
    // of status — pin that so the behaviour can't drift.
    const out = deriveCompliance({ deadline: '2026-08-03T00:00:00Z', notReviewed: 0, late: 0 }, NOW);
    expect(out).toEqual({ complianceStatus: 'Compliant', daysOverdue: 10 });
  });
  it('is In Progress when items remain but the deadline has not passed', () => {
    const out = deriveCompliance({ deadline: '2026-09-01', notReviewed: 3, late: 0 }, NOW);
    expect(out).toEqual({ complianceStatus: 'In Progress', daysOverdue: 0 });
  });
  it('is Missed and counts days overdue when items remain past the deadline', () => {
    const out = deriveCompliance({ deadline: '2026-08-03T00:00:00Z', notReviewed: 2, late: 0 }, NOW);
    expect(out.complianceStatus).toBe('Missed');
    expect(out.daysOverdue).toBe(10);
  });
  it('is Reviewed Late when all reviewed but some were late', () => {
    expect(deriveCompliance({ deadline: '2026-09-01', notReviewed: 0, late: 2 }, NOW))
      .toEqual({ complianceStatus: 'Reviewed Late', daysOverdue: 0 });
  });
});
