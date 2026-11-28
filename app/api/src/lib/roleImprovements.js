// The improvements step of a composition review: what role mining suggests to
// make a business role better, without AI and only when it is close to certain
// (lib/roleImprovementScoring.js holds the measure and the thresholds).
//
//   addPermission   a permission every holder of the role has themselves,
//                   nobody else has and no business role contains — or, when it
//                   appeared since the last review (else in the last 90 days),
//                   one that comes within 95% of that
//   automaticRule   the role is handed out by hand, and a rule on department,
//                   job title and/or company would pick (nearly) exactly the
//                   people who hold it
//
// A suggestion is a proposal for the reviewer to adopt or decline; nothing here
// changes the role.

import * as db from '../db/connection.js';
import { ROLE_CONTROL_SQL, roleAccessModels } from './businessRoleAccessModel.js';
import {
  MIN_CONFIDENCE, MIN_HOLDERS, RECENT_DAYS, RULE_ATTRIBUTES,
  permissionSuggestions, ruleSuggestion, sharedConditions, withoutDeclined,
} from './roleImprovementScoring.js';

export const IMPROVEMENTS = 'improvements';

// A live, delivered assignment of a live account: the role's own holder count
// (lib/businessRoleAccessModel.js holderCountSql) counts the same way.
const liveAssignment = (a) => `${a}."deletedAt" IS NULL AND (LOWER(${a}.state) = 'delivered' OR ${a}.state IS NULL)`;

// The people who hold the role, with what a rule could filter them on.
export const HOLDERS_SQL = `
    SELECT p.id, p."systemId", p."principalType", p.department, p."jobTitle", p."companyName",
           bool_or(a.origin = 'Automatic') AS automatic
      FROM "ResourceAssignments" a
      JOIN "Principals" p ON p.id = a."principalId" AND p."deletedAt" IS NULL
     WHERE a."resourceId" = $1 AND ${liveAssignment('a')}
     GROUP BY p.id`;

// Kinds of resource that are no permission to put in a role: roles themselves,
// an application (its roles and permissions are the resources), the security
// set-up of an app, consents and app-only permissions, and ownership.
export const NOT_A_PERMISSION = Object.freeze(['BusinessRole', 'Application', 'AppRegistration', 'DelegatedPermission', 'ApplicationPermission']);

// Resources held by at least $2 of the role's holders, each holding it
// themselves (Direct); with how many others hold it in any way. Leaves out what
// any business role contains already, and a group whose members a rule keeps (a
// dynamic group, such as the AutoAssignment_ group Entra makes for an automatic
// assignment policy): nobody can hand that out, so no role can contain it.
export const PERMISSION_CANDIDATES_SQL = `
    WITH holders AS (
      SELECT DISTINCT a."principalId" AS id
        FROM "ResourceAssignments" a
        JOIN "Principals" p ON p.id = a."principalId" AND p."deletedAt" IS NULL
       WHERE a."resourceId" = $1 AND ${liveAssignment('a')}
    ), shared AS (
      SELECT a."resourceId", COUNT(DISTINCT a."principalId")::int AS "membersHolding"
        FROM "ResourceAssignments" a
        JOIN holders h ON h.id = a."principalId"
       WHERE a."resourceId" <> $1 AND a."assignmentType" = 'Direct' AND ${liveAssignment('a')}
       GROUP BY a."resourceId"
      HAVING COUNT(DISTINCT a."principalId") >= $2
    )
    SELECT r.id, r."displayName", r."resourceType", r."createdDateTime", s."membersHolding",
           (SELECT COUNT(DISTINCT o."principalId")::int
              FROM "ResourceAssignments" o
              JOIN "Principals" op ON op.id = o."principalId" AND op."deletedAt" IS NULL
             WHERE o."resourceId" = r.id AND ${liveAssignment('o')}
               AND NOT EXISTS (SELECT 1 FROM holders h WHERE h.id = o."principalId")) AS "othersHolding"
      FROM shared s
      JOIN "Resources" r ON r.id = s."resourceId"
     WHERE r."deletedAt" IS NULL
       AND COALESCE(r."resourceType", '') <> ALL($3::text[])
       AND COALESCE(r."resourceType", '') NOT LIKE '%Ownership'
       AND COALESCE(r."extendedAttributes"->>'groupTypes', '') NOT ILIKE '%DynamicMembership%'
       AND NOT EXISTS (
             SELECT 1 FROM "ResourceRelationships" rr
               JOIN "Resources" br ON br.id = rr."parentResourceId" AND br."resourceType" = 'BusinessRole'
              WHERE rr."childResourceId" = r.id AND rr."relationshipType" = 'Contains')`;

