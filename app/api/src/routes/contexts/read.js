// Context read endpoints — GET /api/contexts (roots), /contexts/tree,
// /contexts/:id (detail) and /contexts/:id/members (paginated).
//
// Extracted verbatim from routes/contexts.js (audit finding C1). Mounted by
// routes/contexts.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE, TARGET_TYPES } from './shared.js';

const router = Router();

const VARIANTS = new Set(['synced', 'generated', 'manual']);

// Map targetType → the table name where memberIds live. Used to filter the
// member list to live rows only (stale member rows are left to a background
// reconciler, not this endpoint).
const MEMBER_TABLE = {
  Identity:  'Identities',
  Resource:  'Resources',
  Principal: 'Principals',
  System:    'Systems',
};

// ─── GET /api/contexts ───────────────────────────────────────────────
// List all root contexts (parentContextId IS NULL). Optional filters:
// ?targetType, ?variant, ?contextType, ?scopeSystemId.
router.get('/contexts', async (req, res) => {
  if (!useSql) return res.json({ data: [], total: 0 });
  try {
    const clauses = ['c."parentContextId" IS NULL'];
    const params = [];
    const pushFilter = (col, val) => {
      params.push(val);
      clauses.push(`c."${col}" = $${params.length}`);
    };
    if (req.query.targetType && TARGET_TYPES.has(req.query.targetType))    pushFilter('targetType', req.query.targetType);
    if (req.query.variant     && VARIANTS.has(req.query.variant))          pushFilter('variant', req.query.variant);
    if (req.query.contextType) pushFilter('contextType', String(req.query.contextType).slice(0, 100));
    if (req.query.scopeSystemId) {
      const sys = parseInt(req.query.scopeSystemId, 10);
      if (!Number.isNaN(sys)) pushFilter('scopeSystemId', sys);
    }

    const r = await db.query(`
      SELECT c.id, c.variant, c."targetType", c."contextType", c."displayName",
             c.description, c."scopeSystemId", c."sourceAlgorithmId", c."ownerUserId",
             c."createdByUser", c."externalId", c."directMemberCount", c."totalMemberCount",
             c."userRenamed", c."userReparented", c."sourceInstanceKey",
             c."lastCalculatedAt", c."createdAt", c."updatedAt",
             s."displayName" AS "scopeSystemName",
             a.name AS "sourceAlgorithmName",
             a."displayName" AS "sourceAlgorithmDisplayName"
        FROM "Contexts" c
        LEFT JOIN "Systems" s ON c."scopeSystemId" = s.id
        LEFT JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id
       WHERE ${clauses.join(' AND ')}
       ORDER BY c."contextType", COALESCE(c."totalMemberCount", 0) DESC, c."displayName"
    `, params);

    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('GET /contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to load contexts' });
  }
});

// ─── GET /api/contexts/tree ──────────────────────────────────────────
// Build a nested tree. With ?root=<id>, returns that subtree. Without,
// returns an array with one entry per root context (every root at top level).
router.get('/contexts/tree', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const rootParam = req.query.root;
    let rows;
    if (rootParam) {
      if (!UUID_RE.test(rootParam)) return res.status(400).json({ error: 'Invalid root id' });
      rows = (await db.query(`
        WITH RECURSIVE descendants AS (
          SELECT * FROM "Contexts" WHERE id = $1
          UNION ALL
          SELECT c.* FROM "Contexts" c JOIN descendants d ON c."parentContextId" = d.id
        )
        -- CYCLE guard: a corrupt parent chain (A→B→A) would otherwise recurse
        -- forever. PG stops descending the moment an id repeats on the path.
        CYCLE id SET "isCycle" USING "cyclePath"
        SELECT id, variant, "targetType", "contextType", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount", "userRenamed", "userReparented"
          FROM descendants
         ORDER BY "displayName"
      `, [rootParam])).rows;
    } else {
      rows = (await db.query(`
        SELECT id, variant, "targetType", "contextType", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount", "userRenamed", "userReparented"
          FROM "Contexts"
         ORDER BY "contextType", "displayName"
      `)).rows;
    }

    if (rows.length === 0) return res.json([]);

    // Build nested structure by parentContextId.
    const byId = new Map();
    rows.forEach(r => byId.set(r.id, { ...r, children: [] }));
    const roots = [];
    byId.forEach(node => {
      if (node.parentContextId && byId.has(node.parentContextId)) {
        byId.get(node.parentContextId).children.push(node);
      } else {
        roots.push(node);
      }
    });

    // Sort by totalMemberCount DESC, then displayName ASC as tiebreaker.
    // Largest subtrees bubble to the top in every level — much more useful
    // than alphabetic for org-sized trees (99 departments, 500 managers).
    const cmp = (a, b) => {
      const at = a.totalMemberCount || 0;
      const bt = b.totalMemberCount || 0;
      if (at !== bt) return bt - at;
      return (a.displayName || '').localeCompare(b.displayName || '');
    };
    const sortRec = n => { n.children.sort(cmp); n.children.forEach(sortRec); };
    roots.sort(cmp);
    roots.forEach(sortRec);

    res.json(roots);
  } catch (err) {
    console.error('GET /contexts/tree failed:', err.message);
    res.status(500).json({ error: 'Failed to load context tree' });
  }
});

