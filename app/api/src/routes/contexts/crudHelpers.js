// Validation + update-building helpers for the context write endpoints,
// extracted from contexts/crud.js so POST (cyclomatic 22) and PATCH (cyclomatic
// 30 / cognitive 40) stay under the complexity threshold. Errors are returned as
// { status, message } (the handler turns them into a response) rather than sent
// directly, so the helpers stay testable. SQL + validation logic moved verbatim.

import * as db from '../../db/connection.js';
import { wouldCreateCycle } from '../../contexts/cycleGuard.js';
import { UUID_RE, TARGET_TYPES } from './shared.js';

// Required-field validation for POST /contexts. Returns { status, message } on
// the first failure, or null when valid.
export function validateCreateContextBody(body) {
  if (!TARGET_TYPES.has(body.targetType)) return { status: 400, message: 'targetType is required' };
  if (!body.contextType || typeof body.contextType !== 'string') return { status: 400, message: 'contextType is required' };
  if (!body.displayName  || typeof body.displayName  !== 'string') return { status: 400, message: 'displayName is required' };
  return null;
}

// Validate a supplied parent for a *new* context: valid uuid, exists, and the
// same targetType. Returns { status, message } on failure, or null.
export async function checkCreateParent(body) {
  if (!UUID_RE.test(body.parentContextId)) return { status: 400, message: 'Invalid parentContextId' };
  const parent = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [body.parentContextId]);
  if (!parent) return { status: 400, message: 'Parent context not found' };
  if (parent.targetType !== body.targetType) return { status: 400, message: 'Parent context has a different targetType' };
  return null;
}

// Validate a proposed parent for an *existing* context (PATCH): same targetType,
// exists, not itself, and no cycle at any depth. Returns { error: {status,
// message} } on failure, or { newParentId } (which may be null for detach).
async function resolveParentChange(id, parentContextId, ctx) {
  if (parentContextId === null) return { newParentId: null };
  if (!UUID_RE.test(parentContextId)) return { error: { status: 400, message: 'Invalid parentContextId' } };
  if (parentContextId === id) return { error: { status: 400, message: 'Cannot parent a context to itself' } };
  const parent = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [parentContextId]);
  if (!parent) return { error: { status: 400, message: 'Parent context not found' } };
  if (parent.targetType !== ctx.targetType) return { error: { status: 400, message: 'Parent has a different targetType' } };
  // Prevent cycles at any depth (the shared guard uses a CYCLE-safe query).
  if (await wouldCreateCycle(db, id, parentContextId)) return { error: { status: 400, message: 'Proposed parent would create a cycle' } };
  return { newParentId: parentContextId };
}

// Build the SET clause + bound params for PATCH /contexts/:id from the request
// body. Immutable fields (variant/targetType/sourceAlgorithmId) are ignored. For
// a generated context, records per-field userRenamed / userReparented flags so
// the plugin runner keeps the analyst's edit. Returns { error: {status, message}
// } on a parent-validation failure, else { sets, params, parentChanged,
// oldParentId, newParentId }.
export async function buildContextUpdate(id, body, ctx, isGenerated) {
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  if (typeof body.displayName === 'string') {
    const name = body.displayName.slice(0, 500);
    push('displayName', name);
    // Mark a generated node as analyst-renamed once its name actually diverges.
    if (isGenerated && name !== (ctx.displayName || '')) push('userRenamed', true);
  }
  if (typeof body.description === 'string' || body.description === null) push('description', body.description);
  if (typeof body.ownerUserId === 'string' || body.ownerUserId === null) push('ownerUserId', body.ownerUserId);
  if (body.extendedAttributes !== undefined)             push('extendedAttributes', body.extendedAttributes);

  const oldParentId = ctx.parentContextId || null;
  let newParentId = oldParentId;
  let parentChanged = false;

  if (body.parentContextId !== undefined) {
    const pr = await resolveParentChange(id, body.parentContextId, ctx);
    if (pr.error) return { error: pr.error };
    newParentId = pr.newParentId;
    parentChanged = oldParentId !== newParentId;
    push('parentContextId', newParentId);
    if (isGenerated && parentChanged) push('userReparented', true);
  }

  return { sets, params, parentChanged, oldParentId, newParentId };
}
