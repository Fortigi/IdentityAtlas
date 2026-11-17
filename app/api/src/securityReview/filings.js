// Turns validated findings into GitHub issues and private security advisories.
//
// planFilings() is pure: it decides, per finding, whether it is already tracked,
// new, or a regression of something that was closed. executeFilings() carries the
// plan out through an injected client (github.js), so both halves are testable
// without the network.
//
//   Critical / High / Medium  -> a draft security advisory (private), plus a
//                                public placeholder issue that says only the
//                                severity and the OWASP category, so the work is
//                                on the board without disclosing it.
//   Low / Informational       -> a public Bug issue with the full write-up,
//                                parked for one maintainer vouch before the
//                                automated bug pipeline picks it up.
//
// Each filing carries a fingerprint marker, so next month's review of the same
// problem finds the existing filing instead of opening a duplicate. The marker
// holds a hash of the fingerprint, not the fingerprint itself: a fingerprint
// names the component and the weakness, and the placeholder issue of a private
// finding is public.

import { createHash } from 'crypto';
import { OWASP_TOP10, PRIVATE_SEVERITIES } from './findings.js';

export const LABELS = ['security', 'ai-security-review'];
const OPEN_ADVISORY_STATES = new Set(['draft', 'triage']);

export function marker(fingerprint) {
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  return `<!-- ia-security-review:fp=${hash} -->`;
}

function carries(text, fingerprint) {
  return typeof text === 'string' && text.includes(marker(fingerprint));
}

function decide(open, closed) {
  if (open) return { action: 'known', existing: open };
  if (closed) return { action: 'create', regressionOf: closed };
  return { action: 'create' };
}

function planPrivate(f, issues, advisories) {
  const mine = advisories.filter(a => carries(a.description, f.fingerprint));
  const open = mine.find(a => OPEN_ADVISORY_STATES.has(a.state));
  const closed = mine.find(a => !OPEN_ADVISORY_STATES.has(a.state));
  const placeholder = issues.find(i => i.state === 'open' && carries(i.body, f.fingerprint));
  return { finding: f, private: true, placeholder, ...decide(open, closed) };
}

function planPublic(f, issues) {
  const mine = issues.filter(i => carries(i.body, f.fingerprint));
  const open = mine.find(i => i.state === 'open');
  const closed = mine.find(i => i.state !== 'open');
  return { finding: f, private: false, ...decide(open, closed) };
}

/** existing = { issues: [{number, state, body, html_url}], advisories: [{ghsa_id, state, description, html_url}] } */
export function planFilings(findings, existing) {
  const issues = existing.issues ?? [];
  const advisories = existing.advisories ?? [];
  return findings.map(f => (PRIVATE_SEVERITIES.has(f.severity) ? planPrivate(f, issues, advisories) : planPublic(f, issues)));
}

function labelsFor(f) {
  return [...LABELS, `severity:${f.severity.toLowerCase()}`];
}

function regressionLine(entry) {
  const prior = entry.regressionOf;
  if (!prior) return '';
  return `\n> **Regression.** This was filed before as ${prior.html_url} and closed; this review found it again as ${entry.finding.id}.\n`;
}

function owaspLine(f) {
  const cwe = f.cwe?.length ? ` · ${f.cwe.join(', ')}` : '';
  return `**${f.severity}** · OWASP ${f.owasp} ${OWASP_TOP10[f.owasp]}${cwe}`;
}

// A Low or Informational finding is a bug for the automated bug pipeline (DoR,
// docs/process/definition-of-ready.md). The pipeline only acts on issues from
// Fortigi members and ignores ones opened by a bot, so the issue is filed parked
// (`needs-vouch`), exactly like a bug from an outside reporter: one maintainer
// applying `dor-vouched` starts it. That click is the human gate between text a
// model wrote and a pipeline that runs with repository secrets.
export const VOUCH_LABELS = ['bug', 'needs-vouch'];

