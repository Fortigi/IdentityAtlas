// Admin → Roles & Permissions → Relative permissions: the context-owner switches.
//
// GET /api/admin/context-owner-access  → { enabled, mcp }
// PUT /api/admin/context-owner-access  body { enabled?: boolean, mcp?: boolean } → { enabled, mcp }
//
// `enabled`: a person who is Accountable or Responsible for a context can sign in
// without an Identity Atlas role and see that context, its report and its
// workflows — nothing else (docs/architecture/context-owner-access.md).
// `mcp`: such a person may also use the MCP server from an AI assistant, under
// exactly the same scope (docs/architecture/mcp-authorization.md). It only has
// effect while `enabled` is on; the stored value is shown as it is.
//
// Both routes need admin.auth: the switches decide who may sign in, the same
// gate as the role mapping they sit beside.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import {
  isContextOwnerAccessEnabled, setContextOwnerAccess, getContextOwnerMcpSwitch, setContextOwnerMcp,
} from '../auth/contextOwnerSetting.js';

const router = Router();
const adminAuth = requirePermission('admin.auth');

async function current() {
  return { enabled: await isContextOwnerAccessEnabled(), mcp: await getContextOwnerMcpSwitch() };
}

router.get('/admin/context-owner-access', adminAuth, async (req, res) => {
  res.json(await current());
});

router.put('/admin/context-owner-access', adminAuth, async (req, res) => {
  const { enabled, mcp } = req.body || {};
  const given = [enabled, mcp].filter(v => v !== undefined);
  if (given.length === 0 || given.some(v => typeof v !== 'boolean')) {
    return res.status(400).json({ error: 'enabled and mcp must be booleans, and at least one is required' });
  }
  try {
    if (enabled !== undefined) await setContextOwnerAccess(enabled);
    if (mcp !== undefined) await setContextOwnerMcp(mcp);
    res.json(await current());
  } catch (err) {
    console.error('PUT /admin/context-owner-access failed:', err.message);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

export default router;
