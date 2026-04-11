// ─── Contexts API Routes ──────────────────────────────────────────────
//
// Reads contexts from the Contexts table and builds hierarchy trees
// for org-chart visualization. Contexts represent any grouping that
// defines access: departments, teams, cost centers, projects, locations.
//
// Membership is resolved through Identities (contextId on Identities),
// then joined to Principals via IdentityMembers.
//
// GET    /api/contexts              - List all Contexts with hierarchy info
// GET    /api/contexts/tree         - Pre-built tree structure for org chart
// GET    /api/contexts/:id          - Single Context detail with members and sub-contexts
// GET    /api/contexts/:id/members  - Paginated member list (via Identities)

import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f-]{36}$/i;

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── Table detection (cached 5 min) ─────────────────────────────────

let hasContextsTable = null;
let contextsCheckTime = 0;

async function checkContexts(pool) {
  const now = Date.now();
  if (hasContextsTable !== null && now - contextsCheckTime < 300000) return hasContextsTable;
  try {
    const r = await pool.request().query(`
      SELECT to_regclass('"Contexts"') AS "contextsExists"
    `);
    hasContextsTable = !!r.recordset[0].contextsExists;
    contextsCheckTime = now;
  } catch {
    hasContextsTable = false;
  }
  return hasContextsTable;
}

// ─── GET /api/contexts ───────────────────────────────────────────────
router.get('/contexts', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const p = await db.getPool();
    if (!(await checkContexts(p))) {
      return res.json({ data: [], total: 0, available: false, message: 'Contexts table not found.' });
    }

    const result = await timedRequest(p, 'contexts-list', res).query(`
      SELECT ctx.*,
          mgr."displayName" AS managerDisplayName,
          mgr.email AS managerEmail,
          parent."displayName" AS parentDisplayName
      FROM "Contexts" ctx
      LEFT JOIN "Principals" mgr ON ctx."managerId" = mgr.id
      LEFT JOIN "Contexts" parent ON ctx."parentContextId" = parent.id
      WHERE 1=1
      ORDER BY ctx."displayName"
    `);

    res.json({ data: result.recordset, total: result.recordset.length, available: true });
  } catch (err) {
    console.error('GET /contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to load contexts' });
  }
});

// ─── GET /api/contexts/tree ──────────────────────────────────────────
router.get('/contexts/tree', async (req, res) => {
  try {
    if (!useSql) return res.json([]);

    const p = await db.getPool();
    if (!(await checkContexts(p))) {
      return res.json([]);
    }

    const result = await timedRequest(p, 'contexts-tree', res).query(`
      SELECT ctx.id, ctx."displayName", ctx."contextType", ctx."parentContextId",
             ctx."memberCount", ctx."totalMemberCount", ctx."managerId", ctx.department,
             mgr."displayName" AS managerDisplayName
      FROM "Contexts" ctx
      LEFT JOIN "Principals" mgr ON ctx."managerId" = mgr.id
      WHERE 1=1
      ORDER BY ctx."displayName"
    `);

    const rows = result.recordset;
    if (rows.length === 0) return res.json([]);

    // Build tree in memory
    const map = new Map();
    rows.forEach(r => map.set(r.id, { ...r, children: [] }));

    const roots = [];
    map.forEach(node => {
      if (node.parentContextId && map.has(node.parentContextId)) {
        map.get(node.parentContextId).children.push(node);
      } else {
        roots.push(node);
      }
    });

    // Sort children by displayName at each level
    function sortChildren(node) {
      node.children.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      node.children.forEach(sortChildren);
    }
    roots.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    roots.forEach(sortChildren);

    res.json(roots);
  } catch (err) {
    console.error('GET /contexts/tree failed:', err.message);
    res.status(500).json({ error: 'Failed to load context tree' });
  }
});

