// Admin → Authentication: the context-owner access switch.
//
// GET /api/admin/context-owner-access  → { enabled }
// PUT /api/admin/context-owner-access  body { enabled: boolean } → { enabled }
//
// When on, a person who is Accountable or Responsible for a context can sign in
// without an Identity Atlas role and see that context, its report and its
// workflows — nothing else (docs/architecture/context-owner-access.md). Both
// routes need admin.auth: the switch decides who may sign in, which is the
// Authentication page's business.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { isContextOwnerAccessEnabled, setContextOwnerAccess } from '../auth/contextOwnerSetting.js';

const router = Router();
const adminAuth = requirePermission('admin.auth');

router.get('/admin/context-owner-access', adminAuth, async (req, res) => {
  res.json({ enabled: await isContextOwnerAccessEnabled() });
});

router.put('/admin/context-owner-access', adminAuth, async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  try {
    res.json({ enabled: await setContextOwnerAccess(enabled) });
  } catch (err) {
    console.error('PUT /admin/context-owner-access failed:', err.message);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

export default router;
