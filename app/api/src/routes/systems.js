import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f-]{36}$/i;

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
    const result = await timedRequest(p, 'systems-list', res).query(`
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
    return res.json(result.recordset);
  } catch (err) {
    console.error('GET /systems failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/systems/:id ───────────────────────────────────────
// Get single system with details
router.get('/systems/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.json(null);
    const p = await db.getPool();
    const result = await timedRequest(p, 'system-detail', res)
      .input('id', req.params.id)
      .query(`
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
        WHERE s.id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'System not found' });
    }
    return res.json(result.recordset[0]);
  } catch (err) {
    console.error('GET /systems/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch system details' });
  }
});

// ─── PUT /api/systems/:id ───────────────────────────────────────
// Update system (displayName, description, enabled only)
router.put('/systems/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { displayName, description, enabled } = req.body;
    const p = await db.getPool();
    const request = timedRequest(p, 'system-update', res).input('id', req.params.id);

    const sets = [];
    if (displayName !== undefined) {
      sets.push('"displayName" = @displayName');
      request.input('displayName', String(displayName).slice(0, 255));
    }
    if (description !== undefined) {
      sets.push('"description" = @description');
      request.input('description', description ? String(description).slice(0, 1000) : null);
    }
    if (enabled !== undefined) {
      sets.push('"enabled" = @enabled');
      request.input('enabled', enabled ? 1 : 0);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const result = await request.query(`
      UPDATE "Systems" SET ${sets.join(', ')} WHERE id = @id RETURNING *
    `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'System not found' });
    }
    return res.json(result.recordset[0]);
  } catch (err) {
    console.error('PUT /systems/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update system' });
  }
});

// ─── GET /api/systems/:id/owners ────────────────────────────────
router.get('/systems/:id/owners', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    const result = await timedRequest(p, 'system-owners', res)
      .input('id', req.params.id)
      .query(`
        SELECT so.*, u."displayName" AS "userDisplayName", u.userPrincipalName
        FROM "SystemOwners" so
        LEFT JOIN GraphUsers u ON so."userId" = u.id
        WHERE so."systemId" = @id
        ORDER BY u."displayName"
      `);
    return res.json(result.recordset);
  } catch (err) {
    console.error('GET /systems/:id/owners failed:', err.message);
    return res.json([]);
  }
});

// ─── POST /api/systems/:id/owners ───────────────────────────────
router.post('/systems/:id/owners', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { userId } = req.body;
    if (!userId || !UUID_RE.test(userId)) return res.status(400).json({ error: 'Valid userId required' });

    const assignedBy = req.user?.preferred_username || 'system';
    const p = await db.getPool();
    const result = await timedRequest(p, 'system-owner-add', res)
      .input('systemId', req.params.id)
      .input('userId', userId)
      .input('role', 'Owner')
      .input('assignedBy', assignedBy)
      .query(`
        INSERT INTO "SystemOwners" ("systemId", "userId", role, assignedDateTime, assignedBy)
              VALUES (@systemId, @userId, @role, (now() AT TIME ZONE 'utc'), @assignedBy)
              RETURNING *
      `);
    return res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('PRIMARY')) {
      return res.status(409).json({ error: 'This user is already an owner of this system' });
    }
    console.error('POST /systems/:id/owners failed:', err.message);
    res.status(500).json({ error: 'Failed to add system owner' });
  }
});

// ─── DELETE /api/systems/:id/owners/:userId ─────────────────────
router.delete('/systems/:id/owners/:userId', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid system ID format' });
  if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID format' });
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const p = await db.getPool();
    await timedRequest(p, 'system-owner-remove', res)
      .input('systemId', req.params.id)
      .input('userId', req.params.userId)
      .query('DELETE FROM "SystemOwners" WHERE "systemId" = @systemId AND "userId" = @userId');
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /systems/:id/owners/:userId failed:', err.message);
    res.status(500).json({ error: 'Failed to remove system owner' });
  }
});

export default router;