// ─── GET /api/contexts/:id ───────────────────────────────────────────
router.get('/contexts/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: null, members: [], subContexts: [] });

  try {
    const attr = await db.queryOne(`
      SELECT c.*, s."displayName" AS "scopeSystemName",
             a.name AS "sourceAlgorithmName",
             a."displayName" AS "sourceAlgorithmDisplayName",
             parent."displayName" AS "parentDisplayName"
        FROM "Contexts" c
        LEFT JOIN "Systems" s           ON c."scopeSystemId" = s.id
        LEFT JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id
        LEFT JOIN "Contexts" parent     ON c."parentContextId" = parent.id
       WHERE c.id = $1
    `, [req.params.id]);

    if (!attr) return res.status(404).json({ error: 'Context not found' });

    const members = await loadMembers(req.params.id, attr.targetType, { limit: 50 });

    const subs = (await db.query(`
      SELECT id, variant, "targetType", "contextType", "displayName",
             "directMemberCount", "totalMemberCount"
        FROM "Contexts"
       WHERE "parentContextId" = $1
       ORDER BY "displayName"
    `, [req.params.id])).rows;

    res.json({ attributes: attr, members, subContexts: subs });
  } catch (err) {
    console.error('GET /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load context details' });
  }
});

// ─── GET /api/contexts/:id/members ───────────────────────────────────
// Paginated members. Optional ?search filters on the member's display name.
router.get('/contexts/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ data: [], total: 0 });

  try {
    const ctx = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = (req.query.search || '').toString().trim().slice(0, 200);
    const includeDescendants = req.query.include === 'descendants';

    const { rows, total } = await loadMembers(req.params.id, ctx.targetType, {
      limit, offset, search, withTotal: true, includeDescendants,
    });
    res.json({ data: rows, total });
  } catch (err) {
    console.error('GET /contexts/:id/members failed:', err.message);
    res.status(500).json({ error: 'Failed to load context members' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function loadMembers(contextId, targetType, { limit = 100, offset = 0, search = '', withTotal = false, includeDescendants = false } = {}) {
  const table = MEMBER_TABLE[targetType];
  if (!table) return withTotal ? { rows: [], total: 0 } : [];

  // When includeDescendants=true, we expand $1 into "this context plus every
  // descendant" via a recursive CTE. The selected member rows are then
  // de-duplicated on memberId (a person could theoretically be a direct
  // member of two sub-contexts; we only want them once).
  const contextSet = includeDescendants
    ? `(
        WITH RECURSIVE subtree AS (
          SELECT id FROM "Contexts" WHERE id = $1
          UNION ALL
          SELECT c.id FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.id
        )
        -- CYCLE guard: corrupt parent chains must not recurse forever.
        CYCLE id SET "isCycle" USING "cyclePath"
        SELECT id FROM subtree
      )`
    : null;

  // Identity / Resource / Principal all have displayName. Systems have
  // displayName too. Keep the projection uniform.
  const params = [contextId];
  let searchClause = '';
  if (search) {
    params.push(`%${search}%`);
    searchClause = ` AND m."displayName" ILIKE $${params.length}`;
  }

  const contextFilter = includeDescendants
    ? `cm."contextId" IN ${contextSet}`
    : `cm."contextId" = $1`;

  // When descendants are included we dedupe on memberId so siblings don't
  // produce duplicates. The DISTINCT adds a small sort cost but matters for
  // accurate counts and pagination.
  const distinct = includeDescendants ? 'DISTINCT ON (m.id)' : '';

  const dataSql = `
    SELECT ${distinct} m.id, m."displayName",
           cm."addedBy", cm."addedAt"
      FROM "ContextMembers" cm
      JOIN "${table}" m ON m.id::text = cm."memberId"::text
     WHERE ${contextFilter}
       AND cm."memberType" = '${targetType}'
       ${searchClause}
     ORDER BY ${includeDescendants ? 'm.id, ' : ''}m."displayName"
     LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
  `;
  const rows = (await db.query(dataSql, params)).rows;
  if (!withTotal) return rows;

  const countSql = `
    SELECT COUNT(${includeDescendants ? 'DISTINCT m.id' : '*'})::int AS total
      FROM "ContextMembers" cm
      JOIN "${table}" m ON m.id::text = cm."memberId"::text
     WHERE ${contextFilter}
       AND cm."memberType" = '${targetType}'
       ${searchClause}
  `;
  const total = (await db.queryOne(countSql, params))?.total || 0;
  return { rows, total };
}

export default router;
