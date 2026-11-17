import { describe, expect, it } from 'vitest';
import { countBySeverity, validateReport } from './findings.js';
import { finding, report } from './__mocks__/sampleReport.js';

function problemsOf(input) {
  const result = validateReport(input);
  expect(result.ok).toBe(false);
  return result.problems;
}

describe('validateReport', () => {
  it('accepts a valid report and numbers findings by severity, most severe first', () => {
    const input = report([
      finding({ fingerprint: 'low-one', severity: 'Low' }),
      finding({ fingerprint: 'crit-one', severity: 'Critical' }),
      finding({ fingerprint: 'med-one', severity: 'Medium' }),
    ]);
    const result = validateReport(input);
    expect(result.ok).toBe(true);
    expect(result.report.findings.map(f => [f.id, f.fingerprint])).toEqual([
      ['SR-2026-12-01', 'crit-one'],
      ['SR-2026-12-02', 'med-one'],
      ['SR-2026-12-03', 'low-one'],
    ]);
    // The input is not mutated: the caller's array keeps its order and gets no ids.
    expect(input.findings[0].id).toBeUndefined();
  });

  it('accepts a report with no findings and a finding without cwe', () => {
    expect(validateReport(report([])).ok).toBe(true);
    const noCwe = finding();
    delete noCwe.cwe;
    expect(validateReport(report([noCwe])).ok).toBe(true);
  });

  it('rejects something that is not an object', () => {
    expect(problemsOf(null)).toEqual(['report is not an object']);
    expect(problemsOf('text')).toEqual(['report is not an object']);
  });

  it.each([
    ['reviewId', { reviewId: '2026-13' }, 'reviewId must look like 2026-12'],
    ['reviewId', { reviewId: undefined }, 'reviewId must look like 2026-12'],
    ['commit', { commit: 'not-a-hash' }, 'commit must be a git commit hash'],
    ['version', { version: '' }, 'version is required'],
    ['findings', { findings: 'none' }, 'findings must be a list'],
  ])('rejects a bad %s', (_field, overrides, expected) => {
    expect(problemsOf(report([finding()], overrides))).toContain(expected);
  });

  it('rejects more than 200 findings', () => {
    const many = Array.from({ length: 201 }, (_, i) => finding({ fingerprint: `finding-${i}` }));
    expect(problemsOf(report(many))).toContain('more than 200 findings');
  });

  it('accepts exactly 200 findings', () => {
    const many = Array.from({ length: 200 }, (_, i) => finding({ fingerprint: `finding-${i}` }));
    expect(validateReport(report(many)).ok).toBe(true);
  });

  it('requires every OWASP Top 10 category in coverage', () => {
    const r = report();
    r.coverage = r.coverage.filter(c => c.category !== 'A07');
    expect(problemsOf(r)).toEqual(['coverage is missing A07']);
    expect(problemsOf(report([finding()], { coverage: {} }))).toEqual(['coverage must list every OWASP Top 10 category']);
  });

  it('limits coverage notes to 300 characters because they are published as written', () => {
    const r = report();
    r.coverage[0].notes = 'x'.repeat(300);
    expect(validateReport(r).ok).toBe(true);
    r.coverage[0].notes = 'x'.repeat(301);
    expect(problemsOf(r)).toEqual(['coverage A01: notes must be text of at most 300 characters']);
    r.coverage[0].notes = undefined;
    expect(problemsOf(r)).toEqual(['coverage A01: notes must be text of at most 300 characters']);
  });

  it('requires every text field and caps its length', () => {
    expect(problemsOf(report([finding({ evidence: '   ' })]))).toEqual(['findings[0]: evidence is required']);
    expect(problemsOf(report([finding({ title: 'x'.repeat(161) })]))).toEqual([
      'findings[0]: title is longer than 160 characters',
    ]);
    expect(validateReport(report([finding({ title: 'x'.repeat(160) })])).ok).toBe(true);
  });

  it.each([
    [{ severity: 'Severe' }, 'severity must be one of'],
    [{ owasp: 'A11' }, 'owasp must be one of A01..A10'],
    [{ fingerprint: 'Upper-Case' }, 'fingerprint must be'],
    [{ fingerprint: 'short' }, 'fingerprint must be'],
    [{ cwe: ['79'] }, 'cwe must be a list'],
    [{ cwe: 'CWE-79' }, 'cwe must be a list'],
  ])('rejects a finding with %o', (overrides, expected) => {
    const problems = problemsOf(report([finding(overrides)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it('rejects a finding that is not an object', () => {
    expect(problemsOf(report([42]))).toEqual(['findings[0] is not an object']);
  });

  it('rejects two findings with the same fingerprint', () => {
    expect(problemsOf(report([finding(), finding()]))).toEqual(['fingerprint api:routes/export.js:formula appears twice']);
  });
});

describe('countBySeverity', () => {
  it('counts each severity, zero for the ones not present', () => {
    const counts = countBySeverity([{ severity: 'High' }, { severity: 'High' }, { severity: 'Low' }]);
    expect(counts).toEqual({ Critical: 0, High: 2, Medium: 0, Low: 1, Informational: 0 });
  });
});
