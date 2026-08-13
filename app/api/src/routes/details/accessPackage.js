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
import { useSql, UUID_RE, cleanRow, fetchHistory } from './shared.js';
import {
  fetchApAttributes, fetchAssignmentCount, fetchGroupCount, fetchReviewCount,
  fetchPendingRequestCount, fetchLastReview, fetchComplianceStatus,
  fetchPolicySummary, deriveAssignmentType, fetchCategory, fetchHistoryCount,
} from './accessPackageDetail.js';

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

    // Attributes first — a missing row is a 404 before we fetch the counts.
    const attributes = await fetchApAttributes(pool, res, apId);
    if (attributes === null) {
      return res.status(404).json({ error: 'Access package not found' });
    }

    // The remaining sections are independent optional fetches; each swallows a
    // missing optional table and rethrows anything else to the 500 below.
    const assignmentCount = await fetchAssignmentCount(pool, res, apId);
    const groupCount = await fetchGroupCount(pool, res, apId);
    const reviewCount = await fetchReviewCount(pool, res, apId);
    const pendingRequestCount = await fetchPendingRequestCount(pool, res, apId);
    const { lastReviewDate, lastReviewedBy } = await fetchLastReview(pool, res, apId);
    const { complianceStatus, daysOverdue } = await fetchComplianceStatus(apId);
    const { policyCount, autoAddPolicyCount, autoRemovePolicyCount } = await fetchPolicySummary(pool, res, apId);
    const assignmentType = deriveAssignmentType({ policyCount, autoAddPolicyCount, autoRemovePolicyCount });
    const category = await fetchCategory(pool, res, apId);
    const historyCount = await fetchHistoryCount(apId);

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
