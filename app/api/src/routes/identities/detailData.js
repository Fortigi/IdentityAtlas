// Phase helpers for GET /api/identities/:id, extracted from identities/detail.js
// so the handler (cognitive 19) stays under the complexity threshold. Optional
// sections swallow a missing table and rethrow anything else to the handler's
// 500. Covered through identities.coverage.test.js + identityDetail.contract.test.js.
// SQL moved verbatim.

import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';

// Fetch the identity row. Returns null when it doesn't exist (handler → 404).
export async function fetchIdentity(p, res, identityId) {
  const identityResult = await timedQuery(p, 'identity-detail', res,
    `SELECT i.* FROM "Identities" i WHERE i.id = $1`, [identityId]);
  return identityResult.rows.length === 0 ? null : identityResult.rows[0];
}

// All member accounts from Principals (v5), coalescing displayName / UPN.
export async function fetchIdentityMembers(p, res, identityId) {
  const membersResult = await timedQuery(p, 'identity-members', res, `
        SELECT m."identityId", m."principalId", m."isPrimary", m."isHrAuthoritative",
               m."accountType", m."accountTypePattern", m."accountEnabled",
               m."linkSignals", m."linkConfidence", m."hrScore",
               m."hrIndicators", m."analystOverride",
               COALESCE(m."displayName", u."displayName") AS "displayName",
               u.email AS "userPrincipalName",
               u.department, u."jobTitle", u."createdDateTime",
               u."accountEnabled" AS "userAccountEnabled"
        FROM "IdentityMembers" m
        LEFT JOIN "Principals" u ON m."principalId" = u.id
        WHERE m."identityId" = $1
        ORDER BY m."isPrimary" DESC NULLS LAST, m."accountType" ASC
      `, [identityId]);
  return membersResult.rows;
}

// Per-account risk scores (optional).
export async function fetchMemberRisks(p, res, identityId) {
  try {
    const riskResult = await timedQuery(p, 'identity-member-risks', res, `
          SELECT m."principalId", u."riskScore", u."riskTier"
          FROM "IdentityMembers" m
          LEFT JOIN "Principals" u ON m."principalId" = u.id
          WHERE m."identityId" = $1
        `, [identityId]);
    return riskResult.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; return []; /* risk columns may not exist yet */ }
}

// Per-account group-membership counts (optional).
export async function fetchMemberGroupCounts(p, res, identityId) {
  try {
    const groupCountResult = await timedQuery(p, 'identity-member-groups', res, `
        SELECT m."principalId", COUNT(DISTINCT gm."resourceId")::int AS "groupCount"
        FROM "IdentityMembers" m
        LEFT JOIN "ResourceAssignments" gm ON m."principalId" = gm."principalId" AND gm."assignmentType" = 'Direct'
        WHERE m."identityId" = $1
        GROUP BY m."principalId"
      `, [identityId]);
    return groupCountResult.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; return []; /* ResourceAssignments may not exist */ }
}

// Relationship counts aggregated across every linked account, keyed by
// assignmentType (Governed folds in governanceResource grants). The initial keys
// double as the allow-list of surfaced types.
export async function aggregateIdentityAssignments(p, res, identityId) {
  const aggregate = { Direct: 0, Indirect: 0, Governed: 0, Owner: 0, Eligible: 0, OAuth2Grant: 0 };
  try {
    const aggResult = await timedQuery(p, 'identity-aggregate-counts', res, `
        SELECT CASE WHEN gov."governanceResource" THEN 'Governed' ELSE ra."assignmentType" END AS "assignmentType",
               COUNT(DISTINCT ra."resourceId")::int AS cnt
        FROM "IdentityMembers" m
        JOIN "ResourceAssignments" ra ON ra."principalId" = m."principalId"
        LEFT JOIN "Resources" gov ON gov.id = ra."resourceId"
        WHERE m."identityId" = $1
        GROUP BY 1
      `, [identityId]);
    for (const row of aggResult.rows) {
      if (row.assignmentType in aggregate) aggregate[row.assignmentType] = row.cnt;
    }
  } catch (e) { if (!isMissingSchema(e)) throw e; /* ResourceAssignments may not exist */ }
  return aggregate;
}

// Context-membership count — direct Identity membership OR via any linked principal.
export async function fetchIdentityContextCount(p, res, identityId) {
  try {
    const r = await timedQuery(p, 'identity-context-count', res,
      `SELECT COUNT(DISTINCT cm."contextId")::int AS cnt
                FROM "ContextMembers" cm
               WHERE (cm."memberType" = 'Identity'  AND cm."memberId"::text = $1)
                  OR (cm."memberType" = 'Principal' AND cm."memberId"::text IN (
                        SELECT im."principalId"::text FROM "IdentityMembers" im
                         WHERE im."identityId"::text = $1))`, [identityId]);
    return r.rows[0]?.cnt || 0;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* ContextMembers may not exist */ }
}
