// Access Reviewer Response — per reviewer, how often they actually review.
//
// The companion to Access Review Adoption: that report says WHICH roles nobody
// looks at, this one says WHO was asked and did not answer, and who reliably
// does. One row per reviewer.
//
// "Asked" comes from the reviewers each review round contacted (the Entra ID
// crawler stores them on the decisions as `extendedAttributes.contactedReviewers`).
// "Answered" means the person made at least one decision in that round
// themselves — by the rule in ../humanReview.js, so a decision the platform
// applied because nobody responded is not theirs. A reviewer who decided in a
// round they were not listed on (a fallback reviewer, say) counts as asked too.
//
// Only rounds that have ended are judged; a round still open is counted
// separately and not held against anyone. Rows come worst first: the people to
// follow up with at the top, the ones to thank at the bottom.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';
import { daysBetween, parseDays } from '../activityWindow.js';
import { approvalSql, denialSql, humanDecisionSql, reviewRoundKeySql, reviewRoundOpen } from '../humanReview.js';

export const DEFAULT_PERIOD_DAYS = 365;

export const VERDICT = {
  NEVER: 'Never responded',
  MOSTLY_NOT: 'Mostly does not respond',
  SOMETIMES: 'Responds sometimes',
  CONSISTENT: 'Reviews consistently',
  OPEN_ONLY: 'Only open reviews',
};

/** Worst first. */
export const VERDICT_ORDER = [VERDICT.NEVER, VERDICT.MOSTLY_NOT, VERDICT.SOMETIMES, VERDICT.CONSISTENT, VERDICT.OPEN_ONLY];

export const VERDICT_COLORS = {
  [VERDICT.NEVER]: 'DC2626',
  [VERDICT.MOSTLY_NOT]: 'F97316',
  [VERDICT.SOMETIMES]: 'FACC15',
  [VERDICT.CONSISTENT]: '16A34A',
  [VERDICT.OPEN_ONLY]: '9CA3AF',
};

/** Response rate (whole percent) at or above which a reviewer counts as consistent. */
export const CONSISTENT_RATE = 90;
/** Below this they mostly do not respond. */
export const MOSTLY_NOT_RATE = 50;

export default {
  name: 'access-reviewer-response',
  displayName: 'Access Reviewer Response',
  description:
    'One row per access reviewer: how many review rounds they were asked to do, how many they '
    + 'actually answered themselves, and how they decided. Decisions applied automatically because '
    + 'nobody responded do not count as answered. The reviewers to follow up with are at the top, '
    + 'the ones who review consistently at the bottom.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: [],
    properties: {
      periodDays: {
        type: 'integer',
        title: 'Period (days)',
        description: 'Only review rounds that ended within this many days are judged. Open rounds are '
          + 'always shown, but never counted against anyone.',
        default: DEFAULT_PERIOD_DAYS,
      },
    },
  },
  columns: [
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'email', label: 'Email' },
    { key: 'department', label: 'Department' },
    { key: 'verdict', label: 'Verdict' },
    { key: 'roundsAsked', label: 'Reviews asked' },
    { key: 'roundsAnswered', label: 'Reviews answered' },
    { key: 'roundsMissed', label: 'Reviews missed' },
    { key: 'responseRate', label: 'Response %' },
    { key: 'businessRoles', label: 'Business roles' },
    { key: 'decisions', label: 'Decisions made' },
    { key: 'approvedShare', label: 'Approved %' },
    { key: 'deniedShare', label: 'Denied %' },
    { key: 'justifiedShare', label: 'With justification %' },
    { key: 'lastDecision', label: 'Last decision' },
    { key: 'daysSinceLastDecision', label: 'Days ago' },
    { key: 'openRounds', label: 'Open reviews' },
  ],
  pivots: [
    { name: 'By verdict', rows: ['verdict', 'reviewer'], values: ['roundsAsked', 'roundsAnswered', 'roundsMissed'] },
    { name: 'By department', rows: ['department', 'verdict'], values: ['roundsAsked', 'roundsMissed'] },
  ],
  charts: [
    { name: 'Reviewers by verdict', type: 'pie', category: 'verdict', title: 'Reviewers by response', valueLabel: 'Reviewers', colors: VERDICT_COLORS },
    { name: 'Missed reviews', type: 'pie', category: 'verdict', value: 'roundsMissed', title: 'Missed reviews by reviewer response', valueLabel: 'Missed reviews', colors: VERDICT_COLORS },
  ],

  async run(params, ctx) {
    const now = new Date();
    const periodDays = parseDays(params?.periodDays, DEFAULT_PERIOD_DAYS);
    const { rows: pairs } = await db.query(REVIEWER_ROUNDS_SQL);
    const folded = foldReviewers(pairs, { periodDays, now });
    const people = await fetchPrincipals(folded.map(r => r.key));
    const rows = folded.map(r => buildRow(r, people.get(r.key), now)).sort(compareRows);
    ctx?.log?.(`access-reviewer-response report: ${rows.length} reviewer(s)`);
    return { rows, notices: summaries(rows, pairs, periodDays) };
  },
};

