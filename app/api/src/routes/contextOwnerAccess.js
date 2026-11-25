// Admin → Roles & Permissions → Relative permissions: the grid of what people
// get because they answer for something (auth/relativePermissions.js).
//
// GET /api/admin/context-owner-access  → { subjects, policy }
//   subjects  the grid's rows: [{ subject, kind, capabilities }] — every
//             role-bearing context template, then BusinessRole
//   policy    { [subject]: { Accountable: { [capability]: boolean }, Responsible: … } }
// PUT /api/admin/context-owner-access  body { policy } → the same as GET
//   The whole grid is sent and saved; a subject, role or capability left out is
//   off. Unknown names or non-boolean values answer 400. View-dependent
//   capabilities (subUnits, mcp) are saved off where view is off.
//
// Both routes need admin.auth: the grid decides who may sign in, the same gate
// as the role mapping it sits beside.

import { Router } from 'express';
import * as db from '../db/connection.js';
import { loadOwnerTree } from '../auth/ownerTree.js';
import { requirePermission } from '../middleware/auth.js';
import { getRelativePolicy, setRelativePolicy } from '../auth/contextOwnerSetting.js';
import { relativeSubjects, validatePolicy } from '../auth/relativePermissions.js';

const router = Router();
const adminAuth = requirePermission('admin.auth');

const current = async () => ({ subjects: relativeSubjects(), policy: await getRelativePolicy() });

router.get('/admin/context-owner-access', adminAuth, async (req, res) => {
  res.json(await current());
});

router.put('/admin/context-owner-access', adminAuth, async (req, res) => {
  const checked = validatePolicy(req.body?.policy);
  if (checked.error) return res.status(400).json({ error: checked.error });
  try {
    await setRelativePolicy(checked.policy);
    return res.json(await current());
  } catch (err) {
    console.error('PUT /admin/context-owner-access failed:', err.message);
    return res.status(500).json({ error: 'Failed to save the setting' });
  }
});

// The signed-in owner's own tree (auth/ownerTree.js), built from the scope the
// auth middleware resolved for them. Anyone who is not an owner has none.
router.get('/context-owner/tree', async (req, res) => {
  const owner = req.user?.contextOwner;
  if (!owner) return res.json([]);
  try {
    res.json(await loadOwnerTree(db, owner));
  } catch (err) {
    console.error('GET /context-owner/tree failed:', err.message);
    res.status(500).json({ error: 'Failed to load your contexts' });
  }
});

export default router;
