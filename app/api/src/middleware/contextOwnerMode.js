// Context-owner mode — the request half of context-owner access.
//
// middleware/auth.js hands a request here after validating the token, when the
// caller would otherwise get no access: their roles map to no permission, or
// they fail AUTH_REQUIRED_ROLES. Then:
//
//   setting off, or the caller holds no context role  → `otherwise()`, which is
//       exactly what auth.js did before this existed (next() for a roleless
//       caller, the 403 for one missing a required role);
//   the caller is a context owner                      → req.user.contextOwner is
//       set, and the request goes through only if auth/contextOwnerScope.js
//       allows it. Everything else gets a 403.
//
// authMiddleware runs once per router mount, so one request passes through here
// many times. The decision is computed once and kept on the request.
//
// A failure while deciding answers 500 rather than falling back: falling back
// would hand an owner the roleless "read everything" path the setting exists to
// close.

import * as db from '../db/connection.js';
import { isContextOwnerAccessEnabled } from '../auth/contextOwnerSetting.js';
import { resolveContextOwner, resolveReportContexts } from '../auth/contextOwner.js';
import { CONTEXT_OWNER_DENIED, contextOwnerVerdict } from '../auth/contextOwnerScope.js';

const DECISION = Symbol('contextOwnerDecision');

async function decide(req, path) {
  if (!(await isContextOwnerAccessEnabled())) return { owner: null };
  const owner = await resolveContextOwner(req.user);
  if (!owner) return { owner: null };

  const verdict = contextOwnerVerdict({ method: req.method, path, query: req.query }, owner.contextIds);
  if (!verdict.resolve) return { owner, allow: verdict.allow };

  const resolved = await resolveReportContexts(await db.getPool(), verdict.resolve);
  return { owner, allow: resolved.every(id => owner.contextIds.has(id)) };
}

export function applyContextOwnerMode(req, res, next, { path, otherwise }) {
  if (!req[DECISION]) req[DECISION] = decide(req, path);
  req[DECISION].then(({ owner, allow }) => {
    if (!owner) return otherwise();
    req.user.contextOwner = owner;
    if (allow) return next();
    return res.status(403).json({ error: CONTEXT_OWNER_DENIED });
  }).catch((err) => {
    console.error('Context owner check failed:', err.message);
    res.status(500).json({ error: 'Authentication service error' });
  });
}
