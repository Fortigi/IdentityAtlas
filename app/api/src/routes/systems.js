import { Router } from 'express';
import { timedQuery } from '../perf/sqlTimer.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const writeSystems = requirePermission('admin.systems');
// Systems.id is SERIAL (integer) in the v5 schema; a SystemOwners.userId /
// Principals.id is a UUID. Validate each param against its real type — the
// former code checked BOTH against a UUID regex, so every real (integer) system
// id was rejected with 400 before any SQL ran.
const isSystemId = (v) => /^[0-9]+$/.test(v);
const isUserId = (v) => /^[0-9a-f-]{36}$/i.test(v);

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── GET /api/systems ───────────────────────────────────────────
// List all systems with resource and assignment counts.
//
// Previous implementation used six correlated subqueries per row — on the
// load-test dataset (1.5M assignments × 126 systems) that ran in 45 seconds
// because each subquery scanned ResourceAssignments once per system. The
// CTE version below does one pass per child table total.
router.get('/systems', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    const result = await timedQuery(p, 'systems-list', res, `
      WITH res_counts AS (
        SELECT "systemId",
               COUNT(*) AS "resourceCount",
               json_agg(DISTINCT "resourceType") FILTER (WHERE "resourceType" IS NOT NULL)
                 AS "computedResourceTypes"
          FROM "Resources"
         GROUP BY "systemId"
      ),
      princ_counts AS (
        SELECT "systemId", COUNT(*) AS "principalCount"
          FROM "Principals"
         GROUP BY "systemId"
      ),
      ra_counts AS (
        -- ResourceAssignments has a denormalized systemId column (migration
        -- 001) so we group directly on it — no join back to Resources. Rows
        -- with a null systemId simply don't contribute to any system's count.
        SELECT ra."systemId",
               COUNT(*) AS "assignmentCount",
               json_agg(DISTINCT ra."assignmentType") FILTER (WHERE ra."assignmentType" IS NOT NULL)
                 AS "computedAssignmentTypes"
          FROM "ResourceAssignments" ra
         WHERE ra."systemId" IS NOT NULL
         GROUP BY ra."systemId"
      )
      SELECT s.*,
             COALESCE(rc."resourceCount", 0)  AS "resourceCount",
             COALESCE(pc."principalCount", 0) AS "principalCount",
             COALESCE(rac."assignmentCount", 0) AS "assignmentCount",
             rc."computedResourceTypes",
             rac."computedAssignmentTypes"
        FROM "Systems" s
        LEFT JOIN res_counts   rc  ON rc."systemId"  = s.id
        LEFT JOIN princ_counts pc  ON pc."systemId"  = s.id
        LEFT JOIN ra_counts    rac ON rac."systemId" = s.id
       ORDER BY s."displayName"
    `);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /systems failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/systems/:id ───────────────────────────────────────
// Get single system with details
router.get('/systems/:id', async (req, res) => {
  if (!isSystemId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.json(null);
    const p = await db.getPool();
    const result = await timedQuery(p, 'system-detail', res, `
        SELECT s.*,
          (SELECT COUNT(*) FROM "Resources" r WHERE r."systemId" = s.id) AS "resourceCount",
          (SELECT COUNT(*) FROM "Principals" p WHERE p."systemId" = s.id) AS "principalCount",
          (SELECT COUNT(*) FROM "ResourceAssignments" ra
           INNER JOIN "Resources" r ON ra."resourceId" = r.id
           WHERE r."systemId" = s.id) AS "assignmentCount",
          (SELECT json_agg(rt."resourceType")
           FROM (SELECT DISTINCT "resourceType" FROM "Resources"
                 WHERE "systemId" = s.id AND "resourceType" IS NOT NULL) rt) AS "computedResourceTypes",
          (SELECT json_agg(at."assignmentType")
           FROM (SELECT DISTINCT "assignmentType" FROM "ResourceAssignments" ra2
                 INNER JOIN "Resources" r2 ON ra2."resourceId" = r2.id
                 WHERE r2."systemId" = s.id AND ra2."assignmentType" IS NOT NULL) at) AS "computedAssignmentTypes"
        FROM "Systems" s
        WHERE s.id = $1
      `, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'System not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /systems/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch system details' });
  }
});

// ─── PUT /api/systems/:id ───────────────────────────────────────
// Update system (displayName, description, enabled only)
router.put('/systems/:id', writeSystems, async (req, res) => {
  if (!isSystemId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { displayName, description, enabled } = req.body;
    const p = await db.getPool();

    const sets = [];
    const params = [];
    if (displayName !== undefined) {
      params.push(String(displayName).slice(0, 255));
      sets.push(`"displayName" = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description ? String(description).slice(0, 1000) : null);
      sets.push(`"description" = $${params.length}`);
    }
    if (enabled !== undefined) {
      // Systems.enabled is BOOLEAN — bind a real boolean, not a 1/0 int (which
      // postgres rejects as a type mismatch against a boolean column).
      params.push(!!enabled);
      sets.push(`"enabled" = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const result = await timedQuery(p, 'system-update', res,
      `UPDATE "Systems" SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'System not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /systems/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update system' });
  }
});

// ─── GET /api/systems/:id/owners ────────────────────────────────
router.get('/systems/:id/owners', async (req, res) => {
  if (!isSystemId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    const result = await timedQuery(p, 'system-owners', res, `
        SELECT so.*, u."displayName" AS "userDisplayName", u.email AS "userPrincipalName"
        FROM "SystemOwners" so
        LEFT JOIN "Principals" u ON so."userId" = u.id
        WHERE so."systemId" = $1
        ORDER BY u."displayName"
      `, [req.params.id]);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /systems/:id/owners failed:', err.message);
    return res.json([]);
  }
});

// ─── POST /api/systems/:id/owners ───────────────────────────────
router.post('/systems/:id/owners', writeSystems, async (req, res) => {
  if (!isSystemId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { userId } = req.body;
    if (!userId || !isUserId(userId)) return res.status(400).json({ error: 'Valid userId required' });

    const p = await db.getPool();
    // SystemOwners is (systemId, userId) with a composite PK — it has no
    // role/assignedDateTime/assignedBy columns (the INSERT here used to name
    // three columns the v5 schema never had, so every add threw).
    const result = await timedQuery(p, 'system-owner-add', res, `
        INSERT INTO "SystemOwners" ("systemId", "userId")
              VALUES ($1, $2)
              RETURNING *
      `, [req.params.id, userId]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    // 23505 = postgres unique_violation (duplicate PK). The old check looked for
    // the SQL-Server strings 'UNIQUE'/'PRIMARY', which postgres never emits, so a
    // duplicate owner fell through to a 500 instead of a 409.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This user is already an owner of this system' });
    }
    console.error('POST /systems/:id/owners failed:', err.message);
    res.status(500).json({ error: 'Failed to add system owner' });
  }
});

// ─── DELETE /api/systems/:id/owners/:userId ─────────────────────
router.delete('/systems/:id/owners/:userId', writeSystems, async (req, res) => {
  if (!isSystemId(req.params.id)) return res.status(400).json({ error: 'Invalid system ID format' });
  if (!isUserId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const p = await db.getPool();
    await timedQuery(p, 'system-owner-remove', res,
      'DELETE FROM "SystemOwners" WHERE "systemId" = $1 AND "userId" = $2',
      [req.params.id, req.params.userId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /systems/:id/owners/:userId failed:', err.message);
    res.status(500).json({ error: 'Failed to remove system owner' });
  }
});

export default router;
