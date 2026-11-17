// Shared test fixture for the securityReview tests: a valid findings file.
// Each text field is distinct per finding so a test can prove exactly which
// finding's text ended up where (and, more importantly, which did not).

import { OWASP_TOP10 } from '../findings.js';

export function finding(overrides = {}) {
  const fp = overrides.fingerprint ?? 'api:routes/export.js:formula';
  return {
    title: `Title of ${fp}`,
    severity: 'Low',
    owasp: 'A05',
    component: `component-of-${fp}`,
    fingerprint: fp,
    cwe: ['CWE-1236'],
    publicSummary: `Public summary of ${fp}`,
    description: `Secret description of ${fp}`,
    impact: `Impact of ${fp}`,
    remediation: `Remediation of ${fp}`,
    evidence: `Evidence of ${fp}`,
    ...overrides,
  };
}

export function report(findings = [finding()], overrides = {}) {
  return {
    reviewId: '2026-12',
    commit: 'abcdef1234567890',
    version: '6.95.20261201.0300',
    coverage: Object.keys(OWASP_TOP10).map(category => ({ category, notes: `Checked ${category}` })),
    findings,
    ...overrides,
  };
}
