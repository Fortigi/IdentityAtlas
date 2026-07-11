// Context write endpoints — POST /api/contexts (create), PATCH /contexts/:id
// (update), POST /contexts/:id/sync and DELETE /contexts/:id.
//
// Extracted verbatim from routes/contexts.js (audit finding C1). Mounted by
// routes/contexts.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../../db/connection.js';
import { recalcMemberCountsForChain } from '../../contexts/memberCounts.js';
import { wouldCreateCycle } from '../../contexts/cycleGuard.js';
import { enqueueRun } from '../../contexts/plugins/runner.js';
import { useSql, UUID_RE, TARGET_TYPES, writeContexts } from './shared.js';

const router = Router();

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
    res.status(500).json({ error: 'Failed to sync tree' });
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


export default router;
