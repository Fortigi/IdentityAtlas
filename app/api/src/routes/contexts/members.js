// Context membership write endpoints — POST /api/contexts/:id/members,
// DELETE /contexts/:id/members/:memberId and PATCH /contexts/:id/members/:memberId/move.
//
// Extracted verbatim from routes/contexts.js (audit finding C1). Mounted by
// routes/contexts.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { recalcMemberCountsForChain } from '../../contexts/memberCounts.js';
import { useSql, UUID_RE, writeContexts } from './shared.js';

const router = Router();

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


export default router;
