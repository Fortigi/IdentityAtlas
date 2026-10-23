// Access Review Adoption — per business role, when a PERSON last reviewed it.
//
// The question is adoption, not compliance. The compliance view ("Compliant",
// "Missed", "Reviewed Late") reads a review as done when its decisions are not
// `NotReviewed` — and in Entra ID that is true of a review nobody opened: when
// the deadline passes, the configured default decision is applied and the
// review completes. A tenant can look fully compliant while no reviewer has
// made a decision in a year. This report tells those apart, on the rule in
// ../humanReview.js: a decision counts only when a person made it.
//
// One row per business role, with the role's status:
//
//   No review yet                     — no review round has ever been held for it
//   Never reviewed by a person        — rounds were held; no person ever decided
//   Latest review not by a person     — a person did review it once; the latest
//                                       round completed without one
//   Latest review partly by a person  — in the latest round some decisions were
//                                       a person's and some were not
//   Reviewed by a person, too long ago— the latest round was a person's work,
//                                       but longer ago than the threshold
//   Reviewed by a person              — the latest round was fully a person's
//   Review in progress                — the latest round is still open; no
//                                       verdict yet
//   New, no review yet                — no round yet, and the role is younger
//                                       than the threshold: expected, not a gap
//
// Rows are ordered worst first, and inside a status by the last review a person
// made, longest ago first — the top of the list is who to talk to.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';
import { daysBetween, parseDays } from '../activityWindow.js';
import { humanDecisionSql, reviewRoundKeySql, reviewRoundOpen } from '../humanReview.js';

export const DEFAULT_NEW_ROLE_DAYS = 90;
export const DEFAULT_STALE_AFTER_DAYS = 365;

export const STATUS = {
  NO_REVIEW: 'No review yet',
  NEVER_BY_PERSON: 'Never reviewed by a person',
  LATEST_NOT_BY_PERSON: 'Latest review not by a person',
  LATEST_PARTLY: 'Latest review partly by a person',
  STALE: 'Reviewed by a person, too long ago',
  REVIEWED: 'Reviewed by a person',
  IN_PROGRESS: 'Review in progress',
  NEW: 'New, no review yet',
};

/** Worst first — the order the rows come in, and the order the pie reads in. */
export const STATUS_ORDER = [
  STATUS.NO_REVIEW, STATUS.NEVER_BY_PERSON, STATUS.LATEST_NOT_BY_PERSON, STATUS.LATEST_PARTLY,
  STATUS.STALE, STATUS.REVIEWED, STATUS.IN_PROGRESS, STATUS.NEW,
];

/** Slice colours: reds for "nobody looks", amber for "slipping", green for done, neutral for not-yet. */
export const STATUS_COLORS = {
  [STATUS.NO_REVIEW]: '991B1B',
  [STATUS.NEVER_BY_PERSON]: 'DC2626',
  [STATUS.LATEST_NOT_BY_PERSON]: 'EA580C',
  [STATUS.LATEST_PARTLY]: 'F59E0B',
  [STATUS.STALE]: 'FACC15',
  [STATUS.REVIEWED]: '16A34A',
  [STATUS.IN_PROGRESS]: '3B82F6',
  [STATUS.NEW]: '9CA3AF',
};

/** The statuses that mean "a person did this one properly, recently". */
const HEALTHY = new Set([STATUS.REVIEWED]);

