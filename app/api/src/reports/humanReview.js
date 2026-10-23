// What counts as a review decision a PERSON made.
//
// A certification decision row says a review was held and what came out of it.
// It does not, by itself, say whether anyone looked. Entra ID access reviews
// complete without a reviewer: when nobody acts before the deadline the review
// still ends, the configured default ("If reviewers don't respond": approve,
// deny, follow the recommendation) is applied, and the decision row then reads
// Approve or Deny like any other. Every compliance number built on
// `decision <> 'NotReviewed'` therefore reports those reviews as done — which is
// exactly the adoption question nobody can answer from them.
//
// So the rule here is stricter than "a decision exists". A decision was made by
// a person when:
//   1. it is a decision at all — not one of the source's "nobody answered"
//      values (Entra `NotReviewed` / `NotNotified`, midPoint `NoDecision` /
//      `NoResponse`); and
//   2. the reviewer is a person, not the platform — Entra stamps system-applied
//      decisions with the all-zero reviewer id and a display name such as
//      "AAD Access Reviews" / "Microsoft Entra ID Access Reviews"; and
//   3. there IS a reviewer — an id, or at least a name (a CSV source may carry
//      only the name; a midPoint reviewer who is not a synced principal carries
//      neither, and is then — conservatively — not counted).
//
// Shared by every report that reasons about review adoption, so the definition
// cannot drift between the per-role view and the per-reviewer view.

/** The source values that mean "the reviewer did not answer", across crawlers. */
export const NON_DECISION_VALUES = ['NotReviewed', 'NotNotified', 'NoDecision', 'NoResponse'];

/** The reviewer id Entra ID stamps on a decision the platform applied itself. */
export const SYSTEM_REVIEWER_ID = '00000000-0000-0000-0000-000000000000';

/** Decision values that keep access, across crawlers (Entra, CSV, midPoint). */
export const APPROVAL_VALUES = ['Approve', 'Approved', 'Certify'];

/** Decision values that take access away, across crawlers. */
export const DENIAL_VALUES = ['Deny', 'Denied', 'Revoke', 'Reduce'];

const sqlList = values => values.map(v => `'${v}'`).join(', ');

/**
 * A SQL boolean expression: this decision row was decided by a person.
 * `alias` is the CertificationDecisions alias in the caller's query. Constant-
 * folded (no bind parameters), so callers keep their own `$n` numbering.
 */
export function humanDecisionSql(alias = 'd') {
  return `(${alias}.decision IS NOT NULL
      AND ${alias}.decision NOT IN (${sqlList(NON_DECISION_VALUES)})
      AND COALESCE(${alias}."reviewedBy" <> '${SYSTEM_REVIEWER_ID}'::uuid, TRUE)
      AND (${alias}."reviewedBy" IS NOT NULL OR COALESCE(${alias}."reviewedByDisplayName", '') <> '')
      AND COALESCE(${alias}."reviewedByDisplayName", '') NOT ILIKE '%access reviews%')`;
}

/** A SQL boolean expression: this decision keeps the access. */
export function approvalSql(alias = 'd') {
  return `${alias}.decision IN (${sqlList(APPROVAL_VALUES)})`;
}

/** A SQL boolean expression: this decision removes the access. */
export function denialSql(alias = 'd') {
  return `${alias}.decision IN (${sqlList(DENIAL_VALUES)})`;
}

/**
 * The key one review round is grouped under. Entra gives every round an
 * instance id; midPoint stores the campaign in `extendedAttributes` instead and
 * leaves the instance id empty, and a CSV may carry neither — in which case all
 * of a role's decisions are one round.
 */
export function reviewRoundKeySql(alias = 'd') {
  return `COALESCE(${alias}."reviewInstanceId"::text, ${alias}."extendedAttributes"->>'campaignOid', '')`;
}

/**
 * Whether a review round is still open: its end date is in the future, or its
 * status says it has not finished. A round with no end date and no telling
 * status is treated as finished — that is what every imported snapshot of a
 * past campaign looks like.
 */
export function reviewRoundOpen({ endsAt, status }, now = new Date()) {
  if (endsAt && new Date(endsAt).getTime() > now.getTime()) return true;
  return OPEN_STATUSES.has(String(status || '').toLowerCase());
}

const OPEN_STATUSES = new Set(['notstarted', 'initializing', 'inprogress', 'in_progress', 'in progress', 'active', 'open']);
