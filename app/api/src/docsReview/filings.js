// Turns validated docs-audit findings into GitHub issues.
//
// planFilings() is pure: per finding it decides whether an issue already tracks
// it, a maintainer dismissed it, or it needs a new one. executeFilings() carries
// the plan out through an injected client (securityReview/github.js), so both
// halves are testable without the network.
//
// Every issue carries a fingerprint marker, so next month's audit of the same
// problem finds the existing issue instead of opening a duplicate:
//
//   open issue                      -> known, nothing filed
//   closed as "not planned"         -> dismissed: a maintainer said it is not a
//                                      problem, so it is never filed again
//   closed as completed             -> filed again, noting it came back
//   no issue                        -> filed
//
// At most MAX_NEW_ISSUES are opened per run, so a first run against years of
// drift does not bury the board; the rest are deferred to the next run, which
// finds them again.

import { createHash } from 'crypto';

export const ISSUE_LABEL = 'ai-docs-review';
// Parked for one maintainer vouch, exactly like a bug from an outside reporter
// (docs/process/definition-of-ready.md): applying `dor-vouched` hands the issue
// to the automated bug pipeline. That click is the human gate between text a
// model wrote and a pipeline that runs with repository secrets.
// `bug` is what dor-vouch.yml routes on: a vouched docs finding takes the bug route.
export const LABELS = ['documentation', 'bug', ISSUE_LABEL, 'needs-vouch'];
export const MAX_NEW_ISSUES = 25;

export function marker(fingerprint) {
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  return `<!-- ia-docs-review:fp=${hash} -->`;
}

function decide(f, issues) {
  const mine = issues.filter(i => typeof i.body === 'string' && i.body.includes(marker(f.fingerprint)));
  const open = mine.find(i => i.state === 'open');
  if (open) return { action: 'known', existing: open };
  const dismissed = mine.find(i => i.state_reason === 'not_planned');
  if (dismissed) return { action: 'dismissed', existing: dismissed };
  const fixed = mine.find(i => i.state !== 'open');
  return fixed ? { action: 'create', recurrenceOf: fixed } : { action: 'create' };
}

/** issues = [{ number, state, state_reason, body, html_url }] carrying ISSUE_LABEL. */
export function planFilings(findings, issues = []) {
  let budget = MAX_NEW_ISSUES;
  return findings.map(f => {
    const entry = { finding: f, ...decide(f, issues) };
    if (entry.action !== 'create') return entry;
    if (budget === 0) return { ...entry, action: 'deferred' };
    budget -= 1;
    return entry;
  });
}

export function issueFor(entry, reviewUrl, assignees = []) {
  const f = entry.finding;
  const recurrence = entry.recurrenceOf
    ? `> **Came back.** This was filed before as ${entry.recurrenceOf.html_url} and closed as fixed; the audit found it again.\n`
    : '';
  const body = [
    marker(f.fingerprint),
    `**${f.kind}** · \`${f.docPath}\``,
    recurrence,
    `## What the page says\n\n${f.docSays}`,
    `## What the code does\n\n${f.codeDoes}`,
    `## Evidence\n\n${f.evidence}`,
    `## Suggested change\n\n${f.suggestion}`,
    '---\n**Maintainers:** apply `dor-vouched` to hand this to the automated bug pipeline (you become the requestor of record), fix it by hand, ' +
      'or close it as **not planned** if the page is right: the audit then never files it again.',
    `Found by the monthly docs audit ${f.id} (${reviewUrl}).`,
  ];
  return {
    title: `[Docs audit] ${f.title}`,
    body: body.filter(Boolean).join('\n\n'),
    labels: LABELS,
    assignees,
  };
}

/** One line per finding for the run log and the job summary. */
export function describePlan(plan, filed = {}) {
  return plan.map(e => {
    const f = e.finding;
    const what = {
      known: `already tracked (${e.existing?.html_url})`,
      dismissed: `dismissed earlier (${e.existing?.html_url}), not filed`,
      deferred: `over this run's limit of ${MAX_NEW_ISSUES} new issues, left for the next run`,
      create: filed[f.fingerprint] ?? `new issue${e.recurrenceOf ? ' (came back)' : ''}`,
    }[e.action];
    return `${f.id} ${f.kind} ${f.docPath}: ${what}`;
  });
}

/** Carry out a plan. Returns { [fingerprint]: issue url } for the issues it opened. */
export async function executeFilings(plan, client, reviewUrl, { assignees = [] } = {}) {
  const filed = {};
  for (const entry of plan.filter(e => e.action === 'create')) {
    const issue = await client.createIssue(issueFor(entry, reviewUrl, assignees));
    filed[entry.finding.fingerprint] = issue.html_url;
  }
  return filed;
}