export default {
  name: 'access-review-adoption',
  displayName: 'Access Review Adoption',
  description:
    'One row per business role with when a person last really reviewed it, longest ago first. '
    + 'A review that completed because nobody responded — Entra ID applies the default decision '
    + 'and closes it — does not count as reviewed here. Roles that have never been reviewed are '
    + 'listed apart, and roles too new to have had a review form their own category.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: [],
    properties: {
      newRoleDays: {
        type: 'integer',
        title: 'New role (days)',
        description: 'A role created within this many days that has no review yet is "New" rather '
          + 'than "No review yet".',
        default: DEFAULT_NEW_ROLE_DAYS,
      },
      staleAfterDays: {
        type: 'integer',
        title: 'Too long ago (days)',
        description: 'A role whose last review by a person is older than this is flagged, even when '
          + 'that review was done properly.',
        default: DEFAULT_STALE_AFTER_DAYS,
      },
      includeNotRequired: {
        type: 'boolean',
        title: 'Include roles that do not require a review',
        description: 'A role none of whose assignment policies requires an access review, and that has '
          + 'never had one, is left out by default: it is not missing anything.',
        default: false,
      },
    },
  },
  columns: [
    { key: 'businessRole', label: 'Business role' },
    { key: 'systemName', label: 'System' },
    { key: 'status', label: 'Status' },
    { key: 'reviewRequired', label: 'Review required' },
    { key: 'lastHumanReview', label: 'Last review by a person' },
    { key: 'daysSinceHumanReview', label: 'Days ago' },
    { key: 'lastHumanReviewer', label: 'Last reviewer' },
    { key: 'members', label: 'Members' },
    { key: 'reviews', label: 'Review rounds' },
    { key: 'humanReviews', label: 'Rounds with a person' },
    { key: 'latestReviewEnd', label: 'Latest round ended' },
    { key: 'latestReviewDecisions', label: 'Latest round: decisions' },
    { key: 'latestReviewByPerson', label: 'Latest round: by a person' },
    { key: 'latestReviewNotByPerson', label: 'Latest round: not by a person' },
    { key: 'latestReviewByPersonShare', label: 'Latest round: % by a person' },
    { key: 'defaultDecision', label: 'Default decision' },
    { key: 'roleCreated', label: 'Role created' },
  ],
  pivots: [
    {
      name: 'By status',
      rows: ['status', 'businessRole'],
      values: ['members', 'latestReviewByPerson', 'latestReviewNotByPerson'],
    },
    { name: 'By system', rows: ['systemName', 'status'], values: ['members'] },
  ],
  charts: [
    { name: 'Roles by status', type: 'pie', category: 'status', title: 'Business roles by review status', valueLabel: 'Roles', colors: STATUS_COLORS },
    { name: 'Members by status', type: 'pie', category: 'status', value: 'members', title: 'Role members by review status', valueLabel: 'Members', colors: STATUS_COLORS },
  ],

  async run(params, ctx) {
    const options = {
      newRoleDays: parseDays(params?.newRoleDays, DEFAULT_NEW_ROLE_DAYS),
      staleAfterDays: parseDays(params?.staleAfterDays, DEFAULT_STALE_AFTER_DAYS),
      now: new Date(),
    };
    const { rows: all } = await db.query(ROLE_REVIEW_SQL);
    const { kept: roles, left } = splitNotRequired(all, isTrue(params?.includeNotRequired));
    const rows = roles.map(role => buildRow(role, options)).sort(compareRows);
    ctx?.log?.(`access-review-adoption report: ${rows.length} business role(s), ${left} left out`);
    return { rows, notices: [...summaries(rows, roles, options), ...leftOutNotice(left)] };
  },
};

/** A query-string boolean: only an actual true, or the text "true", turns it on. */
export function isTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/**
 * Whether a role is known not to need a review: it has assignment policies,
 * none of them requires an access review, and it has never had one. A role
 * with no policy data at all is NOT this — its source may simply not say — and
 * a role that was reviewed anyway stays, because that review is a fact.
 */
export function reviewNotRequired(role) {
  return role.policies > 0 && role.reviewRequired === false && !role.reviews;
}

/** The roles to report on, and how many were left out as not requiring a review. */
export function splitNotRequired(roles, include) {
  if (include) return { kept: roles, left: 0 };
  const kept = roles.filter(r => !reviewNotRequired(r));
  return { kept, left: roles.length - kept.length };
}

function leftOutNotice(left) {
  if (!left) return [];
  return [{
    severity: 'info',
    text: `${left} business role(s) left out because none of their policies requires an access review `
      + 'and they have never had one. Turn on "Include roles that do not require a review" to show them.',
  }];
}

/** What a role's policies say about reviews, as the reader sees it. */
export function reviewRequiredLabel(role) {
  if (!role.policies) return null;
  if (role.reviewRequired === true) return 'Yes';
  if (role.reviewRequired === false) return 'No';
  return null;
}

// ─── The one read ─────────────────────────────────────────────────────────

