// ─── Contexts API Routes (v6) ─────────────────────────────────────────
//
// Unified context model — three variants (synced / generated / manual) and
// four target types (Identity / Resource / Principal / System). Membership
// lives in its own ContextMembers table.
//
// See docs/architecture/context-redesign.md for the design.
//
// GET    /api/contexts                       — list roots (group-by target / variant)
// GET    /api/contexts/tree?root=<id>        — subtree for one root
// GET    /api/contexts/:id                   — detail + direct members + sub-contexts
// GET    /api/contexts/:id/members           — paginated members (search + limit/offset)
// POST   /api/contexts                       — create manual context
// PATCH  /api/contexts/:id                   — update manual context (name, description, parent, owner)
// DELETE /api/contexts/:id                   — delete manual context (cascades members + manual sub-contexts)
// POST   /api/contexts/:id/members           — add a member (manual contexts only)
// DELETE /api/contexts/:id/members/:memberId — remove a member (manual contexts only)

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../db/connection.js';
import { recalcMemberCountsForChain } from '../contexts/memberCounts.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANTS = new Set(['synced', 'generated', 'manual']);
const TARGET_TYPES = new Set(['Identity', 'Resource', 'Principal', 'System']);
const ADDED_BY = new Set(['sync', 'algorithm', 'analyst']);

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
        SELECT id, variant, "targetType", "contextType", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount"
          FROM descendants
         ORDER BY "displayName"
      `, [rootParam])).rows;
    } else {
      rows = (await db.query(`
        SELECT id, variant, "targetType", "contextType", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount"
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

// ─── POST /api/contexts ──────────────────────────────────────────────
// Create a manual context. Body: { targetType, contextType, displayName,
// description?, parentContextId?, scopeSystemId?, ownerUserId?, externalId? }.
router.post('/contexts', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};

  if (!TARGET_TYPES.has(body.targetType)) return res.status(400).json({ error: 'targetType is required' });
  if (!body.contextType || typeof body.contextType !== 'string') return res.status(400).json({ error: 'contextType is required' });
  if (!body.displayName  || typeof body.displayName  !== 'string') return res.status(400).json({ error: 'displayName is required' });

  const id = randomUUID();
  const createdBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';

  try {
    // If a parent is supplied, enforce the invariant: same targetType, and no cycle.
    if (body.parentContextId) {
      if (!UUID_RE.test(body.parentContextId)) return res.status(400).json({ error: 'Invalid parentContextId' });
      const parent = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [body.parentContextId]);
      if (!parent) return res.status(400).json({ error: 'Parent context not found' });
      if (parent.targetType !== body.targetType) {
        return res.status(400).json({ error: 'Parent context has a different targetType' });
      }
    }

    await db.query(`
      INSERT INTO "Contexts"
        (id, variant, "targetType", "contextType", "displayName", description,
         "parentContextId", "scopeSystemId", "createdByUser", "ownerUserId", "externalId")
      VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      id,
      body.targetType,
      body.contextType.slice(0, 100),
      body.displayName.slice(0, 500),
      body.description || null,
      body.parentContextId || null,
      body.scopeSystemId ? parseInt(body.scopeSystemId, 10) : null,
      createdBy,
      body.ownerUserId || null,
      body.externalId || null,
    ]);

    const row = await db.queryOne(`SELECT * FROM "Contexts" WHERE id = $1`, [id]);
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to create context' });
  }
});

// ─── PATCH /api/contexts/:id ─────────────────────────────────────────
// Update a manual context. Body keys: displayName, description,
// parentContextId, ownerUserId, extendedAttributes. Others are ignored
// (variant, targetType, sourceAlgorithmId are immutable after creation).
router.patch('/contexts/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant, "targetType" FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  if (ctx.variant !== 'manual') return res.status(400).json({ error: 'Only manual contexts can be edited' });

  const body = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  if (typeof body.displayName === 'string')              push('displayName', body.displayName.slice(0, 500));
  if (typeof body.description === 'string' || body.description === null) push('description', body.description);
  if (typeof body.ownerUserId === 'string' || body.ownerUserId === null) push('ownerUserId', body.ownerUserId);
  if (body.extendedAttributes !== undefined)             push('extendedAttributes', body.extendedAttributes);

  if (body.parentContextId !== undefined) {
    if (body.parentContextId === null) {
      push('parentContextId', null);
    } else {
      if (!UUID_RE.test(body.parentContextId)) return res.status(400).json({ error: 'Invalid parentContextId' });
      if (body.parentContextId === req.params.id) return res.status(400).json({ error: 'Cannot parent a context to itself' });
      const parent = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [body.parentContextId]);
      if (!parent) return res.status(400).json({ error: 'Parent context not found' });
      if (parent.targetType !== ctx.targetType) return res.status(400).json({ error: 'Parent has a different targetType' });
      // Prevent cycles — walk up from proposed parent, reject if we hit this id.
      let p = body.parentContextId;
      for (let hop = 0; hop < 50 && p; hop++) {
        const up = await db.queryOne(`SELECT "parentContextId" FROM "Contexts" WHERE id = $1`, [p]);
        if (!up) break;
        if (up.parentContextId === req.params.id) return res.status(400).json({ error: 'Proposed parent would create a cycle' });
        p = up.parentContextId;
      }
      push('parentContextId', body.parentContextId);
    }
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

  params.push(req.params.id);
  try {
    await db.query(`UPDATE "Contexts" SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const row = await db.queryOne(`SELECT * FROM "Contexts" WHERE id = $1`, [req.params.id]);
    res.json(row);
  } catch (err) {
    console.error('PATCH /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update context' });
  }
});

