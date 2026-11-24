// How a business role is gained and lost, from its assignment policies.
//
// Two separate questions, each with any number of answers: a role can be both
// requested and assigned by an administrator, and lost through a removal rule
// as well as a review. The vocabularies are declared in ontology/core.ttl
// (ia:AccessWayIn, ia:AccessWayOut); a guard test keeps the two in step.
//
// Unknown is an answer of its own: the source does not say. A policy column is
// NULL when that is the case, so "no" and "not stated" stay different. A role
// whose policies state that nothing removes access has an empty waysOut.

export const WAYS_IN = Object.freeze(['Rule', 'Request', 'Assigned']);
export const WAYS_OUT = Object.freeze(['Rule', 'Review', 'Expiry', 'Manual']);
export const UNKNOWN_WAY = 'Unknown';

// The primary distinction. Automatic: only a rule hands the role out and a rule
// takes it away, so nobody decides anything. Manual: anything else, which needs
// a regular review of at least the part that is not automatic.
export const CONTROLS = Object.freeze(['Automatic', 'Manual', 'Unknown']);

// One row per role. BOOL_OR skips NULLs and is NULL when every policy is, which
// is exactly "true if any policy says so, NULL if none says anything".
export const ACCESS_MODEL_AGGREGATES = `
  BOOL_OR("hasAutoAddRule")         AS "inRule",
  BOOL_OR("allowsRequest")          AS "inRequest",
  BOOL_OR("allowsDirectAssignment") AS "inAssigned",
  BOOL_OR("hasAutoRemoveRule")      AS "outRule",
  BOOL_OR("hasAccessReview")        AS "outReview",
  BOOL_OR("hasExpiration")          AS "outExpiry",
  BOOL_OR("allowsRemovalRequest")   AS "outManual"`;

const IN_FLAGS = { Rule: 'inRule', Request: 'inRequest', Assigned: 'inAssigned' };
const OUT_FLAGS = { Rule: 'outRule', Review: 'outReview', Expiry: 'outExpiry', Manual: 'outManual' };

const held = (ways, flags, row) => ways.filter(way => row[flags[way]] === true);
const anyStated = (flags, row) => Object.values(flags).some(flag => row[flag] === true || row[flag] === false);

// { waysIn, waysOut } from a row of ACCESS_MODEL_AGGREGATES plus policyCount.
export function deriveAccessModel(row) {
  if (!row || !(row.policyCount > 0)) return { waysIn: [UNKNOWN_WAY], waysOut: [UNKNOWN_WAY] };
  const waysIn = held(WAYS_IN, IN_FLAGS, row);
  const waysOut = held(WAYS_OUT, OUT_FLAGS, row);
  return {
    waysIn: waysIn.length > 0 ? waysIn : [UNKNOWN_WAY],
    waysOut: waysOut.length > 0 || anyStated(OUT_FLAGS, row) ? waysOut : [UNKNOWN_WAY],
  };
}

// { control, reviewRequired, reviewGap } from { waysIn, waysOut }. A rule that adds
// without removing is Manual: someone has to take the access away again.
export function deriveControl({ waysIn = [], waysOut = [] } = {}) {
  if (waysIn.length === 0 || waysIn.includes(UNKNOWN_WAY)) {
    return { control: 'Unknown', reviewRequired: false, reviewGap: false };
  }
  const ruleOnly = waysIn.length === 1 && waysIn[0] === 'Rule';
  if (ruleOnly && waysOut.includes('Rule')) return { control: 'Automatic', reviewRequired: false, reviewGap: false };
  if (ruleOnly && waysOut.includes(UNKNOWN_WAY)) return { control: 'Unknown', reviewRequired: false, reviewGap: false };
  return { control: 'Manual', reviewRequired: true, reviewGap: !waysOut.includes('Review') };
}

// The ways in and out and the primary type of each of these roles.
export const ROLE_CONTROL_SQL = `
    SELECT "resourceId", COUNT(*)::int AS "policyCount", ${ACCESS_MODEL_AGGREGATES}
      FROM "AssignmentPolicies"
     WHERE "resourceId" = ANY($1::uuid[])
     GROUP BY "resourceId"`;

// How many people hold a role and how many resources it contains, counted the
// same way on the list and on the role's page. A holder is a live, delivered
// assignment of a live account, counted once however it is held (Direct and
// Eligible are one person); a resource deleted in the source is history.
// `roleId` is the SQL for the role's id.
export const holderCountSql = (roleId) => `(
    SELECT COUNT(DISTINCT a."principalId")::int
      FROM "ResourceAssignments" a
     WHERE a."resourceId" = ${roleId}
       AND a."deletedAt" IS NULL
       AND (LOWER(a.state) = 'delivered' OR a.state IS NULL)
       AND NOT EXISTS (SELECT 1 FROM "Principals" p
                        WHERE p.id = a."principalId" AND p."deletedAt" IS NOT NULL))`;

export const resourceCountSql = (roleId) => `(
    SELECT COUNT(DISTINCT rrs."childResourceId")::int
      FROM "ResourceRelationships" rrs
     WHERE rrs."parentResourceId" = ${roleId} AND rrs."relationshipType" = 'Contains'
       AND NOT EXISTS (SELECT 1 FROM "Resources" r
                        WHERE r.id = rrs."childResourceId" AND r."deletedAt" IS NOT NULL))`;

/** resourceId → { waysIn, waysOut, control, reviewRequired, reviewGap }, as the list sends. Pure. */
export function roleAccessModels(rows) {
  return new Map(rows.map((r) => {
    const model = deriveAccessModel(r);
    return [r.resourceId, { ...model, ...deriveControl(model) }];
  }));
}

// A person is held automatically when a policy both adds and removes them by
// rule. Everyone else is the part a review has to cover.
export const isAutomaticHolder = ({ via } = {}) =>
  Array.isArray(via) && via.some(p => p.inRule === true && p.outRule === true);

const ORIGIN_WAY = { Automatic: 'Rule', Requested: 'Request' };

// How one person holds the role: the ways in of the policies behind their
// assignment (`via`: rows with inRule / inRequest / inAssigned). One policy can
// allow two ways, and then the assignment's origin says which one this was. No
// policy on the row falls back to the origin alone.
export function deriveHowHeld({ via, origin } = {}) {
  const policies = Array.isArray(via) ? via : [];
  const ways = WAYS_IN.filter(way => policies.some(p => p[IN_FLAGS[way]] === true));
  const fromOrigin = ORIGIN_WAY[origin];
  if (ways.length === 0) return [fromOrigin ?? UNKNOWN_WAY];
  if (policies.length === 1 && ways.length > 1 && ways.includes(fromOrigin)) return [fromOrigin];
  return ways;
}
