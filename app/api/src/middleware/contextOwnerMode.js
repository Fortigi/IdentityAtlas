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
// An allowed response that names other objects (a group's members, a user's
// groups, a timeline's counterparties) is marked per reference with whether the
// owner may open it (auth/ownerAccess/annotate.js). Only in owner mode: an
// ordinary caller's responses are untouched.
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
import { findContextMember } from '../contexts/memberReferences.js';
import { createOwnerAccess, ownerMatrixVerdict, refsFor, annotateReferences } from '../auth/ownerAccess/index.js';
import { resolveContextTypes } from '../routes/matrix/shared.js';

const DECISION = Symbol('contextOwnerDecision');
const ANNOTATED = Symbol('contextOwnerAnnotated');

async function decide(req, path) {
  if (!(await isContextOwnerAccessEnabled())) return { owner: null };
  const resolved = await resolveContextOwner(req.user);
  if (!resolved) return { owner: null };
  const owner = { ...resolved, access: createOwnerAccess(resolved.contextIds) };

  const verdict = contextOwnerVerdict({ method: req.method, path, query: req.query }, owner.contextIds);
  return { owner, allow: await settle(verdict, owner, req) };
}

// The team matrix: run the request's filter only once it is bound to the team,
// and run it as the forced filter (rolled-up and inherited modes removed).
export async function settleMatrix(req, contextIds) {
  const filter = req.body?.filter;
  const types = filter && typeof filter === 'object' ? await resolveContextTypes(filter) : new Map();
  const lowered = new Map([...types].map(([id, t]) => [String(id).toLowerCase(), t]));
  const verdict = ownerMatrixVerdict(req.body, contextIds, lowered);
  if (verdict.ok) req.body = { filter: verdict.filter };
  return verdict.ok;
}

// The verdicts that need the database: a report's named contexts must all
// resolve inside the scope; a member must be a member of that very context; an
// object must open in full for this owner; a matrix must be bound to the team.
async function settle(verdict, owner, req) {
  const { contextIds } = owner;
  if (verdict.resolve) {
    const resolved = await resolveReportContexts(await db.getPool(), verdict.resolve);
    return resolved.every(id => contextIds.has(id));
  }
  if (verdict.member) {
    const { contextId, memberId } = verdict.member;
    return !!(await findContextMember(await db.getPool(), contextId, memberId));
  }
  if (verdict.entity) return owner.access.canOpen(verdict.entity.kind, verdict.entity.id);
  if (verdict.matrix) return settleMatrix(req, contextIds);
  return verdict.allow;
}

// Mark the references in this response before it is sent. Once per request.
export function annotateResponse(res, refs, access) {
  if (!refs || res[ANNOTATED]) return;
  res[ANNOTATED] = true;
  const send = res.json.bind(res);
  res.json = (body) => {
    annotateReferences(body, refs, access)
      .then(send)
      .catch((err) => {
        console.error('Context owner annotation failed:', err.message);
        res.status(500);
        send({ error: 'Authentication service error' });
      });
    return res;
  };
}

export function applyContextOwnerMode(req, res, next, { path, otherwise }) {
  if (!req[DECISION]) req[DECISION] = decide(req, path);
  req[DECISION].then(({ owner, allow }) => {
    if (!owner) return otherwise();
    req.user.contextOwner = owner;
    if (!allow) return res.status(403).json({ error: CONTEXT_OWNER_DENIED });
    annotateResponse(res, refsFor(path), owner.access);
    return next();
  }).catch((err) => {
    console.error('Context owner check failed:', err.message);
    res.status(500).json({ error: 'Authentication service error' });
  });
}
