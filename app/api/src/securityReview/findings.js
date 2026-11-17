// The findings file the monthly security review writes (security-review.yml).
//
// The review itself is done by a model; everything after it is deterministic and
// runs in a separate job that never sees the model. That job only trusts what
// passes validateReport(): a malformed or padded file is rejected as a whole, so
// a confused or manipulated review cannot file issues with arbitrary content.

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'];

// Medium and above are filed as private security advisories, never as public
// issues: SECURITY.md promises reporters that vulnerabilities are not disclosed
// before they are fixed, and the same holds for our own findings.
export const PRIVATE_SEVERITIES = new Set(['Critical', 'High', 'Medium']);

export const OWASP_TOP10 = {
  A01: 'Broken Access Control',
  A02: 'Security Misconfiguration',
  A03: 'Software Supply Chain Failures',
  A04: 'Cryptographic Failures',
  A05: 'Injection',
  A06: 'Insecure Design',
  A07: 'Authentication Failures',
  A08: 'Software or Data Integrity Failures',
  A09: 'Security Logging and Alerting Failures',
  A10: 'Mishandling of Exceptional Conditions',
};

const REVIEW_ID = /^\d{4}-(0[1-9]|1[0-2])$/;
const FINGERPRINT = /^[a-z0-9][a-z0-9._:/-]{5,119}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MAX_FINDINGS = 200;

// [field, maximum length]. Every finding carries all of them.
const TEXT_FIELDS = [
  ['title', 160],
  ['component', 120],
  ['publicSummary', 400],
  ['description', 8000],
  ['impact', 4000],
  ['remediation', 4000],
  ['evidence', 8000],
];

function textProblems(f, where) {
  const problems = [];
  for (const [field, max] of TEXT_FIELDS) {
    const v = f[field];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`${where}: ${field} is required`);
    else if (v.length > max) problems.push(`${where}: ${field} is longer than ${max} characters`);
  }
  return problems;
}

function findingProblems(f, i) {
  const where = `findings[${i}]`;
  if (!f || typeof f !== 'object') return [`${where} is not an object`];
  const problems = textProblems(f, where);
  if (!SEVERITIES.includes(f.severity)) problems.push(`${where}: severity must be one of ${SEVERITIES.join(', ')}`);
  if (!(f.owasp in OWASP_TOP10)) problems.push(`${where}: owasp must be one of A01..A10`);
  if (typeof f.fingerprint !== 'string' || !FINGERPRINT.test(f.fingerprint)) {
    problems.push(`${where}: fingerprint must be 6-120 lowercase characters [a-z0-9._:/-]`);
  }
  if (f.cwe !== undefined && !(Array.isArray(f.cwe) && f.cwe.every(c => /^CWE-\d{1,4}$/.test(c)))) {
    problems.push(`${where}: cwe must be a list like ["CWE-79"]`);
  }
  return problems;
}

function headerProblems(report) {
  const problems = [];
  if (!REVIEW_ID.test(report.reviewId ?? '')) problems.push('reviewId must look like 2026-12');
  if (!COMMIT.test(report.commit ?? '')) problems.push('commit must be a git commit hash');
  if (typeof report.version !== 'string' || report.version === '') problems.push('version is required');
  if (!Array.isArray(report.findings)) problems.push('findings must be a list');
  else if (report.findings.length > MAX_FINDINGS) problems.push(`more than ${MAX_FINDINGS} findings`);
  return problems;
}

// The coverage notes are published as written, so they are kept to a sentence or two.
const MAX_COVERAGE_NOTES = 300;

function coverageProblems(coverage) {
  if (!Array.isArray(coverage)) return ['coverage must list every OWASP Top 10 category'];
  const seen = new Set(coverage.map(c => c?.category));
  const problems = Object.keys(OWASP_TOP10)
    .filter(k => !seen.has(k))
    .map(k => `coverage is missing ${k}`);
  for (const c of coverage) {
    if (typeof c?.notes !== 'string' || c.notes.length > MAX_COVERAGE_NOTES) {
      problems.push(`coverage ${c?.category}: notes must be text of at most ${MAX_COVERAGE_NOTES} characters`);
    }
  }
  return problems;
}

function duplicateProblems(findings) {
  const seen = new Set();
  const problems = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) problems.push(`fingerprint ${f.fingerprint} appears twice`);
    seen.add(f.fingerprint);
  }
  return problems;
}

/**
 * Check a parsed findings file. Returns { ok, problems, report } where report is
 * the input with findings numbered SR-<reviewId>-NN in severity order.
 */
export function validateReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, problems: ['report is not an object'] };
  const problems = [...headerProblems(report), ...coverageProblems(report.coverage)];
  if (Array.isArray(report.findings)) {
    report.findings.forEach((f, i) => problems.push(...findingProblems(f, i)));
    if (problems.length === 0) problems.push(...duplicateProblems(report.findings));
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, problems: [], report: numberFindings(report) };
}

function numberFindings(report) {
  const rank = s => SEVERITIES.indexOf(s);
  const sorted = [...report.findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  const findings = sorted.map((f, i) => ({ ...f, id: `SR-${report.reviewId}-${String(i + 1).padStart(2, '0')}` }));
  return { ...report, findings };
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
