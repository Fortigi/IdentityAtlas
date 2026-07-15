// Per-account analyst-override endpoints — PUT/DELETE
// /api/identities/:id/members/:userId/override (confirm/reject/clear).
//
// Extracted verbatim from routes/identities.js (audit finding C1). Mounted by
// routes/identities.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { requirePermission } from '../../middleware/auth.js';
import { useSql, db, UUID_RE } from './shared.js';

const router = Router();

const writeIdentity = requirePermission('data.write.identity');

router.put('/identities/:id/members/:userId/override', writeIdentity, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const { id: identityId, userId } = req.params;
  if (!UUID_RE.test(identityId) || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const { action } = req.body || {};
  if (!action || !['confirmed', 'rejected', 'moved'].includes(action)) {
    return res.status(400).json({ error: 'Action must be one of: confirmed, rejected, moved' });
  }

  try {
    const p = await db.getPool();
    await timedQuery(p, 'identity-member-override', res, `
        UPDATE "IdentityMembers"
        SET "analystOverride" = $3
        WHERE "identityId" = $1 AND "principalId" = $2
      `, [identityId, userId, action]);

    res.json({ success: true, action });
  } catch (err) {
    console.error('Error setting member override:', err.message);
    res.status(500).json({ error: 'Failed to set member override' });
  }
});

// GET /api/identities/by-user/:userId — returns the identity a user belongs to (if any)
// DELETE /api/identities/:id/members/:userId/override — remove analyst override
router.delete('/identities/:id/members/:userId/override', writeIdentity, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const { id: identityId, userId } = req.params;
  if (!UUID_RE.test(identityId) || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  try {
    const p = await db.getPool();
    await timedQuery(p, 'identity-member-remove-override', res, `
        UPDATE "IdentityMembers"
        SET "analystOverride" = NULL
        WHERE "identityId" = $1 AND "principalId" = $2
      `, [identityId, userId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing member override:', err.message);
    res.status(500).json({ error: 'Failed to remove member override' });
  }
});

export default router;