export function publicIssue(entry, reviewUrl, assignees = []) {
  const f = entry.finding;
  const body = [
    marker(f.fingerprint),
    `${owaspLine(f)} · \`${f.component}\``,
    regressionLine(entry),
    f.publicSummary,
    `## Description\n\n${f.description}`,
    `## Impact\n\n${f.impact}`,
    `## Remediation\n\n${f.remediation}`,
    `## Evidence\n\n${f.evidence}`,
    '---\n**Maintainers:** apply `dor-vouched` to hand this to the automated bug pipeline (you become the requestor of record), or close it if it is not a real problem.',
    `Found by the monthly security review ${f.id} (${reviewUrl}). See docs/security/index.md for how findings are handled.`,
  ];
  return {
    title: `[Security review] ${f.title}`,
    body: body.join('\n\n'),
    labels: [...labelsFor(f), ...VOUCH_LABELS],
    type: 'Bug',
    assignees,
  };
}

// Medium and above never go to the bug pipeline: its agents discuss the bug in
// public comments, which would disclose the vulnerability before it is fixed.
export function placeholderIssue(entry, advisoryUrl, assignees = []) {
  const f = entry.finding;
  const body = [
    marker(f.fingerprint),
    `**${f.severity}** · OWASP ${f.owasp} ${OWASP_TOP10[f.owasp]}`,
    'This finding from the monthly security review is tracked in a private security advisory, ' +
      'so its details stay out of public view until it is fixed. Maintainers can open it here: ' +
      advisoryUrl,
    'Fix it in the advisory\'s private fork, not through the public bug pipeline. When the fix is released, publish or close the advisory and close this issue.',
  ];
  return {
    title: `Security review ${f.id}: ${f.severity} finding (tracked privately)`,
    body: body.join('\n\n'),
    labels: labelsFor(f),
    type: 'Bug',
    assignees,
  };
}

export function advisory(entry, reviewUrl) {
  const f = entry.finding;
  const description = [
    marker(f.fingerprint),
    `${owaspLine(f)} · \`${f.component}\``,
    regressionLine(entry),
    `## Description\n\n${f.description}`,
    `## Impact\n\n${f.impact}`,
    `## Remediation\n\n${f.remediation}`,
    `## Evidence\n\n${f.evidence}`,
    `---\nFound by the monthly security review ${f.id} (${reviewUrl}).`,
  ].join('\n\n');
  return {
    summary: f.title,
    description,
    severity: f.severity.toLowerCase(),
    cwe_ids: f.cwe ?? [],
    vulnerabilities: [{ package: { ecosystem: 'other', name: 'identity-atlas' } }],
  };
}

async function filePrivate(entry, client, reviewUrl, assignees) {
  if (entry.action === 'known') {
    return { issueUrl: entry.placeholder?.html_url ?? null, advisoryUrl: entry.existing.html_url, isNew: false };
  }
  const adv = await client.createAdvisory(advisory(entry, reviewUrl));
  const issue = await client.createIssue(placeholderIssue(entry, adv.html_url, assignees));
  // Placeholders go on the board here; a public bug reaches the board through the
  // vouch, which also sets its pipeline status (dor-vouch.yml).
  if (client.addToBoard) await client.addToBoard(issue.node_id);
  return { issueUrl: issue.html_url, advisoryUrl: adv.html_url, isNew: true };
}

async function filePublic(entry, client, reviewUrl, assignees) {
  if (entry.action === 'known') return { issueUrl: entry.existing.html_url, isNew: false };
  const issue = await client.createIssue(publicIssue(entry, reviewUrl, assignees));
  return { issueUrl: issue.html_url, isNew: true };
}

/**
 * Carry out a plan. Returns { [fingerprint]: { issueUrl, advisoryUrl?, isNew } },
 * which publicPage.js uses to link each finding. `assignees` are the
 * maintainers every new issue is assigned to.
 */
export async function executeFilings(plan, client, reviewUrl, { assignees = [] } = {}) {
  const result = {};
  for (const entry of plan) {
    const file = entry.private ? filePrivate : filePublic;
    result[entry.finding.fingerprint] = await file(entry, client, reviewUrl, assignees);
  }
  return result;
}
