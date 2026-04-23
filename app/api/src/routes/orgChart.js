// Minimal /api/org-chart adapter — kept alive for the entity-detail page
// and the entity-graph component, both of which fetch a user's manager and
// direct reports via these endpoints. The original route was deleted in
// the Phase-10 cleanup; this rewrite is a much smaller surface (only what
// the UI actually calls) and queries Principals.managerId directly rather
// than rebuilding the old org-chart-cache code path.
//
// Long-term these calls should move into the Principal detail endpoint
// (one round trip instead of three), but until that refactor lands the
// UI keeps calling here.

import { Router } from 'express';
import * as db from '../db/connection.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/org-chart/user/:id/manager
router.get('/org-chart/user/:id/manager', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  if (!useSql) return res.json({ manager: null });
  try {
    const row = await db.queryOne(
      `SELECT m.id, m."displayName", m.email, m.department, m."jobTitle", m."companyName"
         FROM "Principals" p
         JOIN "Principals" m ON m.id = p."managerId"
        WHERE p.id = $1`,
      [req.params.id]
    );
    res.json({ manager: row || null });
  } catch (err) {
    console.error('GET /org-chart/user/:id/manager failed:', err.message);
    res.status(500).json({ error: 'Failed to load manager' });
  }
});

// GET /api/org-chart/user/:id/reports
// Returns every Principal that lists this user as their managerId.
router.get('/org-chart/user/:id/reports', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  if (!useSql) return res.json({ reports: [], totalCount: 0 });
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const rows = (await db.query(
      `SELECT id, "displayName", email, department, "jobTitle", "companyName"
         FROM "Principals"
        WHERE "managerId" = $1
        ORDER BY "displayName"
        LIMIT $2`,
      [req.params.id, limit]
    )).rows;
    res.json({ reports: rows, totalCount: rows.length });
  } catch (err) {
    console.error('GET /org-chart/user/:id/reports failed:', err.message);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// GET /api/org-chart  — DepartmentDetailPage probes this to know whether
// org-chart data is available. Return availability based on whether the
// manager-hierarchy plugin has produced anything.
router.get('/org-chart', async (req, res) => {
  if (!useSql) return res.json({ available: false });
  try {
    const row = await db.queryOne(
      `SELECT count(*)::int AS n
         FROM "Contexts"
        WHERE "contextType" = 'ManagerHierarchy'
          AND variant       = 'generated'`
    );
    res.json({ available: !!(row && row.n > 0) });
  } catch {
    res.json({ available: false });
  }
});

export default router;
