// Context write endpoints — POST /api/contexts (create), PATCH /contexts/:id
// (update), POST /contexts/:id/sync and DELETE /contexts/:id.
//
// The create/update validation + update-building lives in ./crudHelpers.js so
// the handlers stay thin. Extracted from routes/contexts.js (audit finding C1)
// and further decomposed for complexity (#1032) — the public paths are
// unchanged and no behaviour differs.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../../db/connection.js';
import { recalcMemberCountsForChain } from '../../contexts/memberCounts.js';
import { enqueueRun } from '../../contexts/plugins/runner.js';
import { useSql, UUID_RE, writeContexts } from './shared.js';
import { validateCreateContextBody, checkCreateParent, buildContextUpdate } from './crudHelpers.js';

const router = Router();

// ─── POST /api/contexts ──────────────────────────────────────────────
// Create a manual context. Body: { targetType, contextType, displayName,
// description?, parentContextId?, scopeSystemId?, ownerUserId?, externalId? }.
router.post('/contexts', writeContexts, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};

  const invalid = validateCreateContextBody(body);
  if (invalid) return res.status(invalid.status).json({ error: invalid.message });

  const id = randomUUID();
  const createdBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';

  try {
    // If a parent is supplied, enforce the invariant: same targetType, exists.
    if (body.parentContextId) {
      const parentErr = await checkCreateParent(body);
      if (parentErr) return res.status(parentErr.status).json({ error: parentErr.message });
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
// Update a manual or generated context. Body keys: displayName, description,
// parentContextId, ownerUserId, extendedAttributes. Immutable fields (variant,
// targetType, sourceAlgorithmId) are ignored; synced contexts are read-only.
router.patch('/contexts/:id', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const ctx = await db.queryOne(`SELECT variant, "targetType", "displayName", "parentContextId" FROM "Contexts" WHERE id = $1`, [req.params.id]);
  if (!ctx) return res.status(404).json({ error: 'Context not found' });
  // Only synced contexts (mirrored from a source system) are locked.
  if (ctx.variant === 'synced') return res.status(400).json({ error: 'Synced contexts are read-only (managed by their source system)' });

  const built = await buildContextUpdate(req.params.id, req.body || {}, ctx, ctx.variant === 'generated');
  if (built.error) return res.status(built.error.status).json({ error: built.error.message });

  const { sets, params, parentChanged, oldParentId, newParentId } = built;
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
