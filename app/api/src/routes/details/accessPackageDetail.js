// Phase helpers for GET /api/access-package/:id, extracted from
// details/accessPackage.js so the handler — a long sequence of independent
// count/attribute fetches — stays under the complexity threshold. Each fetch
// keeps its own try/catch (swallow a missing
// optional table, rethrow anything else to the handler's 500). The two pure
// derivations are unit-tested directly in accessPackageDetail.test.js; the SQL
// is moved VERBATIM — no behaviour change.

import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { cleanRow, countHistory } from './shared.js';

// 1. Current attributes + catalog name. Returns the cleaned attribute row, or
//    null when the access package doesn't exist (handler → 404).
export async function fetchApAttributes(pool, res, apId) {
  let apResult;
  try {
    apResult = await timedQuery(pool, 'ap-attributes', res, `
      SELECT ap.*, c."displayName" AS "catalogName"
      FROM "Resources" ap
      LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
      WHERE ap.id = $1 AND ap."resourceType" = 'BusinessRole'
    `, [apId]);
  } catch {
    // GovernanceCatalogs may not exist — fall back to AP-only query
    apResult = await timedQuery(pool, 'ap-attributes', res,
      `SELECT * FROM "Resources" WHERE id = $1 AND "resourceType" = 'BusinessRole'`, [apId]);
  }
  if (apResult.rows.length === 0) return null;
  return cleanRow(apResult.rows[0]);
}

