// Phase helpers for GET /api/user/:id, extracted from details/user.js so the
// handler (cognitive 33 — a long sequence of independent attribute/count
// fetches) stays under the complexity threshold. Each fetch keeps its own
// try/catch (swallow a missing optional table, rethrow anything else to the
// handler's 500). Covered through details.test.js. SQL moved verbatim.

import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { cleanRow, countHistory } from './shared.js';

// 1. Current attributes from Principals (+ parsed extendedAttributes). Returns
//    null when the user doesn't exist (handler → 404).
export async function fetchUserAttributes(pool, res, userId) {
  const userResult = await timedQuery(pool, 'user-attributes', res, `SELECT p.*, s."displayName" AS "systemDisplayName"
              FROM "Principals" p
              LEFT JOIN "Systems" s ON p."systemId" = s.id
              WHERE p.id = $1`, [userId]);
  if (userResult.rows.length === 0) return null;
  const attributes = cleanRow(userResult.rows[0]);
  if (attributes.extendedAttributes) {
    attributes.extendedAttributesParsed = parseJsonbColumn(attributes.extendedAttributes);
  }
  return attributes;
}

// 1b. Risk score — stored in RiskScores keyed by (entityId, entityType). Merge
//     onto attributes so the detail page's Risk tab can render.
export async function mergeUserRiskScore(attributes, userId) {
  try {
    const rs = await db.query(
      `SELECT "riskScore", "riskTier", "riskDirectScore", "riskMembershipScore",
              "riskStructuralScore", "riskPropagatedScore", "riskExplanation",
              "riskClassifierMatches", "riskOverride", "riskOverrideReason", "riskScoredAt"
         FROM "RiskScores"
        WHERE "entityId"::text = $1 AND "entityType" = 'Principal'
        LIMIT 1`,
      [userId]
    );
    if (rs.rows.length > 0) Object.assign(attributes, cleanRow(rs.rows[0]));
  } catch (e) { if (!isMissingSchema(e)) throw e; /* RiskScores may not exist on older deployments */ }
}

// 2. Tags
export async function fetchUserTags(pool, res, userId) {
  try {
    const r = await timedQuery(pool, 'user-tags', res, `
        SELECT t.id, t."name", t."color"
          FROM "GraphTagAssignments" ta
          JOIN "GraphTags" t ON ta."tagId" = t.id
         WHERE ta."entityId" = $1 AND t."entityType" = 'user'
      `, [userId]);
    return r.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; return []; /* table may not exist */ }
}

// 3. Membership count, broken down by the universal membershipType.
export async function fetchMembershipBreakdown(pool, res, userId) {
  const membershipByType = { Direct: 0, Indirect: 0, Eligible: 0 };
  let membershipCount = 0;
  try {
    const r = await timedQuery(pool, 'user-membership-breakdown', res, `SELECT "membershipType",
                     COUNT(DISTINCT "resourceId")::int AS cnt
                FROM "vw_ResourceUserPermissionAssignments"
               WHERE "principalId"::text = $1
               GROUP BY "membershipType"`, [userId]);
    for (const row of r.rows) {
      if (row.membershipType in membershipByType) membershipByType[row.membershipType] = row.cnt;
    }
    membershipCount = Object.values(membershipByType).reduce((a, b) => a + b, 0);
  } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }
  return { membershipCount, membershipByType };
}

// 3b. Access-package count (governance resources assigned to the user).
export async function fetchUserAccessPackageCount(pool, res, userId) {
  try {
    const r = await timedQuery(pool, 'user-ap-count', res, `SELECT COUNT(DISTINCT ra."resourceId")::int AS cnt
                FROM "ResourceAssignments" ra
                JOIN "Resources" r ON r.id = ra."resourceId"
               WHERE ra."principalId"::text = $1
                 AND r."governanceResource"`, [userId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// History count (v5: the _history audit table).
export async function fetchUserHistoryCount(userId) {
  try { return await countHistory('Principals', userId); }
  catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* _history may not exist */ }
}

// OAuth2-grant count (retired assignmentType — best-effort on older deployments).
export async function fetchOauth2GrantCount(pool, res, userId) {
  try {
    const r = await timedQuery(pool, 'user-oauth2-grant-count', res, `SELECT COUNT(*)::int AS cnt
                FROM "ResourceAssignments"
               WHERE "principalId"::text = $1 AND "assignmentType" = 'OAuth2Grant'`, [userId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* column may not exist on older deployments */ }
}

// Direct-report count (cheap query on the managerId FK).
export async function fetchDirectReportCount(pool, res, userId) {
  try {
    const r = await timedQuery(pool, 'user-reports-count', res,
      `SELECT COUNT(*)::int AS cnt FROM "Principals" WHERE "managerId" = $1`, [userId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* managerId may not exist on older deployments */ }
}

// Context-membership count (v6 — direct Principal membership OR via linked Identity).
export async function fetchUserContextCount(pool, res, userId) {
  try {
    const r = await timedQuery(pool, 'user-context-count', res, `SELECT COUNT(DISTINCT cm."contextId")::int AS cnt
                FROM "ContextMembers" cm
               WHERE (cm."memberType" = 'Principal' AND cm."memberId"::text = $1)
                  OR (cm."memberType" = 'Identity'  AND cm."memberId"::text IN (
                        SELECT im."identityId"::text FROM "IdentityMembers" im
                         WHERE im."principalId"::text = $1))`, [userId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* ContextMembers may not exist on older deployments */ }
}

// Principal→principal relationships (migration 057): the four directional counts,
// plus the "linked resource" (the enterprise-app Resource an AI agent / service
// principal shares its id with). Both best-effort — absent on older deployments.
export async function fetchPrincipalRelationships(pool, userId, res) {
  const counts = { ownerCount: 0, sponsorCount: 0, ownedAgentCount: 0, sponsoredGuestCount: 0 };
  try {
    const r = await timedQuery(pool, 'user-principal-relationships', res, `SELECT
                COUNT(*) FILTER (WHERE "principalId"::text = $1        AND "relationshipType" = 'Owner')::int   AS "ownerCount",
                COUNT(*) FILTER (WHERE "principalId"::text = $1        AND "relationshipType" = 'Sponsor')::int AS "sponsorCount",
                COUNT(*) FILTER (WHERE "relatedPrincipalId"::text = $1 AND "relationshipType" = 'Owner')::int   AS "ownedAgentCount",
                COUNT(*) FILTER (WHERE "relatedPrincipalId"::text = $1 AND "relationshipType" = 'Sponsor')::int AS "sponsoredGuestCount"
                FROM "PrincipalRelationships"
               WHERE "principalId"::text = $1 OR "relatedPrincipalId"::text = $1`, [userId]);
    Object.assign(counts, r.rows[0] || {});
  } catch (e) { if (!isMissingSchema(e)) throw e; /* PrincipalRelationships may not exist on older deployments */ }

  let linkedResource = null;
  try {
    const r = await timedQuery(pool, 'user-linked-resource', res, `SELECT id, "displayName", "resourceType"
                FROM "Resources"
               WHERE id = $1 AND "resourceType" = 'Application'
               LIMIT 1`, [userId]);
    if (r.rows.length > 0) linkedResource = r.rows[0];
  } catch (e) { if (!isMissingSchema(e)) throw e; /* Resources always exists, but be defensive */ }

  return { ...counts, linkedResource };
}