// Every live user account in the holders' systems that a rule on these values
// could pick. $2..$4 are the shared department, job title and company (NULL
// when the holders share none).
export const RULE_POPULATION_SQL = `
    SELECT p.id, p.department, p."jobTitle", p."companyName"
      FROM "Principals" p
     WHERE p."deletedAt" IS NULL AND p."principalType" = 'User'
       AND p."systemId" = ANY($1::int[])
       AND (btrim(p.department) = $2 OR btrim(p."jobTitle") = $3 OR btrim(p."companyName") = $4)`;

// The newest review of the role: when it was, and what its improvements step declined.
export const LAST_REVIEW_SQL = `
    SELECT r."reviewedAt",
           COALESCE((SELECT s.proposal->'suggestions'
                       FROM "BusinessRoleCompositionReviewSteps" s
                      WHERE s."reviewId" = r.id AND s.step = '${IMPROVEMENTS}'), '[]'::jsonb) AS suggestions
      FROM "BusinessRoleCompositionReviews" r
     WHERE r."resourceId" = $1
     ORDER BY r."reviewedAt" DESC, r.id
     LIMIT 1`;

/** From when a permission counts as new: the last review, else RECENT_DAYS ago. */
export function recentSince(lastReviewedAt, now = new Date()) {
  const last = Date.parse(lastReviewedAt ?? '');
  return Number.isFinite(last) ? new Date(last) : new Date(now.getTime() - RECENT_DAYS * 86_400_000);
}

/** Is the role handed out by hand: no policy rule, and nobody holds it by one? */
export function handedOutByHand(waysIn, holders) {
  return !waysIn.includes('Rule') && !holders.some(h => h.automatic);
}

const declinedIn = (stored) =>
  (Array.isArray(stored) ? stored : []).filter(s => s?.decision === 'decline' && typeof s.key === 'string').map(s => s.key);

async function findRule(holders, pool) {
  const users = holders.filter(h => h.principalType === 'User');
  if (users.length < MIN_HOLDERS) return null;
  const conditions = sharedConditions(users);
  if (conditions.length === 0) return null;
  // Read only the accounts that share at least one of those values.
  const shared = Object.fromEntries(conditions.map(c => [c.attribute, c.value]));
  const systems = [...new Set(users.map(u => u.systemId).filter(s => s !== null && s !== undefined))];
  const { rows } = await pool.query(RULE_POPULATION_SQL, [systems, ...RULE_ATTRIBUTES.map(a => shared[a] ?? null)]);
  return ruleSuggestion(users, rows);
}

/**
 * What role mining suggests for this role right now:
 * { suggestions, declinedBefore, handedOutByHand, holderCount, since, thresholds }.
 * An empty list is an answer too: nothing came close enough.
 */
export async function findImprovements(roleId, { pool = db, now = new Date() } = {}) {
  const [holdersRes, controlRes, lastRes] = await Promise.all([
    pool.query(HOLDERS_SQL, [roleId]),
    pool.query(ROLE_CONTROL_SQL, [[roleId]]),
    pool.query(LAST_REVIEW_SQL, [roleId]),
  ]);
  const holders = holdersRes.rows;
  const last = lastRes.rows[0];
  const since = recentSince(last?.reviewedAt, now);
  const waysIn = roleAccessModels(controlRes.rows).get(roleId)?.waysIn ?? [];
  const byHand = handedOutByHand(waysIn, holders);

  let found = [];
  if (holders.length >= MIN_HOLDERS) {
    const needed = Math.ceil(holders.length * MIN_CONFIDENCE);
    const { rows } = await pool.query(PERMISSION_CANDIDATES_SQL, [roleId, needed, NOT_A_PERMISSION]);
    found = permissionSuggestions(rows, { holderCount: holders.length, since });
    const rule = byHand ? await findRule(holders, pool) : null;
    if (rule) found.push(rule);
  }
  const { suggestions, declinedBefore } = withoutDeclined(found, declinedIn(last?.suggestions));
  return {
    suggestions,
    declinedBefore,
    handedOutByHand: byHand,
    holderCount: holders.length,
    since: since.toISOString(),
    thresholds: { confidence: Math.round(MIN_CONFIDENCE * 100), holders: MIN_HOLDERS, recentDays: RECENT_DAYS },
  };
}