// ─── GET /api/contexts/:id ───────────────────────────────────────────
router.get('/contexts/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });

  try {
    if (!useSql) return res.json({ attributes: null, members: [], subContexts: [] });

    const p = await db.getPool();
    if (!(await checkContexts(p))) {
      return res.status(404).json({ error: 'Contexts table not found' });
    }

    // 1. Context attributes
    const attrResult = await timedRequest(p, 'context-detail', res)
      .input('id', req.params.id)
      .query(`SELECT * FROM "Contexts" WHERE id = @id`);

    if (attrResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Context not found' });
    }

    // 2. Members — try two paths:
    //    a) Through Identities → IdentityMembers → Principals (when account correlation has run)
    //    b) Direct match: Principals where department = context.department (derived contexts)
    let members = [];
    const ctx = attrResult.recordset[0];
    try {
      const membersResult = await timedRequest(p, 'context-members', res)
        .input('id', req.params.id)
        .query(`
          SELECT p.id, p."displayName", p.email, p."jobTitle", p."accountEnabled", p."principalType"
          FROM "Identities" i
          INNER JOIN "IdentityMembers" im ON im."identityId" = i.id
          INNER JOIN "Principals" p ON p.id = im."principalId"
          WHERE i."contextId" = @id
          ORDER BY p."displayName"
        `);
      members = membersResult.recordset;
    } catch { /* IdentityMembers table may not exist yet */ }

    // Fallback: for derived contexts (sourceType='derived'), look up principals
    // directly by department name. This works even without account correlation.
    if (members.length === 0 && ctx.department) {
      try {
        const directResult = await timedRequest(p, 'context-members-direct', res)
          .input('dept', ctx.department)
          .input('sysId', ctx.systemId)
          .query(`
            SELECT id, "displayName", email, "jobTitle", "accountEnabled", "principalType"
            FROM "Principals"
            WHERE department = @dept
              AND ("systemId" = @sysId OR "systemId" IS NULL)
            ORDER BY "displayName"
            LIMIT 500
          `);
        members = directResult.recordset;
      } catch { /* ignore */ }
    }

    // 3. Sub-contexts
    let subContexts = [];
    try {
      const subResult = await timedRequest(p, 'context-subcontexts', res)
        .input('id', req.params.id)
        .query(`
          SELECT id, "displayName", "memberCount"
          FROM "Contexts"
          WHERE "parentContextId" = @id
          ORDER BY "displayName"
        `);
      subContexts = subResult.recordset;
    } catch { /* ignore */ }

    res.json({
      attributes: attrResult.recordset[0],
      members,
      subContexts,
    });
  } catch (err) {
    console.error('GET /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load context details' });
  }
});

// ─── GET /api/contexts/:id/members ──────────────────────────────────
router.get('/contexts/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });

  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const p = await db.getPool();
    if (!(await checkContexts(p))) {
      return res.json({ data: [], total: 0 });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const search = (req.query.search || '').trim().slice(0, 200);

    const request = timedRequest(p, 'context-members-paged', res);
    request.input('id', req.params.id);
    request.input('limit', limit);
    request.input('offset', offset);

    // Members resolved through Identities → IdentityMembers → Principals
    let where = `i.contextId = @id AND i.ValidTo = '9999-12-31 23:59:59.9999999' AND p.ValidTo = '9999-12-31 23:59:59.9999999'`;
    if (search) {
      where += ` AND (p.displayName LIKE @search OR p.email LIKE @search OR p.jobTitle LIKE @search)`;
      request.input('search', `%${search}%`);
    }

    const result = await request.query(`
      SELECT p.id, p."displayName", p.email, p."jobTitle", p."accountEnabled", p."principalType"
      FROM "Identities" i
      INNER JOIN "IdentityMembers" im ON im."identityId" = i.id
      INNER JOIN "Principals" p ON p.id = im."principalId"
      WHERE ${where}
      ORDER BY p."displayName"
      LIMIT @limit OFFSET @offset;

      SELECT COUNT(*) AS total
      FROM "Identities" i
      INNER JOIN "IdentityMembers" im ON im."identityId" = i.id
      INNER JOIN "Principals" p ON p.id = im."principalId"
      WHERE ${where};
    `);

    res.json({
      data: result.recordsets[0],
      total: result.recordsets[1][0].total,
    });
  } catch (err) {
    console.error('GET /contexts/:id/members failed:', err.message);
    res.status(500).json({ error: 'Failed to load context members' });
  }
});

// Export the detection helper so orgChart.js can use it
export { checkContexts };
export default router;
