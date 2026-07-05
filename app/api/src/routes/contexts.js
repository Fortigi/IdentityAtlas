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
import { wouldCreateCycle } from '../contexts/cycleGuard.js';
import { enqueueRun } from '../contexts/plugins/runner.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
// Same admin who configures context-algorithm plugins owns the resulting
// contexts (and manual contexts edited here through the UI).
const writeContexts = requirePermission('admin.context-plugins');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANTS = new Set(['synced', 'generated', 'manual']);
const TARGET_TYPES = new Set(['Identity', 'Resource', 'Principal', 'System']);

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

// ─── POST /api/contexts ──────────────────────────────────────────────
// Create a manual context. Body: { targetType, contextType, displayName,
// description?, parentContextId?, scopeSystemId?, ownerUserId?, externalId? }.
router.post('/contexts', writeContexts, async (req, res) => {
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
router.patch('/contexts/:id', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant, "targetType", "displayName", "parentContextId" FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  // Manual and generated (plugin) contexts can be renamed / re-parented by the
  // analyst. Only synced contexts (mirrored from a source system) are locked.
  // For generated contexts we record per-field "userRenamed"/"userReparented"
  // flags so (a) the UI can mark the node as analyst-curated and (b) the plugin
  // runner keeps the edit instead of overwriting it on the next run.
  if (ctx.variant === 'synced') return res.status(400).json({ error: 'Synced contexts are read-only (managed by their source system)' });
  const isGenerated = ctx.variant === 'generated';

  const body = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  if (typeof body.displayName === 'string') {
    const name = body.displayName.slice(0, 500);
    push('displayName', name);
    // Mark a generated node as analyst-renamed once its name actually diverges.
    if (isGenerated && name !== (ctx.displayName || '')) push('userRenamed', true);
  }
  if (typeof body.description === 'string' || body.description === null) push('description', body.description);
  if (typeof body.ownerUserId === 'string' || body.ownerUserId === null) push('ownerUserId', body.ownerUserId);
  if (body.extendedAttributes !== undefined)             push('extendedAttributes', body.extendedAttributes);

  // Track a parent change so we can recompute member counts on both the old and
  // new ancestor chains afterwards (a moved subtree leaves one branch and joins
  // another — both branches' totalMemberCount roll-ups go stale otherwise).
  let parentChanged = false;
  const oldParentId = ctx.parentContextId || null;
  let newParentId = oldParentId;

  if (body.parentContextId !== undefined) {
    if (body.parentContextId === null) {
      newParentId = null;
      parentChanged = oldParentId !== null;
      push('parentContextId', null);
    } else {
      if (!UUID_RE.test(body.parentContextId)) return res.status(400).json({ error: 'Invalid parentContextId' });
      if (body.parentContextId === req.params.id) return res.status(400).json({ error: 'Cannot parent a context to itself' });
      const parent = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [body.parentContextId]);
      if (!parent) return res.status(400).json({ error: 'Parent context not found' });
      if (parent.targetType !== ctx.targetType) return res.status(400).json({ error: 'Parent has a different targetType' });
      // Prevent cycles at any depth. The old fixed-50-hop JS walk silently
      // passed trees deeper than 50; the shared guard uses a CYCLE-safe query.
      if (await wouldCreateCycle(db, req.params.id, body.parentContextId)) {
        return res.status(400).json({ error: 'Proposed parent would create a cycle' });
      }
      newParentId = body.parentContextId;
      parentChanged = oldParentId !== newParentId;
      push('parentContextId', body.parentContextId);
    }
    if (isGenerated && parentChanged) push('userReparented', true);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

  params.push(req.params.id);
  try {
    await db.query(`UPDATE "Contexts" SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    // A reparent moves this node's whole subtree between two branches. Refresh
    // totalMemberCount on every ancestor of both the old and the new parent so
    // the counts the analyst sees in the tree stay correct.
    if (parentChanged) {
      if (oldParentId) await recalcMemberCountsForChain(oldParentId);
      if (newParentId) await recalcMemberCountsForChain(newParentId);
    }

    const row = await db.queryOne(`SELECT * FROM "Contexts" WHERE id = $1`, [req.params.id]);
    res.json(row);
  } catch (err) {
    console.error('PATCH /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update context' });
  }
});

// ─── POST /api/contexts/:id/sync ─────────────────────────────────────
// Re-run the generating plugin onto THIS tree (its own instance key + the
// parameters of the run that last wrote it), so out-of-date references update —
// e.g. a user who changed manager moves to the new node — WITHOUT discarding
// analyst edits. The runner preserves analyst renames / re-parenting and keeps
// analyst-added members and manual children; only algorithm-owned membership is
// recomputed. Returns the queued runId.
router.post('/contexts/:id/sync', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  try {
    const ctx = await db.queryOne(`
      SELECT c.id, c.variant, c."sourceAlgorithmId", c."scopeSystemId",
             c."sourceInstanceKey", c."sourceRunId", a.name AS "algorithmName"
        FROM "Contexts" c
        LEFT JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id
       WHERE c.id = $1
    `, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    if (ctx.variant !== 'generated' || !ctx.algorithmName) {
      return res.status(400).json({ error: 'Only generated (plugin) trees can be synced' });
    }

    // Replay the parameters from the run that last wrote this tree so node
    // naming etc. stay identical; fall back to just the scope if unavailable.
    let params = {};
    if (ctx.sourceRunId) {
      const run = await db.queryOne(`SELECT parameters FROM "ContextAlgorithmRuns" WHERE id = $1`, [ctx.sourceRunId]);
      if (run?.parameters) params = { ...run.parameters };
    }
    if (ctx.scopeSystemId != null) params.scopeSystemId = ctx.scopeSystemId;

    // Make sure the whole tree carries an instance key (legacy trees predate
    // them), then refresh that exact instance in place.
    let instanceKey = ctx.sourceInstanceKey;
    if (!instanceKey) {
      instanceKey = randomUUID();
      await db.query(`
        UPDATE "Contexts" SET "sourceInstanceKey" = $1
         WHERE "sourceAlgorithmId" = $2
           AND ($3::int IS NULL OR "scopeSystemId" = $3)
           AND "sourceInstanceKey" IS NULL
      `, [instanceKey, ctx.sourceAlgorithmId, ctx.scopeSystemId]);
    }
    params.instanceKey = instanceKey;

    const triggeredBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'sync';
    const runId = await enqueueRun(ctx.algorithmName, params, triggeredBy);
    res.status(202).json({ runId, instanceKey });
  } catch (err) {
    console.error('POST /contexts/:id/sync failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to sync tree' });
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
router.delete('/contexts/:id', writeContexts, async (req, res) => {
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
router.post('/contexts/:id/members', writeContexts, async (req, res) => {
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
router.delete('/contexts/:id/members/:memberId', writeContexts, async (req, res) => {
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

// ─── PATCH /api/contexts/:id/members/:memberId/move ──────────────────
// Move a member to another team in the MANAGER HIERARCHY tree, e.g. dragging a
// person onto a different manager's node. Body: { toContextId }.
//
// Because the tree is generated from Principals.managerId, the move is persisted
// as an override of who this principal reports to (the target node's manager) so
// it survives every plugin re-run — mirroring how a dragged context keeps its
// place via "userReparented". The ContextMembers row is also moved immediately
// so the tree updates without waiting for a re-run. Dropping a person back on
// their source manager clears the override.
router.patch('/contexts/:id/members/:memberId/move', writeContexts, async (req, res) => {
  const { id, memberId } = req.params;
  const { toContextId } = req.body || {};
  if (!UUID_RE.test(id) || !UUID_RE.test(memberId) || !UUID_RE.test(toContextId || '')) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (toContextId === id) return res.status(400).json({ error: 'Source and target are the same' });

  const from = await db.queryOne(`SELECT "contextType", "targetType" FROM "Contexts" WHERE id = $1`, [id]);
  const to   = await db.queryOne(`SELECT "contextType", "targetType", "externalId" FROM "Contexts" WHERE id = $1`, [toContextId]);
  if (!from || !to) return res.status(404).json({ error: 'Context not found' });
  if (from.contextType !== 'ManagerHierarchy' || to.contextType !== 'ManagerHierarchy') {
    return res.status(400).json({ error: 'Moving members is only supported in the Manager Hierarchy tree.' });
  }

  // The target node's externalId is the new manager's principal id; the synthetic
  // root ('root') means "report to no manager".
  const managerPrincipalId = UUID_RE.test(to.externalId || '') ? to.externalId : null;
  const setBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'analyst';

  try {
    // Source managerId — if the member is dropped back on it, clear the override.
    const principal = await db.queryOne(`SELECT "managerId" FROM "Principals" WHERE id = $1`, [memberId]);
    if (principal && principal.managerId === managerPrincipalId) {
      await db.query(`DELETE FROM "ManagerHierarchyOverrides" WHERE "principalId" = $1`, [memberId]);
    } else {
      await db.query(`
        INSERT INTO "ManagerHierarchyOverrides" ("principalId", "managerPrincipalId", "setBy")
        VALUES ($1, $2, $3)
        ON CONFLICT ("principalId")
        DO UPDATE SET "managerPrincipalId" = EXCLUDED."managerPrincipalId",
                      "setBy" = EXCLUDED."setBy",
                      "setAt" = (now() AT TIME ZONE 'utc')
      `, [memberId, managerPrincipalId, setBy]);
    }

    // Move the membership row now so the tree reflects it immediately.
    await db.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [id, memberId]);
    await db.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      VALUES ($1, 'Principal', $2, 'analyst')
      ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, [toContextId, memberId]);

    await recalcMemberCountsForChain(id);
    await recalcMemberCountsForChain(toContextId);
    res.json({ from: id, to: toContextId, memberId, managerPrincipalId });
  } catch (err) {
    console.error('PATCH /contexts/:id/members/:memberId/move failed:', err.message);
    res.status(500).json({ error: 'Failed to move member' });
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

// (recalcDirectMemberCount has been replaced by the shared
// recalcMemberCountsForChain helper in contexts/memberCounts.js, which also
// rolls up totalMemberCount on every ancestor.)

export default router;
