// Admin API for the role → permission mapping that drives Identity Atlas's
// permission gates. Mounted at /api/admin/roles (see index.js) and protected
// by requirePermission('admin.auth') so only users whose current mapping
// already grants admin.auth can edit the mapping.
//
// Endpoints:
//   GET    /api/admin/roles  — catalog, current mapping, current user's state
//   PUT    /api/admin/roles  — save a new mapping (with self-lockout guard)
//   DELETE /api/admin/roles  — clear the customer mapping, revert to the seed
//
// Why a separate file from admin.js: this is the one mutation surface that
// edits auth itself. Keeping it isolated makes the file easier to review for
// the "could a bad save lock everyone out?" property.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getRolePermissions,
  hasCustomRolePermissions,
  setRolePermissions,
} from '../config/authConfig.js';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  SEED_ROLE_PERMISSIONS,
  resolvePermissions,
  isKnownPermission,
} from '../auth/permissions.js';

const router = Router();

// Rate-limit destructive operations the same way admin.js does. The mapping
// rarely changes — 10/min is plenty for a deliberate human editor and cheap
// insurance against scripted attacks against a leaked admin session.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many role mapping updates, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Snapshot of what the UI needs to render the matrix + show the current user
// where they sit in it.
function buildSnapshot(req) {
  return {
    catalog: Object.entries(PERMISSIONS).map(([key, meta]) => ({
      key,
      label: meta.label,
      group: meta.group,
      description: meta.description,
    })),
    groups: PERMISSION_GROUPS,
    mapping: getRolePermissions(),
    isCustom: hasCustomRolePermissions(),
    seedMapping: SEED_ROLE_PERMISSIONS,
    currentUser: {
      roles: req.user?.roles || [],
      permissions: Array.from(req.user?.permissions || []).filter(p => p !== '*'),
      hasWildcard: !!req.user?.permissions?.has('*'),
    },
  };
}

router.get('/admin/roles', (req, res) => {
  res.json(buildSnapshot(req));
});

router.put('/admin/roles', writeLimiter, async (req, res) => {
  const body = req.body || {};
  const mapping = body.mapping;

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return res.status(400).json({ error: 'Request body must be { mapping: { role: [permission, ...], ... } }' });
  }

  // Sanity check shape before normalisation so we can surface a useful 400 on
  // truly garbage input (setRolePermissions silently filters; we want the
  // caller to know "your input was wrong" vs "everything went through").
  for (const [role, perms] of Object.entries(mapping)) {
    if (typeof role !== 'string' || !role.trim()) {
      return res.status(400).json({ error: 'Role names must be non-empty strings' });
    }
    if (!Array.isArray(perms)) {
      return res.status(400).json({ error: `Role "${role}" must map to an array of permission strings` });
    }
    for (const p of perms) {
      if (typeof p !== 'string') {
        return res.status(400).json({ error: `Role "${role}" contains a non-string permission entry` });
      }
      if (!isKnownPermission(p)) {
        return res.status(400).json({ error: `Unknown permission "${p}" for role "${role}"` });
      }
    }
  }

  // ── Self-lockout guard ──
  //
  // Compute what permissions the *current request user* would have AFTER the
  // save. If they'd lose admin.auth, refuse — otherwise nobody could edit the
  // mapping back to a sane state without DB access.
  //
  // Exception: if the user currently has the '*' wildcard via the backwards-
  // compat "no recognised roles" fallback, we still let the save go through.
  // That user is by definition not relying on the mapping yet; their
  // pre-save permissions weren't from the mapping either.
  if (req.user && !req.user.permissions?.has('*')) {
    const myRoles = req.user.roles || [];
    const futurePerms = resolvePermissions(myRoles, mapping);
    if (!futurePerms.has('*') && !futurePerms.has('admin.auth')) {
      return res.status(409).json({
        error: 'Save refused — this mapping would remove your own admin.auth permission.',
        hint: 'Make sure at least one of your roles still has admin.auth (or the * wildcard) before saving. ' +
              'Your current roles in this token: ' + JSON.stringify(myRoles),
      });
    }
  }

  try {
    const saved = await setRolePermissions(mapping);
    res.json({ ok: true, mapping: saved, isCustom: hasCustomRolePermissions() });
  } catch (err) {
    console.error('Role mapping save failed:', err.message);
    res.status(500).json({ error: 'Failed to save role mapping' });
  }
});

router.delete('/admin/roles', writeLimiter, async (req, res) => {
  // Reset to seed. Apply the same self-lockout guard against the seed mapping
  // (otherwise an admin whose current mapping grants admin.auth to a role
  // they no longer have could lock themselves out by resetting).
  if (req.user && !req.user.permissions?.has('*')) {
    const myRoles = req.user.roles || [];
    const futurePerms = resolvePermissions(myRoles, SEED_ROLE_PERMISSIONS);
    if (!futurePerms.has('*') && !futurePerms.has('admin.auth')) {
      return res.status(409).json({
        error: 'Reset refused — the seed mapping would not grant your roles admin.auth.',
        hint: 'Your current roles in this token: ' + JSON.stringify(myRoles),
      });
    }
  }

  try {
    await setRolePermissions(null);
    res.json({ ok: true, mapping: getRolePermissions(), isCustom: false });
  } catch (err) {
    console.error('Role mapping reset failed:', err.message);
    res.status(500).json({ error: 'Failed to reset role mapping' });
  }
});

export default router;
