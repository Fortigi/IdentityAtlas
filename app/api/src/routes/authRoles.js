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
import { requirePermission } from '../middleware/auth.js';
import * as db from '../db/connection.js';
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
const gate = requirePermission('admin.auth');

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

// Self-lockout guard, shared by PUT (save) and DELETE (reset-to-seed).
//
// Computes what permissions the *current request user* would have AFTER the
// mapping change. If they'd lose admin.auth (and the '*' wildcard), refuse —
// otherwise nobody could edit the mapping back to a sane state without DB
// access. Returns a 409 error body to send, or null when the change is safe.
//
// Exception: a user who currently holds '*' via the backwards-compat "no
// recognised roles" fallback is exempt — they aren't relying on the mapping
// yet, and their pre-change permissions weren't from the mapping either.
function checkSelfLockout(req, mapping, messages) {
  if (!req.user || req.user.permissions?.has('*')) return null;
  const myRoles = req.user.roles || [];
  const futurePerms = resolvePermissions(myRoles, mapping);
  if (futurePerms.has('*') || futurePerms.has('admin.auth')) return null;
  return {
    error: messages.error,
    hint: (messages.hintPrefix || '') +
          'Your current roles in this token: ' + JSON.stringify(myRoles),
  };
}

// Who's making the change, for the audit trail. Falls back through the JWT's
// usual identity claims; null when auth is disabled (no token).
function actingUser(req) {
  return req.user?.name || req.user?.preferred_username || req.user?.upn || req.user?.oid || null;
}

// Record a role-mapping change (#786). Best-effort: the mapping is already
// persisted by the time we get here, so a failed audit insert is logged but
// never fails the admin's save/reset.
async function logRoleChange(req, action, mapping) {
  try {
    await db.query(
      `INSERT INTO "AuthRoleChangeLog" ("changedBy", "action", "mapping") VALUES ($1, $2, $3)`,
      [actingUser(req), action, JSON.stringify(mapping ?? null)],
    );
  } catch (err) {
    console.error('Role-change audit log failed:', err.message);
  }
}

router.get('/admin/roles', gate, (req, res) => {
  res.json(buildSnapshot(req));
});

// Change history for the role→permission mapping (newest first).
router.get('/admin/roles/audit', gate, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  try {
    const r = await db.query(
      `SELECT "id", "changedAt", "changedBy", "action"
         FROM "AuthRoleChangeLog"
        ORDER BY "changedAt" DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ entries: r?.rows || [] });
  } catch (err) {
    console.error('Role audit fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to load change history' });
  }
});

router.put('/admin/roles', gate, writeLimiter, async (req, res) => {
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
  const lockout = checkSelfLockout(req, mapping, {
    error: 'Save refused — this mapping would remove your own admin.auth permission.',
    hintPrefix: 'Make sure at least one of your roles still has admin.auth (or the * wildcard) before saving. ',
  });
  if (lockout) return res.status(409).json(lockout);

  try {
    const saved = await setRolePermissions(mapping);
    await logRoleChange(req, 'save', saved);
    res.json({ ok: true, mapping: saved, isCustom: hasCustomRolePermissions() });
  } catch (err) {
    console.error('Role mapping save failed:', err.message);
    res.status(500).json({ error: 'Failed to save role mapping' });
  }
});

router.delete('/admin/roles', gate, writeLimiter, async (req, res) => {
  // Reset to seed. Apply the same self-lockout guard against the seed mapping
  // (otherwise an admin whose current mapping grants admin.auth to a role
  // they no longer have could lock themselves out by resetting).
  const lockout = checkSelfLockout(req, SEED_ROLE_PERMISSIONS, {
    error: 'Reset refused — the seed mapping would not grant your roles admin.auth.',
  });
  if (lockout) return res.status(409).json(lockout);

  try {
    await setRolePermissions(null);
    await logRoleChange(req, 'reset', getRolePermissions());
    res.json({ ok: true, mapping: getRolePermissions(), isCustom: false });
  } catch (err) {
    console.error('Role mapping reset failed:', err.message);
    res.status(500).json({ error: 'Failed to reset role mapping' });
  }
});

export default router;