// Every business role, with its review history folded per round: how many
// rounds, how many of them a person took part in, when a person last decided,
// and the latest round's split. A round is one review instance (Entra) or one
// campaign (midPoint); see reviewRoundKeySql. Members are distinct holders, so
// the governed model's intent+actual pair counts one person once.
export const ROLE_REVIEW_SQL = `
  WITH roles AS (
    SELECT r.id, r."displayName", r."createdDateTime", s."displayName" AS "systemName"
      FROM "Resources" r
      LEFT JOIN "Systems" s ON s.id = r."systemId"
     WHERE r."resourceType" = 'BusinessRole'
       AND r."deletedAt" IS NULL
  ),
  decisions AS (
    SELECT d."resourceId",
           ${reviewRoundKeySql('d')} AS round,
           d."reviewInstanceStatus" AS status,
           d."reviewInstanceEndDateTime" AS "endsAt",
           d."reviewedDateTime",
           d."reviewedByDisplayName",
           d."extendedAttributes"->>'defaultDecision' AS "defaultDecision",
           ${humanDecisionSql('d')} AS human
      FROM "CertificationDecisions" d
      JOIN roles ON roles.id = d."resourceId"
  ),
  rounds AS (
    SELECT "resourceId", round,
           MAX("endsAt") AS "endsAt",
           MAX(status) AS status,
           COUNT(*)::int AS decisions,
           COUNT(*) FILTER (WHERE human)::int AS "byPerson",
           MAX("reviewedDateTime") FILTER (WHERE human) AS "lastHumanAt",
           MAX("defaultDecision") AS "defaultDecision"
      FROM decisions
     GROUP BY "resourceId", round
  ),
  latest AS (
    SELECT DISTINCT ON ("resourceId") *
      FROM rounds
     ORDER BY "resourceId", "endsAt" DESC NULLS LAST, round DESC
  ),
  history AS (
    SELECT "resourceId",
           COUNT(*)::int AS reviews,
           COUNT(*) FILTER (WHERE "byPerson" > 0)::int AS "humanReviews",
           MAX("lastHumanAt") AS "lastHumanAt"
      FROM rounds
     GROUP BY "resourceId"
  ),
  reviewer AS (
    SELECT DISTINCT ON ("resourceId") "resourceId", "reviewedByDisplayName"
      FROM decisions
     WHERE human
     ORDER BY "resourceId", "reviewedDateTime" DESC NULLS LAST
  ),
  members AS (
    SELECT ra."resourceId", COUNT(DISTINCT COALESCE(ra."principalId", ra."identityId"))::int AS members
      FROM "ResourceAssignments" ra
      JOIN roles ON roles.id = ra."resourceId"
     WHERE ra."deletedAt" IS NULL
     GROUP BY ra."resourceId"
  ),
  policies AS (
    SELECT p."resourceId", COUNT(*)::int AS policies, bool_or(p."hasAccessReview") AS "reviewRequired"
      FROM "AssignmentPolicies" p
      JOIN roles ON roles.id = p."resourceId"
     GROUP BY p."resourceId"
  )
  SELECT roles.id, roles."displayName", roles."systemName", roles."createdDateTime",
         COALESCE(h.reviews, 0) AS reviews,
         COALESCE(h."humanReviews", 0) AS "humanReviews",
         h."lastHumanAt",
         l."endsAt" AS "latestEndsAt",
         l.status AS "latestStatus",
         l.decisions AS "latestDecisions",
         l."byPerson" AS "latestByPerson",
         l."defaultDecision",
         rv."reviewedByDisplayName" AS "lastHumanReviewer",
         COALESCE(m.members, 0) AS members,
         COALESCE(pol.policies, 0) AS policies,
         pol."reviewRequired"
    FROM roles
    LEFT JOIN history h ON h."resourceId" = roles.id
    LEFT JOIN latest l ON l."resourceId" = roles.id
    LEFT JOIN reviewer rv ON rv."resourceId" = roles.id
    LEFT JOIN members m ON m."resourceId" = roles.id
    LEFT JOIN policies pol ON pol."resourceId" = roles.id
   ORDER BY roles."displayName", roles.id`;

// ─── Classification ───────────────────────────────────────────────────────

/** Whether the role was created within `days` of `now`; unknown creation = not new. */
export function isNewRole(createdDateTime, days, now) {
  if (!createdDateTime) return false;
  const created = new Date(createdDateTime);
  return !Number.isNaN(created.getTime()) && daysBetween(created, now) < days;
}

/**
 * The role's status from its folded history. Pure, so every branch can be hit
 * with a hand-made row; the order of the checks is the order of the doc comment
 * at the top of this file.
 */
