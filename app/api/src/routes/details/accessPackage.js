// Access-package (business-role) detail endpoints — /api/access-package/:id
// and its lazy-loaded sub-resources.
//
// Extracted verbatim from routes/details.js (audit finding C1). Mounted by
// routes/details.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move (the categories.js dynamic import path
// shifts from './categories.js' to '../categories.js' now that this lives one
// directory deeper).

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, UUID_RE, cleanRow, fetchHistory, countHistory } from './shared.js';

const router = Router();

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id — Lightweight: attributes, counts only
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, assignmentCount: 0, groupCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const apId = req.params.id;

    // 1. Current attributes + catalog name
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

    if (apResult.rows.length === 0) {
      return res.status(404).json({ error: 'Access package not found' });
    }
    const attributes = cleanRow(apResult.rows[0]);

    // 2. Assignment count
    let assignmentCount = 0;
    try {
      const r = await timedQuery(pool, 'ap-assignment-count', res,
        `SELECT COUNT(*)::int AS cnt FROM "ResourceAssignments" WHERE "resourceId" = $1`, [apId]);
      assignmentCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Group count (resources linked to this AP)
    let groupCount = 0;
    try {
      const r = await timedQuery(pool, 'ap-group-count', res, `
        SELECT COUNT(DISTINCT "childResourceId")::int AS cnt
        FROM "ResourceRelationships"
        WHERE "parentResourceId" = $1 AND "relationshipType" = 'Contains'
      `, [apId]);
      groupCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 4. Review count
    let reviewCount = 0;
    try {
      const r = await timedQuery(pool, 'ap-review-count', res,
        `SELECT COUNT(*)::int AS cnt FROM "CertificationDecisions" WHERE "resourceId" = $1`, [apId]);
      reviewCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5. Pending request count — COUNT only (cheap); full rows are lazy-loaded.
    let pendingRequestCount = null;
    try {
      const r = await timedQuery(pool, 'ap-pending-request-count', res, `
        SELECT COUNT(*)::int AS cnt FROM "AssignmentRequests"
        WHERE "resourceId" = $1 AND "requestState" = 'PendingApproval'
      `, [apId]);
      pendingRequestCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5b. Last review date + reviewer
    let lastReviewDate = null;
    let lastReviewedBy = null;
    try {
      const r = await timedQuery(pool, 'ap-last-review-date', res, `
        SELECT "reviewedDateTime", "reviewedByDisplayName"
        FROM "CertificationDecisions"
        WHERE "resourceId" = $1 AND decision IS NOT NULL AND decision <> 'NotReviewed'
        ORDER BY "reviewedDateTime" DESC
      `, [apId]);
      lastReviewDate = r.rows[0]?.reviewedDateTime || null;
      lastReviewedBy = r.rows[0]?.reviewedByDisplayName || null;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5c. Compliance status of the latest review instance — the same calculated
    //     "Review Status" the Business Roles list shows. Mirrors the
    //     LAST_REVIEW_CTE logic in governance.js, scoped to one resource.
    let complianceStatus = null;
    let daysOverdue = 0;
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
      const row = r.rows[0];
      if (row) {
        const deadline = row.deadline ? new Date(row.deadline) : null;
        const overdue = deadline && deadline < new Date();
        if (row.notReviewed === 0 && row.late === 0) complianceStatus = 'Compliant';
        else if (row.notReviewed > 0 && !overdue) complianceStatus = 'In Progress';
        else if (row.notReviewed > 0 && overdue) complianceStatus = 'Missed';
        else complianceStatus = 'Reviewed Late';
        if (deadline && overdue) daysOverdue = Math.floor((Date.now() - deadline.getTime()) / 86400000);
      }
    } catch (e) { if (!isMissingSchema(e)) throw e; /* CertificationDecisions may not exist */ }

    // 6. Policy summary — auto-assigned vs request-based vs auto-removal
    let policyCount = 0;
    let autoAddPolicyCount = 0;
    let autoRemovePolicyCount = 0;
    try {
      const r = await timedQuery(pool, 'ap-policy-summary', res, `
        SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN "hasAutoAddRule" = TRUE THEN 1 ELSE 0 END)::int AS "autoAdd",
          SUM(CASE WHEN COALESCE("hasAutoAddRule", FALSE) = FALSE AND "hasAutoRemoveRule" = TRUE THEN 1 ELSE 0 END)::int AS "autoRemoveOnly"
        FROM "AssignmentPolicies"
        WHERE "resourceId" = $1
      `, [apId]);
      policyCount = r.rows[0].total;
      autoAddPolicyCount = r.rows[0].autoAdd;
      autoRemovePolicyCount = r.rows[0].autoRemoveOnly;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // Derive assignment type label
    let assignmentType = null;
    if (policyCount > 0) {
      const requestBasedCount = policyCount - autoAddPolicyCount - autoRemovePolicyCount;
      if (autoAddPolicyCount > 0 && (requestBasedCount > 0 || autoRemovePolicyCount > 0)) {
        assignmentType = 'Both';
      } else if (autoAddPolicyCount > 0) {
        assignmentType = 'Auto-assigned';
      } else if (autoRemovePolicyCount > 0) {
        assignmentType = 'Request-based with auto-removal';
      } else {
        assignmentType = 'Request-based';
      }
    }

    // 6b. Category
    let category = null;
    try {
      const { ensureCategoryTables } = await import('../categories.js');
      await ensureCategoryTables(pool);
      const r = await timedQuery(pool, 'ap-category', res, `
        SELECT cat.id, cat.name, cat.color
        FROM "GovernanceCategoryAssignments" ca
        INNER JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
        WHERE ca."resourceId" = LOWER($1)
      `, [apId]);
      if (r.rows.length > 0) {
        category = r.rows[0];
      }
    } catch (e) { if (!isMissingSchema(e)) throw e; /* category tables may not exist */ }

    // 7. History count (v5: queries the _history audit table)
    let historyCount = 0;
    try { historyCount = await countHistory('Resources', apId); } catch (e) { if (!isMissingSchema(e)) throw e; /* _history may not exist */ }

    res.json({ attributes, assignmentCount, groupCount, reviewCount, pendingRequestCount, lastReviewDate, lastReviewedBy, complianceStatus, daysOverdue, historyCount, hasHistory: historyCount > 0, policyCount, autoAddPolicyCount, assignmentType, category });
  } catch (err) {
    console.error('Error fetching access package detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch access package details' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/assignments — Lazy-loaded user assignments
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/assignments', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    let r;
    try {
      // v5: assignedDate comes from the _history audit table (earliest INSERT
      // for this assignment row). Falls back to NULL when no history exists.
      // ResourceAssignments has no surrogate `id` column in v5 — the primary
      // key is (resourceId, principalId, assignmentType). That means we can't
      // drive the _history lookup from a.id; the audit rows key off the
      // composite too. Skip the assignedDate lookup for now (it's a nice-to
      // have) and fall back to the assignment row itself.
      r = await timedQuery(pool, 'ap-assignments', res, `
        SELECT
          a."principalId", a.state AS "assignmentState", a."assignmentStatus",
          u."displayName" AS "targetDisplayName",
          u.email AS "targetUPN",
          NULL::timestamptz AS "assignedDate"
        FROM "ResourceAssignments" a
        LEFT JOIN "Principals" u ON a."principalId" = u.id
        WHERE a."resourceId" = $1
          AND (a.state = 'Delivered' OR a.state IS NULL)
        ORDER BY u."displayName"
      `, [req.params.id]);
    } catch (e) {
      console.error('ap-assignments failed:', e.message);
      r = { rows: [] };
    }
    res.json(r.rows);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/resource-roles — Lazy-loaded resource role scopes
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/resource-roles', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'ap-resource-roles', res, `
      SELECT
        rrs."roleName", rrs."roleOriginSystem",
        r."displayName" AS "scopeDisplayName", rrs."childResourceId", rrs."roleOriginSystem" AS "scopeOriginSystem",
        COALESCE(r."displayName", rrs."roleName") AS "groupDisplayName",
        COALESCE(r."displayName", rrs."roleName") AS "resourceDisplayName",
        r."resourceType", r."systemId"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" r ON rrs."childResourceId" = r.id
      WHERE rrs."parentResourceId" = $1 AND rrs."relationshipType" = 'Contains'
      ORDER BY r."displayName", rrs."roleName"
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('ap-resource-roles failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/reviews — Lazy-loaded access reviews
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/reviews', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'ap-reviews', res, `
      SELECT
        id, "reviewInstanceId", "reviewDefinitionId",
        "principalDisplayName",
        "reviewedByDisplayName",
        "reviewedDateTime", decision, justification, "recommendation",
        "reviewInstanceStartDateTime", "reviewInstanceEndDateTime",
        "reviewInstanceStatus"
      FROM "CertificationDecisions"
      WHERE "resourceId" = $1
      ORDER BY "reviewedDateTime" DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/requests — Lazy-loaded assignment requests
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/requests', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'ap-requests', res, `
        SELECT
          req.id, req."requestType", req."requestState", req."requestStatus",
          req.justification, req."createdDateTime", req."completedDateTime",
          u."displayName" AS "requestorDisplayName", u.email AS "requestorUPN"
        FROM "AssignmentRequests" req
        LEFT JOIN "Principals" u ON req."requestorId" = u.id
        WHERE req."resourceId" = $1
          AND req."requestState" IN ('PendingApproval', 'Delivering', 'Accepted')
        ORDER BY req."createdDateTime" DESC
      `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/history — Lazy-loaded version history
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/history', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const rows = await fetchHistory('Resources', req.params.id);
    // Only show history for rows that were business roles at some point
    const filtered = rows.filter(r => r.resourceType === 'BusinessRole');
    res.json(filtered.map(cleanRow));
  } catch (err) {
    console.error('ap-history failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/policies — Lazy-loaded assignment policies
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/policies', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'ap-policies', res, `
      SELECT id, "displayName", description, "allowedTargetScope",
             COALESCE("hasAutoAddRule", FALSE) AS "hasAutoAddRule",
             COALESCE("hasAutoRemoveRule", FALSE) AS "hasAutoRemoveRule",
             COALESCE("hasAccessReview", FALSE) AS "hasAccessReview",
             "reviewSettings",
             "automaticRequestSettings" #>> '{filter,rule}' AS "autoAssignmentFilter",
             "createdDateTime", "modifiedDateTime"
      FROM "AssignmentPolicies"
      WHERE "resourceId" = $1
      ORDER BY "displayName"
    `, [req.params.id]);
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

export default router;