// ─── DELETE /api/contexts/:id ────────────────────────────────────────
// Manual and generated contexts are both deletable here. Synced contexts
// are owned by their source system (crawler) and re-created on the next
// crawl — deleting them through the API would just get them back.
//
// Deleting a generated context is legitimate when the analyst spots a
// low-signal cluster and wants it gone; re-running the same plugin with
// the same parameters will re-create it, so for persistent removal the
// caller should also adjust plugin parameters (e.g., additionalStopwords).
router.delete('/contexts/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  if (ctx.variant === 'synced') {
    return res.status(400).json({
      error: 'Synced contexts are owned by their source system and can\'t be deleted via the API — remove the upstream record instead.',
    });
  }

  try {
    // ON DELETE CASCADE on parentContextId + the ContextMembers FK handles the rest.
    await db.query(`DELETE FROM "Contexts" WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete context' });
  }
});

// ─── POST /api/contexts/:id/members ──────────────────────────────────
// Add a member to a manual or generated context. Body: { memberId }.
//
// Synced contexts are rejected because the source system owns them —
// the next crawl would wipe the addition. Manual and generated are both
// OK: the plugin runner's reconcile step only deletes ContextMembers
// rows with addedBy='algorithm', so an analyst-added row (addedBy=
// 'analyst') survives every subsequent plugin run.
router.post('/contexts/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant, "targetType" FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  if (ctx.variant === 'synced') {
    return res.status(400).json({ error: 'Synced contexts are owned by their source system — add the member upstream instead.' });
  }

  const { memberId } = req.body || {};
  if (!memberId || !UUID_RE.test(memberId)) return res.status(400).json({ error: 'memberId (uuid) is required' });

  try {
    await db.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      VALUES ($1, $2, $3, 'analyst')
      ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, [req.params.id, ctx.targetType, memberId]);
    await recalcMemberCountsForChain(req.params.id);
    res.status(201).json({ contextId: req.params.id, memberId, memberType: ctx.targetType });
  } catch (err) {
    console.error('POST /contexts/:id/members failed:', err.message);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// ─── DELETE /api/contexts/:id/members/:memberId ──────────────────────
// Removal rules mirror POST: manual + generated OK, synced rejected.
router.delete('/contexts/:id/members/:memberId', async (req, res) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.memberId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  if (ctx.variant === 'synced') {
    return res.status(400).json({ error: 'Synced contexts are owned by their source system.' });
  }

  try {
    await db.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [req.params.id, req.params.memberId]);
    await recalcMemberCountsForChain(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /contexts/:id/members/:memberId failed:', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
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

// (recalcDirectMemberCount has been replaced by the shared
// recalcMemberCountsForChain helper in contexts/memberCounts.js, which also
// rolls up totalMemberCount on every ancestor.)

export default router;