export function classify(role, { newRoleDays, staleAfterDays, now }) {
  if (!role.reviews) return isNewRole(role.createdDateTime, newRoleDays, now) ? STATUS.NEW : STATUS.NO_REVIEW;
  if (reviewRoundOpen({ endsAt: role.latestEndsAt, status: role.latestStatus }, now)) return STATUS.IN_PROGRESS;
  if (!role.humanReviews) return STATUS.NEVER_BY_PERSON;
  if (!role.latestByPerson) return STATUS.LATEST_NOT_BY_PERSON;
  if (role.latestByPerson < role.latestDecisions) return STATUS.LATEST_PARTLY;
  if (daysBetween(new Date(role.lastHumanAt), now) > staleAfterDays) return STATUS.STALE;
  return STATUS.REVIEWED;
}

/** `n` as a whole-number percentage of `total`, or null when there is nothing to divide. */
export function share(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : null;
}

/** One row: the role, its status, and the numbers the status was read from. */
export function buildRow(role, options) {
  const latestDecisions = role.latestDecisions ?? null;
  const latestByPerson = role.latestDecisions == null ? null : (role.latestByPerson ?? 0);
  return {
    businessRole: role.displayName,
    systemName: role.systemName ?? null,
    status: classify(role, options),
    reviewRequired: reviewRequiredLabel(role),
    lastHumanReview: role.lastHumanAt ? toDateOnly(role.lastHumanAt) : null,
    daysSinceHumanReview: role.lastHumanAt ? daysBetween(new Date(role.lastHumanAt), options.now) : null,
    lastHumanReviewer: role.lastHumanReviewer ?? null,
    members: role.members ?? 0,
    reviews: role.reviews ?? 0,
    humanReviews: role.humanReviews ?? 0,
    latestReviewEnd: role.latestEndsAt ? toDateOnly(role.latestEndsAt) : null,
    latestReviewDecisions: latestDecisions,
    latestReviewByPerson: latestByPerson,
    latestReviewNotByPerson: latestDecisions == null ? null : latestDecisions - latestByPerson,
    latestReviewByPersonShare: latestDecisions == null ? null : share(latestByPerson, latestDecisions),
    defaultDecision: role.defaultDecision ?? null,
    roleCreated: role.createdDateTime ? toDateOnly(role.createdDateTime) : null,
    _entity: { kind: 'access-package', id: role.id },
  };
}

/**
 * Worst status first; inside a status the last review by a person longest ago
 * first, with "never" ahead of any date; then by name so runs compare.
 */
export function compareRows(a, b) {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (byStatus) return byStatus;
  const aDate = a.lastHumanReview ?? '';
  const bDate = b.lastHumanReview ?? '';
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  return String(a.businessRole ?? '').localeCompare(String(b.businessRole ?? ''));
}

// ─── The summaries ────────────────────────────────────────────────────────

const n = value => value.toLocaleString('en-US');

/** What the rows add up to, and the rule they were judged by. */
export function summaries(rows, roles, { newRoleDays, staleAfterDays }) {
  if (rows.length === 0) {
    return [{ severity: 'info', text: 'No business roles have been synced yet.' }];
  }
  const count = status => rows.filter(r => r.status === status).length;
  const healthy = rows.filter(r => HEALTHY.has(r.status)).length;
  const reviewed = rows.filter(r => r.reviews > 0).length;
  const notices = [
    {
      severity: 'info',
      text: `${n(rows.length)} business role(s): ${n(healthy)} reviewed by a person in the latest round `
        + `(${share(healthy, rows.length)}%), ${n(count(STATUS.NEVER_BY_PERSON))} never reviewed by a person, `
        + `${n(count(STATUS.NO_REVIEW))} never reviewed at all, ${n(count(STATUS.NEW))} new (under ${newRoleDays} days).`,
    },
    {
      severity: 'info',
      text: 'A decision counts as a person\'s only when a reviewer is recorded on it and the decision is not '
        + '"not reviewed". A round Entra ID completed by applying the default decision has no reviewer and '
        + `does not count. "Too long ago" is more than ${staleAfterDays} days.`,
    },
  ];
  if (reviewed === 0) {
    notices.push({
      severity: 'warning',
      text: 'No access review decisions have been synced for any business role. Either no reviews are held, '
        + 'or the crawler lacks the permission to read them (AccessReview.Read.All for Entra ID).',
    });
  }
  if (roles.every(r => !r.createdDateTime)) {
    notices.push({
      severity: 'info',
      text: 'No business role carries a creation date, so none can be told apart as new.',
    });
  }
  return notices;
}