// ─── The reads ────────────────────────────────────────────────────────────

// One row per (reviewer, review round): asked (contacted) and/or what they
// decided themselves in it. The contacted list is repeated on every decision of
// a round, so it is read once per round (DISTINCT ON) rather than per decision.
// A reviewer is keyed on their id, lowercased; a source that only records a
// name (CSV) is keyed on 'name:<name>' so it still folds per person.
export const REVIEWER_ROUNDS_SQL = `
  WITH d AS (
    SELECT d."resourceId", ${reviewRoundKeySql('d')} AS round,
           d."reviewInstanceStatus" AS status, d."reviewInstanceEndDateTime" AS "endsAt",
           d."reviewedBy", d."reviewedByDisplayName", d."reviewedDateTime", d.decision, d.justification,
           d."extendedAttributes" AS ext,
           ${humanDecisionSql('d')} AS human,
           ${approvalSql('d')} AS approved,
           ${denialSql('d')} AS denied
      FROM "CertificationDecisions" d
  ),
  rounds AS (
    SELECT "resourceId", round, MAX("endsAt") AS "endsAt", MAX(status) AS status
      FROM d GROUP BY "resourceId", round
  ),
  lists AS (
    SELECT DISTINCT ON ("resourceId", round) "resourceId", round, ext->'contactedReviewers' AS list
      FROM d
     WHERE jsonb_typeof(ext->'contactedReviewers') = 'array'
     ORDER BY "resourceId", round
  ),
  contacted AS (
    SELECT DISTINCT l."resourceId", l.round, lower(c->>'id') AS key,
           c->>'displayName' AS name, c->>'userPrincipalName' AS upn
      FROM lists l CROSS JOIN LATERAL jsonb_array_elements(l.list) c
     WHERE COALESCE(c->>'id', '') <> ''
  ),
  decided AS (
    SELECT "resourceId", round,
           COALESCE(lower("reviewedBy"::text), 'name:' || lower("reviewedByDisplayName")) AS key,
           MAX("reviewedByDisplayName") AS name,
           COUNT(*)::int AS decisions,
           COUNT(*) FILTER (WHERE approved)::int AS approvals,
           COUNT(*) FILTER (WHERE denied)::int AS denials,
           COUNT(*) FILTER (WHERE COALESCE(btrim(justification), '') <> '')::int AS justified,
           MAX("reviewedDateTime") AS "lastDecision"
      FROM d WHERE human
     GROUP BY "resourceId", round, 3
  )
  SELECT COALESCE(c."resourceId", x."resourceId") AS "resourceId",
         COALESCE(c.round, x.round) AS round,
         COALESCE(c.key, x.key) AS key,
         COALESCE(x.name, c.name) AS name,
         c.upn,
         (c.key IS NOT NULL) AS contacted,
         COALESCE(x.decisions, 0) AS decisions,
         COALESCE(x.approvals, 0) AS approvals,
         COALESCE(x.denials, 0) AS denials,
         COALESCE(x.justified, 0) AS justified,
         x."lastDecision",
         r."endsAt", r.status
    FROM contacted c
    FULL JOIN decided x ON x."resourceId" = c."resourceId" AND x.round = c.round AND x.key = c.key
    JOIN rounds r ON r."resourceId" = COALESCE(c."resourceId", x."resourceId") AND r.round = COALESCE(c.round, x.round)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The synced accounts behind the reviewer keys that are ids, keyed the same way. */
async function fetchPrincipals(keys) {
  const ids = keys.filter(k => UUID.test(k));
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, "displayName", email, department
       FROM "Principals"
      WHERE id = ANY($1::uuid[]) AND "deletedAt" IS NULL`, [ids]);
  return new Map(rows.map(p => [String(p.id).toLowerCase(), p]));
}

// ─── Folding ──────────────────────────────────────────────────────────────

const emptyReviewer = key => ({
  key, name: null, upn: null, asked: 0, answered: 0, open: 0, roles: new Set(),
  decisions: 0, approvals: 0, denials: 0, justified: 0, lastDecision: null,
});

