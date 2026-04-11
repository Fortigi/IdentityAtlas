import { Router } from 'express';
import * as db from '../db/connection.js';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Helper: try query, return empty on failure (view/table may not exist)
async function safeQuery(pool, label, res, sql) {
  try {
    const r = await timedRequest(pool, label, res).query(sql);
    return r.recordset;
  } catch {
    return [];
  }
}

// ── Shared CTE: per-AP last review instance status (postgres) ──────────
// For each access package, picks the most recent review instance and
// summarises decisions within that instance only. Date arithmetic uses
// `(deadline::date < current_date)` and `(current_date - deadline::date)`
// instead of T-SQL's CAST AS DATE / DATEDIFF / GETUTCDATE.
const LAST_REVIEW_CTE = `
WITH "LatestInstance" AS (
  SELECT DISTINCT ON ("resourceId")
         "resourceId",
         "reviewInstanceId",
         "reviewInstanceEndDateTime",
         "reviewInstanceStartDateTime",
         "reviewInstanceStatus"
    FROM "CertificationDecisions"
   ORDER BY "resourceId", "reviewInstanceEndDateTime" DESC NULLS LAST
),
"LastReviewPerAP" AS (
  SELECT
    li."resourceId",
    li."reviewInstanceEndDateTime"   AS deadline,
    li."reviewInstanceStartDateTime" AS "reviewStart",
    li."reviewInstanceStatus",
    COUNT(*)::int AS "totalDecisions",
    SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime" <= li."reviewInstanceEndDateTime" THEN 1 ELSE 0 END)::int AS "onTime",
    SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime"::date > li."reviewInstanceEndDateTime"::date THEN 1 ELSE 0 END)::int AS "reviewedLate",
    SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END)::int AS "notReviewed",
    MAX(d."reviewedDateTime") AS "lastReviewedDate",
    MAX(d."reviewedByDisplayName") AS "lastReviewedBy",
    CASE
      WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime"::date > li."reviewInstanceEndDateTime"::date THEN 1 ELSE 0 END) = 0
        THEN 'Compliant'
      WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) > 0
       AND li."reviewInstanceEndDateTime"::date >= current_date
        THEN 'In Progress'
      WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) > 0
       AND li."reviewInstanceEndDateTime"::date < current_date
        THEN 'Missed'
      ELSE 'Reviewed Late'
    END AS "complianceStatus",
    CASE
      WHEN li."reviewInstanceEndDateTime"::date < current_date
        THEN (current_date - li."reviewInstanceEndDateTime"::date)
      ELSE 0
    END AS "daysOverdue"
  FROM "LatestInstance" li
    INNER JOIN "CertificationDecisions" d
      ON d."resourceId" = li."resourceId"
     AND d."reviewInstanceId" = li."reviewInstanceId"
  GROUP BY li."resourceId", li."reviewInstanceEndDateTime", li."reviewInstanceStartDateTime", li."reviewInstanceStatus"
)`;

// ────────────────────────────────────────────────────────────────
// GET /api/governance/summary — AP-centric review compliance KPIs
// ────────────────────────────────────────────────────────────────
router.get('/governance/summary', async (req, res) => {
  if (!useSql) return res.json({});
  try {
    const pool = await db.getPool();

    const rows = await safeQuery(pool, 'gov-summary', res,
      `${LAST_REVIEW_CTE}
      SELECT
        COUNT(*)::int AS "totalAPs",
        SUM(CASE WHEN "complianceStatus" = 'Compliant'    THEN 1 ELSE 0 END)::int AS compliant,
        SUM(CASE WHEN "complianceStatus" = 'Missed'       THEN 1 ELSE 0 END)::int AS overdue,
        SUM(CASE WHEN "complianceStatus" = 'Reviewed Late' THEN 1 ELSE 0 END)::int AS "reviewedLate",
        SUM(CASE WHEN "complianceStatus" = 'In Progress'  THEN 1 ELSE 0 END)::int AS "inProgress"
      FROM "LastReviewPerAP"`);

    const s = rows[0] || {};

    res.json({
      totalAPs: s.totalAPs || 0,
      compliant: s.compliant || 0,
      overdue: s.overdue || 0,
      reviewedLate: s.reviewedLate || 0,
      inProgress: s.inProgress || 0,
    });
  } catch (err) {
    console.error('Error fetching governance summary:', err.message);
    res.status(500).json({ error: 'Failed to fetch governance summary' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/governance/review-compliance — Per-AP last review status
// ?filter=compliant|overdue|reviewed-late|in-progress (optional)
// ?category=categoryId (optional)
// ────────────────────────────────────────────────────────────────
router.get('/governance/review-compliance', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const filter = req.query.filter;
    const categoryId = req.query.category;

    let filterClause = '';
    if (filter === 'overdue') {
      filterClause = `AND lr."complianceStatus" = 'Missed'`;
    } else if (filter === 'reviewed-late') {
      filterClause = `AND lr."complianceStatus" = 'Reviewed Late'`;
    } else if (filter === 'compliant') {
      filterClause = `AND lr."complianceStatus" = 'Compliant'`;
    } else if (filter === 'in-progress') {
      filterClause = `AND lr."complianceStatus" = 'In Progress'`;
    }

    let categoryClause = '';
    const params = [];
    if (categoryId) {
      if (categoryId === 'uncategorized') {
        categoryClause = `AND ca."categoryId" IS NULL`;
      } else {
        params.push(parseInt(categoryId, 10));
        categoryClause = `AND ca."categoryId" = $${params.length}`;
      }
    }

    const result = await db.query(
      `${LAST_REVIEW_CTE}
      SELECT
        ap.id AS "resourceId",
        ap."displayName"   AS "accessPackageName",
        c."displayName"    AS "catalogName",
        cat.name           AS "categoryName",
        cat.color          AS "categoryColor",
        lr."complianceStatus",
        lr.deadline,
        lr."daysOverdue",
        lr."totalDecisions",
        lr."onTime",
        lr."reviewedLate",
        lr."notReviewed",
        lr."lastReviewedDate",
        lr."lastReviewedBy",
        lr."reviewInstanceStatus"
      FROM "LastReviewPerAP" lr
        INNER JOIN "Resources" ap ON lr."resourceId" = ap.id AND ap."resourceType" = 'BusinessRole'
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        LEFT JOIN "GovernanceCategoryAssignments" ca ON LOWER(ap.id::text) = LOWER(ca."resourceId")
        LEFT JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
      WHERE 1=1 ${filterClause} ${categoryClause}
      ORDER BY
        CASE lr."complianceStatus"
          WHEN 'Missed'        THEN 1
          WHEN 'Reviewed Late' THEN 2
          WHEN 'In Progress'   THEN 3
          WHEN 'Compliant'     THEN 4
          ELSE 5
        END,
        lr."daysOverdue" DESC`, params);
    res.json(result.rows);
  } catch (err) {
    console.error('review-compliance failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/governance/categories — Available categories for filtering
// ────────────────────────────────────────────────────────────────
router.get('/governance/categories', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const rows = await safeQuery(pool, 'gov-categories', res,
      `SELECT id, name, color FROM "GovernanceCategories" ORDER BY name`);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

export default router;