// 2. Assignment count
export async function fetchAssignmentCount(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-assignment-count', res,
      `SELECT COUNT(*)::int AS cnt FROM "ResourceAssignments" WHERE "resourceId" = $1`, [apId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 3. Group count (resources linked to this AP)
export async function fetchGroupCount(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-group-count', res, `
      SELECT COUNT(DISTINCT "childResourceId")::int AS cnt
      FROM "ResourceRelationships"
      WHERE "parentResourceId" = $1 AND "relationshipType" = 'Contains'
    `, [apId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 4. Review count
export async function fetchReviewCount(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-review-count', res,
      `SELECT COUNT(*)::int AS cnt FROM "CertificationDecisions" WHERE "resourceId" = $1`, [apId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 5. Pending request count — COUNT only (cheap); full rows are lazy-loaded.
export async function fetchPendingRequestCount(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-pending-request-count', res, `
      SELECT COUNT(*)::int AS cnt FROM "AssignmentRequests"
      WHERE "resourceId" = $1 AND "requestState" = 'PendingApproval'
    `, [apId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return null; /* table may not exist */ }
}

// 5b. Last review date + reviewer
export async function fetchLastReview(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-last-review-date', res, `
      SELECT "reviewedDateTime", "reviewedByDisplayName"
      FROM "CertificationDecisions"
      WHERE "resourceId" = $1 AND decision IS NOT NULL AND decision <> 'NotReviewed'
      ORDER BY "reviewedDateTime" DESC
    `, [apId]);
    return {
      lastReviewDate: r.rows[0]?.reviewedDateTime || null,
      lastReviewedBy: r.rows[0]?.reviewedByDisplayName || null,
    };
  } catch (e) { if (!isMissingSchema(e)) throw e; return { lastReviewDate: null, lastReviewedBy: null }; }
}

// 5c. Compliance status of the latest review instance — the same calculated
//     "Review Status" the Business Roles list shows (mirrors LAST_REVIEW_CTE in
//     governance.js, scoped to one resource). Derivation is pure (below).
export async function fetchComplianceStatus(apId, now = new Date()) {
  try {
    const r = await db.query(`
      WITH li AS (
        SELECT "reviewInstanceId", "reviewInstanceEndDateTime"
          FROM "CertificationDecisions"
         WHERE "resourceId"::text = $1
         ORDER BY "reviewInstanceEndDateTime" DESC NULLS LAST
         LIMIT 1
      )
      SELECT li."reviewInstanceEndDateTime" AS deadline,
             SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END)::int AS "notReviewed",
             SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime"::date > li."reviewInstanceEndDateTime"::date THEN 1 ELSE 0 END)::int AS late
        FROM li JOIN "CertificationDecisions" d
          ON d."resourceId"::text = $1 AND d."reviewInstanceId" = li."reviewInstanceId"
       GROUP BY li."reviewInstanceEndDateTime"`, [apId]);
    return deriveCompliance(r.rows[0], now);
  } catch (e) { if (!isMissingSchema(e)) throw e; return { complianceStatus: null, daysOverdue: 0 }; }
}

// Pure: turn one compliance-summary row into {complianceStatus, daysOverdue}.
export function deriveCompliance(row, now = new Date()) {
  if (!row) return { complianceStatus: null, daysOverdue: 0 };
  const deadline = row.deadline ? new Date(row.deadline) : null;
  const overdue = deadline && deadline < now;
  let complianceStatus;
  if (row.notReviewed === 0 && row.late === 0) complianceStatus = 'Compliant';
  else if (row.notReviewed > 0 && !overdue) complianceStatus = 'In Progress';
  else if (row.notReviewed > 0 && overdue) complianceStatus = 'Missed';
  else complianceStatus = 'Reviewed Late';
  let daysOverdue = 0;
  if (deadline && overdue) daysOverdue = Math.floor((now.getTime() - deadline.getTime()) / 86400000);
  return { complianceStatus, daysOverdue };
}

// 6. Policy summary — auto-assigned vs request-based vs auto-removal
export async function fetchPolicySummary(pool, res, apId) {
  try {
    const r = await timedQuery(pool, 'ap-policy-summary', res, `
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN "hasAutoAddRule" = TRUE THEN 1 ELSE 0 END)::int AS "autoAdd",
        SUM(CASE WHEN COALESCE("hasAutoAddRule", FALSE) = FALSE AND "hasAutoRemoveRule" = TRUE THEN 1 ELSE 0 END)::int AS "autoRemoveOnly"
      FROM "AssignmentPolicies"
      WHERE "resourceId" = $1
    `, [apId]);
    return {
      policyCount: r.rows[0].total,
      autoAddPolicyCount: r.rows[0].autoAdd,
      autoRemovePolicyCount: r.rows[0].autoRemoveOnly,
    };
  } catch (e) { if (!isMissingSchema(e)) throw e; return { policyCount: 0, autoAddPolicyCount: 0, autoRemovePolicyCount: 0 }; }
}

// Pure: derive the assignment-type label from the policy summary counts.
export function deriveAssignmentType({ policyCount, autoAddPolicyCount, autoRemovePolicyCount }) {
  if (policyCount <= 0) return null;
  const requestBasedCount = policyCount - autoAddPolicyCount - autoRemovePolicyCount;
  if (autoAddPolicyCount > 0 && (requestBasedCount > 0 || autoRemovePolicyCount > 0)) return 'Both';
  if (autoAddPolicyCount > 0) return 'Auto-assigned';
  if (autoRemovePolicyCount > 0) return 'Request-based with auto-removal';
  return 'Request-based';
}

// 6b. Category
export async function fetchCategory(pool, res, apId) {
  try {
    const { ensureCategoryTables } = await import('../categories.js');
    await ensureCategoryTables(pool);
    const r = await timedQuery(pool, 'ap-category', res, `
      SELECT cat.id, cat.name, cat.color
      FROM "GovernanceCategoryAssignments" ca
      INNER JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
      WHERE ca."resourceId" = LOWER($1)
    `, [apId]);
    return r.rows.length > 0 ? r.rows[0] : null;
  } catch (e) { if (!isMissingSchema(e)) throw e; return null; /* category tables may not exist */ }
}

// 7. History count (v5: queries the _history audit table)
export async function fetchHistoryCount(apId) {
  try { return await countHistory('Resources', apId); }
  catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* _history may not exist */ }
}
