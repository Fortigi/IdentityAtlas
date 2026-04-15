import { Router } from 'express';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── Auto-create category tables if they don't exist ─────────────
let tablesReady = false;

// In v5 the category tables are created by the migrations runner.
// This function is a no-op kept for backward compatibility.
async function ensureCategoryTables(_pool) { tablesReady = true; }
export { ensureCategoryTables };

const TAG_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

// Validate hex color format (#000000 – #ffffff)
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ─── GET /api/categories ─────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    await ensureCategoryTables(p);
    const result = await p.request().query(`
      SELECT c.id, c."name", c."color", c."createdAt",
             COALESCE(COUNT(ca."categoryId"), 0)::int AS "assignmentCount"
        FROM "GovernanceCategories" c
        LEFT JOIN "GovernanceCategoryAssignments" ca ON ca."categoryId" = c.id
       GROUP BY c.id, c."name", c."color", c."createdAt"
       ORDER BY c."name"
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /categories failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/categories ────────────────────────────────────────
router.post('/categories', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });

    const p = await db.getPool();
    await ensureCategoryTables(p);
    const result = await p.request()
      .input('name', name.trim())
      .input('color', color || TAG_COLORS[0])
      .query(`
        INSERT INTO "GovernanceCategories" (name, color)
              VALUES (@name, @color)
              RETURNING *
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.message?.includes('UQ__Governance') || err.message?.includes('UQ__GraphCat') || err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A category with this name already exists' });
    }
    console.error('POST /categories failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/categories/:id ───────────────────────────────────
router.patch('/categories/:id', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { name, color } = req.body;
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });
    const p = await db.getPool();
    await ensureCategoryTables(p);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category ID' });
    const request = p.request().input('id', id);
    const sets = [];
    if (name) { sets.push('"name" = @name'); request.input('name', name.trim()); }
    if (color) { sets.push('"color" = @color'); request.input('color', color); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const result = await request.query(
      `UPDATE "GovernanceCategories" SET ${sets.join(', ')} WHERE id = @id RETURNING *`
    );
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error('PATCH /categories failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/categories/:id ──────────────────────────────────
router.delete('/categories/:id', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category ID' });
    const p = await db.getPool();
    await ensureCategoryTables(p);
    await p.request()
      .input('id', id)
      .query('DELETE FROM GovernanceCategories WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /categories failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/categories/:id/assign ─────────────────────────────
// Assigns category to an access package. Since an AP can only have ONE category,
// this replaces any existing assignment for that AP.
router.post('/categories/:id/assign', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { businessRoleId, resourceId: bodyResourceId } = req.body;
    const resId = bodyResourceId || businessRoleId;
    if (!resId) return res.status(400).json({ error: 'resourceId required' });

    const p = await db.getPool();
    await ensureCategoryTables(p);
    const categoryId = parseInt(req.params.id, 10);
    if (isNaN(categoryId)) return res.status(400).json({ error: 'Invalid category ID' });

    // An AP can only have ONE category. The PK is (categoryId, resourceId) so a
    // simple UPSERT can't enforce that — delete any existing assignment for the
    // resource first, then insert the new one. Two statements wrapped in tx().
    await db.tx(async (client) => {
      await client.query(
        `DELETE FROM "GovernanceCategoryAssignments" WHERE "resourceId" = $1`,
        [String(resId).toLowerCase()]
      );
      await client.query(
        `INSERT INTO "GovernanceCategoryAssignments" ("resourceId", "categoryId") VALUES ($1, $2)`,
        [String(resId).toLowerCase(), categoryId]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /categories/:id/assign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/categories/unassign ───────────────────────────────
// Removes the category assignment from an access package.
router.post('/categories/unassign', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { businessRoleId, resourceId: bodyResourceId } = req.body;
    const resId = bodyResourceId || businessRoleId;
    if (!resId) return res.status(400).json({ error: 'resourceId required' });

    const p = await db.getPool();
    await ensureCategoryTables(p);

    await p.request()
      .input('resourceId', String(resId).toLowerCase())
      .query('DELETE FROM "GovernanceCategoryAssignments" WHERE "resourceId" = @resourceId');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /categories/unassign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/access-packages ────────────────────────────────────
// Paginated list of business roles (resources where resourceType='BusinessRole')
// with category, policy, assignment counts. Postgres-native (v5).
router.get('/access-packages', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const search = (req.query.search || '').trim().slice(0, 200);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const categoryFilter = req.query.categoryId ? parseInt(req.query.categoryId, 10) : null;
    const showUncategorized = req.query.uncategorized === 'true';

    const SORT_COL_MAP = {
      displayName:      'ap."displayName"',
      totalAssignments: 'totalAssignments',
      category:         'categoryName',
      catalog:          'catalogName',
    };
    const sortExpr = SORT_COL_MAP[req.query.sortCol] || 'ap."displayName"';
    const sortDir = req.query.sortDir === 'desc' ? 'DESC' : 'ASC';

    const p = await db.getPool();
    await ensureCategoryTables(p);

    const params = [];
    const where = [`ap."resourceType" = 'BusinessRole'`];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(ap."displayName" ILIKE $${params.length} OR c."displayName" ILIKE $${params.length})`);
    }
    if (categoryFilter) {
      params.push(categoryFilter);
      where.push(`ca."categoryId" = $${params.length}`);
    } else if (showUncategorized) {
      where.push(`ca."resourceId" IS NULL`);
    }
    const whereSql = where.join(' AND ');

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    // Review compliance is computed only when CertificationDecisions exists.
    // The CTE follows the same logic as governance.js LAST_REVIEW_CTE: pick the
    // newest review instance per AP, then derive a status from the decisions in
    // that instance (Compliant / In Progress / Missed / Reviewed Late).
    const hasReviewTable = await db.queryOne(
      `SELECT to_regclass('"CertificationDecisions"') AS t`
    ).then(r => !!r?.t).catch(() => false);

    const reviewCte = hasReviewTable ? `, "LatestInstance" AS (
        SELECT DISTINCT ON ("resourceId")
               "resourceId",
               "reviewInstanceId",
               "reviewInstanceEndDateTime"
          FROM "CertificationDecisions"
         ORDER BY "resourceId", "reviewInstanceEndDateTime" DESC NULLS LAST
      ), "LastReviewPerAP" AS (
        SELECT li."resourceId",
               li."reviewInstanceEndDateTime" AS deadline,
               MAX(CASE WHEN d.decision <> 'NotReviewed' THEN d."reviewedDateTime" END)      AS "lastReviewDate",
               MAX(CASE WHEN d.decision <> 'NotReviewed' THEN d."reviewedByDisplayName" END) AS "lastReviewedBy",
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
         GROUP BY li."resourceId", li."reviewInstanceEndDateTime"
      )` : '';

    const reviewCols = hasReviewTable
      ? `, lr."lastReviewDate", lr."lastReviewedBy", lr."complianceStatus", lr.deadline AS "reviewDeadline", COALESCE(lr."daysOverdue", 0) AS "daysOverdue"`
      : `, NULL AS "lastReviewDate", NULL AS "lastReviewedBy", NULL AS "complianceStatus", NULL AS "reviewDeadline", 0 AS "daysOverdue"`;
    const reviewJoin = hasReviewTable
      ? `LEFT JOIN "LastReviewPerAP" lr ON lr."resourceId" = ap.id`
      : '';

    const dataSql = `
      WITH ac AS (
        SELECT "resourceId", COUNT(*)::int AS cnt
          FROM "ResourceAssignments"
         WHERE "assignmentType" = 'Governed'
           AND (LOWER(state) = 'delivered' OR state IS NULL)
         GROUP BY "resourceId"
      ), pc AS (
        SELECT "resourceId",
               COUNT(*)::int AS "policyCount",
               SUM(CASE WHEN "hasAutoAddRule" THEN 1 ELSE 0 END)::int AS "autoAddCount",
               SUM(CASE WHEN COALESCE("hasAutoAddRule", false) = false AND "hasAutoRemoveRule" THEN 1 ELSE 0 END)::int AS "autoRemoveOnlyCount",
               BOOL_OR(COALESCE("hasAccessReview", false)) AS "hasReviewConfigured"
          FROM "AssignmentPolicies"
         GROUP BY "resourceId"
      )${reviewCte}
      SELECT ap.id, ap."displayName", ap.description,
             c."displayName" AS "catalogName", c.id AS "catalogId",
             COALESCE(ac.cnt, 0) AS "totalAssignments",
             cat.id AS "categoryId", cat.name AS "categoryName", cat.color AS "categoryColor",
             COALESCE(pc."policyCount", 0) AS "policyCount",
             COALESCE(pc."autoAddCount", 0) AS "autoAddCount",
             COALESCE(pc."autoRemoveOnlyCount", 0) AS "autoRemoveOnlyCount",
             COALESCE(pc."hasReviewConfigured", false) AS "hasReviewConfigured"
             ${reviewCols}
        FROM "Resources" ap
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        LEFT JOIN ac ON ap.id::text = ac."resourceId"::text
        LEFT JOIN "GovernanceCategoryAssignments" ca ON LOWER(ap.id::text) = LOWER(ca."resourceId")
        LEFT JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
        LEFT JOIN pc ON ap.id::text = pc."resourceId"::text
        ${reviewJoin}
       WHERE ${whereSql}
       ORDER BY ${sortExpr} ${sortDir}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
        FROM "Resources" ap
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        LEFT JOIN "GovernanceCategoryAssignments" ca ON LOWER(ap.id::text) = LOWER(ca."resourceId")
        LEFT JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
       WHERE ${whereSql}
    `;

    const dataRes = await db.query(dataSql, params);
    const countRes = await db.query(countSql, params.slice(0, params.length - 2));

    const data = dataRes.rows.map(r => {
      // Derive assignment type from policy counts
      let assignmentType = null;
      if (r.policyCount > 0) {
        const requestBasedCount = r.policyCount - r.autoAddCount - r.autoRemoveOnlyCount;
        if (r.autoAddCount > 0 && (requestBasedCount > 0 || r.autoRemoveOnlyCount > 0)) {
          assignmentType = 'Both';
        } else if (r.autoAddCount > 0) {
          assignmentType = 'Auto-assigned';
        } else if (r.autoRemoveOnlyCount > 0) {
          assignmentType = 'Request-based with auto-removal';
        } else {
          assignmentType = 'Request-based';
        }
      }
      return {
        id: r.id,
        displayName: r.displayName,
        description: r.description,
        catalogName: r.catalogName,
        catalogId: r.catalogId,
        totalAssignments: r.totalAssignments,
        category: r.categoryId ? { id: r.categoryId, name: r.categoryName, color: r.categoryColor } : null,
        assignmentType,
        lastReviewDate: r.lastReviewDate || null,
        lastReviewedBy: r.lastReviewedBy || null,
        // Suppress Overdue/In Progress when there are no active assignments — the reviewer
        // would see nothing pending, so showing overdue is misleading.
        complianceStatus: (r.totalAssignments === 0 && (r.complianceStatus === 'Overdue' || r.complianceStatus === 'In Progress'))
          ? null
          : r.complianceStatus || null,
        reviewDeadline: r.reviewDeadline || null,
        daysOverdue: r.daysOverdue || 0,
        hasReviewConfigured: !!r.hasReviewConfigured,
        reviewerInfo: r.reviewerInfo || null,
        missedReviewsCount: r.missedReviewsCount || 0,
      };
    });

    res.json({ data, total: countRes.rows[0]?.total || 0 });
  } catch (err) {
    console.error('GET /access-packages failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/category-assignments ───────────────────────────────
// Returns all category assignments as a flat list (for matrix column ordering)
router.get('/category-assignments', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    await ensureCategoryTables(p);
    const result = await p.request().query(`
      SELECT ca."resourceId", ca."resourceId" AS businessRoleId, c.id AS "categoryId", c.name AS categoryName, c.color AS categoryColor
      FROM "GovernanceCategoryAssignments" ca
      INNER JOIN "GovernanceCategories" c ON ca."categoryId" = c.id
      ORDER BY c.name, ca."resourceId"
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /category-assignments failed:', err.message);
    res.json([]);
  }
});

export default router;