/** Whether a finished round falls inside the period; a round with no end date always does. */
export function inPeriod(endsAt, periodDays, now) {
  return !endsAt || daysBetween(new Date(endsAt), now) <= periodDays;
}

/**
 * (reviewer, round) rows folded into one entry per reviewer. Open rounds are
 * counted apart and never as asked; finished rounds outside the period are
 * skipped entirely, decisions included, so every number on a row covers the
 * same rounds.
 */
export function foldReviewers(pairs, { periodDays, now }) {
  const byKey = new Map();
  for (const p of pairs) {
    const open = reviewRoundOpen({ endsAt: p.endsAt, status: p.status }, now);
    if (!open && !inPeriod(p.endsAt, periodDays, now)) continue;
    const r = byKey.get(p.key) || emptyReviewer(p.key);
    r.name = r.name || p.name || null;
    r.upn = r.upn || p.upn || null;
    if (open) r.open += 1;
    else {
      r.asked += 1;
      if (p.decisions > 0) r.answered += 1;
      r.roles.add(p.resourceId);
    }
    r.decisions += p.decisions;
    r.approvals += p.approvals;
    r.denials += p.denials;
    r.justified += p.justified;
    if (p.lastDecision && (!r.lastDecision || new Date(p.lastDecision) > new Date(r.lastDecision))) r.lastDecision = p.lastDecision;
    byKey.set(p.key, r);
  }
  return [...byKey.values()];
}

/** `n` as a whole percentage of `total`, or null when there is nothing to divide. */
export function percent(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : null;
}

/** The verdict a response rate earns. */
export function verdictFor({ asked, answered }) {
  if (!asked) return VERDICT.OPEN_ONLY;
  if (!answered) return VERDICT.NEVER;
  const rate = percent(answered, asked);
  if (rate >= CONSISTENT_RATE) return VERDICT.CONSISTENT;
  if (rate < MOSTLY_NOT_RATE) return VERDICT.MOSTLY_NOT;
  return VERDICT.SOMETIMES;
}

/** One row per reviewer; the synced account, when there is one, supplies name, mail and department. */
export function buildRow(r, principal, now) {
  return {
    reviewer: principal?.displayName || r.name || r.upn || r.key.replace(/^name:/, ''),
    email: principal?.email || r.upn || null,
    department: principal?.department || null,
    verdict: verdictFor(r),
    roundsAsked: r.asked,
    roundsAnswered: r.answered,
    roundsMissed: r.asked - r.answered,
    responseRate: percent(r.answered, r.asked),
    businessRoles: r.roles.size,
    decisions: r.decisions,
    approvedShare: percent(r.approvals, r.decisions),
    deniedShare: percent(r.denials, r.decisions),
    justifiedShare: percent(r.justified, r.decisions),
    lastDecision: r.lastDecision ? toDateOnly(r.lastDecision) : null,
    daysSinceLastDecision: r.lastDecision ? daysBetween(new Date(r.lastDecision), now) : null,
    openRounds: r.open,
    ...(principal ? { _entity: { kind: 'user', id: principal.id } } : {}),
  };
}

/** Worst verdict first; within it the most missed reviews first, then by name. */
export function compareRows(a, b) {
  return VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict)
    || b.roundsMissed - a.roundsMissed
    || String(a.reviewer).localeCompare(String(b.reviewer));
}

// ─── The summaries ────────────────────────────────────────────────────────

export function summaries(rows, pairs, periodDays) {
  if (pairs.length === 0) {
    return [{
      severity: 'warning',
      text: 'No access review decisions have been synced, so there is no reviewer to report on.',
    }];
  }
  const asked = rows.reduce((s, r) => s + r.roundsAsked, 0);
  const answered = rows.reduce((s, r) => s + r.roundsAnswered, 0);
  const count = v => rows.filter(r => r.verdict === v).length;
  const notices = [{
    severity: 'info',
    text: `${rows.length} reviewer(s) over review rounds that ended in the last ${periodDays} days: `
      + `${answered} of ${asked} requested reviews answered by the reviewer themselves (${percent(answered, asked) ?? 0}%). `
      + `${count(VERDICT.NEVER)} never responded, ${count(VERDICT.CONSISTENT)} review consistently.`,
  }];
  if (!pairs.some(p => p.contacted)) {
    notices.push({
      severity: 'warning',
      text: 'No source recorded which reviewers were asked, so only reviewers who made a decision are listed and '
        + 'nobody can show up as "never responded". Run a full sync of the Entra ID crawler to collect them.',
    });
  }
  return notices;
}
