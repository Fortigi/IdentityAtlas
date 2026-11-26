// The findings file the monthly docs audit writes (docs-audit.yml).
//
// A model reads the documentation against the code; everything after it is
// deterministic and runs in a job that never sees the model. That job only
// trusts what passes validateReport(): a malformed or padded file is rejected
// as a whole, so a confused review cannot file issues with arbitrary content.

import { FINGERPRINT } from '../securityReview/findings.js';

// In the order they are numbered and filed: a page that is wrong misleads, a
// stale one is out of date, a missing one leaves the reader without an answer.
export const KINDS = ['Wrong', 'Stale', 'Missing'];

const REVIEW_ID = /^\d{4}-(0[1-9]|1[0-2])$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MAX_FINDINGS = 100;
const MAX_CHECKED = 500;

// What a finding may point at: a page the project maintains by hand. The
// generated coverage pages are rewritten by CI, so a finding there is noise.
const SAFE_PATH = /^[\w./-]+$/;

function isDocPage(path) {
  return (path.startsWith('docs/') && path.endsWith('.md') && !path.startsWith('docs/coverage/'))
    || (path.startsWith('ontology/') && path.endsWith('.ttl'))
    || path === 'README.md'
    || path === 'CLAUDE.md'
    || path.endsWith('/CLAUDE.md');
}

/** True when `path` is a hand-written page the audit may file a finding about. */
export function isAuditablePath(path) {
  return typeof path === 'string' && SAFE_PATH.test(path) && !path.includes('..') && isDocPage(path);
}

// [field, maximum length]. Every finding carries all of them.
const TEXT_FIELDS = [
  ['title', 160],
  ['docSays', 2000],
  ['codeDoes', 2000],
  ['evidence', 4000],
  ['suggestion', 4000],
];

function findingProblems(f, i) {
  const where = `findings[${i}]`;
  if (!f || typeof f !== 'object') return [`${where} is not an object`];
  const problems = [];
  for (const [field, max] of TEXT_FIELDS) {
    const v = f[field];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`${where}: ${field} is required`);
    else if (v.length > max) problems.push(`${where}: ${field} is longer than ${max} characters`);
  }
  if (!KINDS.includes(f.kind)) problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
  if (!isAuditablePath(f.docPath)) problems.push(`${where}: docPath must be a hand-written page (docs/**.md outside docs/coverage, ontology/**.ttl, README.md or a CLAUDE.md)`);
  if (typeof f.fingerprint !== 'string' || !FINGERPRINT.test(f.fingerprint)) {
    problems.push(`${where}: fingerprint must be 6-120 lowercase characters [a-z0-9._:/-]`);
  }
  return problems;
}

function headerProblems(report) {
  const problems = [];
  if (!REVIEW_ID.test(report.reviewId ?? '')) problems.push('reviewId must look like 2026-12');
  if (!COMMIT.test(report.commit ?? '')) problems.push('commit must be a git commit hash');
  // A review that names nothing it read cannot tell "the docs are fine" from "nothing was done".
  if (!Array.isArray(report.checked) || report.checked.length === 0) problems.push('checked must list what was reviewed');
  else if (report.checked.length > MAX_CHECKED || !report.checked.every(c => typeof c === 'string' && c.length <= 200)) {
    problems.push(`checked must be at most ${MAX_CHECKED} short strings`);
  }
  if (!Array.isArray(report.findings)) problems.push('findings must be a list');
  else if (report.findings.length > MAX_FINDINGS) problems.push(`more than ${MAX_FINDINGS} findings`);
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
 * the input with findings numbered DA-<reviewId>-NN in KINDS order.
 */
export function validateReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, problems: ['report is not an object'] };
  const problems = headerProblems(report);
  if (Array.isArray(report.findings)) {
    report.findings.forEach((f, i) => problems.push(...findingProblems(f, i)));
    if (problems.length === 0) problems.push(...duplicateProblems(report.findings));
  }
  if (problems.length > 0) return { ok: false, problems };
  const rank = k => KINDS.indexOf(k);
  const sorted = [...report.findings].sort((a, b) => rank(a.kind) - rank(b.kind));
  const findings = sorted.map((f, i) => ({ ...f, id: `DA-${report.reviewId}-${String(i + 1).padStart(2, '0')}` }));
  return { ok: true, problems: [], report: { ...report, findings } };
}
