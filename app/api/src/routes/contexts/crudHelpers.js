// Validation + update-building helpers for the context write endpoints,
// extracted from contexts/crud.js so POST and PATCH stay under the complexity
// threshold. Errors are returned as
// { status, message } (the handler turns them into a response) rather than sent
// directly, so the helpers stay testable. SQL + validation logic moved verbatim.

import * as db from '../../db/connection.js';
import { wouldCreateCycle } from '../../contexts/cycleGuard.js';
import { CONTEXT_CATEGORIES } from '../../ingest/validation.js';
import { UUID_RE, TARGET_TYPES } from './shared.js';

// A contextCategory is one of the four templates, or null ("Other"). Returns
// { status, message } when the supplied value is neither, else null.
export function validateContextCategory(value) {
  if (value === null || value === undefined || CONTEXT_CATEGORIES.includes(value)) return null;
  return { status: 400, message: `contextCategory must be one of ${CONTEXT_CATEGORIES.join(', ')}` };
}

// Required-field validation for POST /contexts. Returns { status, message } on
// the first failure, or null when valid.
export function validateCreateContextBody(body) {
  if (!TARGET_TYPES.has(body.targetType)) return { status: 400, message: 'targetType is required' };
  if (!body.contextType || typeof body.contextType !== 'string') return { status: 400, message: 'contextType is required' };
  if (!body.displayName  || typeof body.displayName  !== 'string') return { status: 400, message: 'displayName is required' };
  return validateContextCategory(body.contextCategory);
}

// Validate a supplied parent for a *new* context: valid uuid, exists, and the
// same targetType. Returns { error: { status, message } } on failure, else
// { parent } — the parent's category is the default for the new context.
export async function resolveCreateParent(body) {
  if (!UUID_RE.test(body.parentContextId)) return { error: { status: 400, message: 'Invalid parentContextId' } };
  const parent = await db.queryOne(`SELECT "targetType", "contextCategory" FROM "Contexts" WHERE id = $1`, [body.parentContextId]);
  if (!parent) return { error: { status: 400, message: 'Parent context not found' } };
  if (parent.targetType !== body.targetType) return { error: { status: 400, message: 'Parent context has a different targetType' } };
  return { parent };
}

// The template of a *new* context: the one given, else the parent's when a
// parent is given, else null ("Other"). Validates the parent on the way.
// Returns { error: { status, message } } or { contextCategory }.
export async function resolveCreateCategory(body) {
  if (!body.parentContextId) return { contextCategory: body.contextCategory ?? null };
  const resolved = await resolveCreateParent(body);
  if (resolved.error) return resolved;
  return { contextCategory: body.contextCategory ?? resolved.parent.contextCategory ?? null };
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

// The scalar (non-parent) fields a PATCH may set. For a generated context,
// records userRenamed once the name actually diverges so the plugin runner
// keeps the analyst's edit. Returns { status, message } on a bad category.
function collectScalarUpdates(body, ctx, isGenerated, push) {
  if (typeof body.displayName === 'string') {
    const name = body.displayName.slice(0, 500);
    push('displayName', name);
    if (isGenerated && name !== (ctx.displayName || '')) push('userRenamed', true);
  }
  if (typeof body.description === 'string' || body.description === null) push('description', body.description);
  if (typeof body.ownerUserId === 'string' || body.ownerUserId === null) push('ownerUserId', body.ownerUserId);
  if (body.extendedAttributes !== undefined)             push('extendedAttributes', body.extendedAttributes);
  if (body.contextCategory !== undefined) {
    const invalid = validateContextCategory(body.contextCategory);
    if (invalid) return invalid;
    push('contextCategory', body.contextCategory);
  }
  return null;
}

// Build the SET clause + bound params for PATCH /contexts/:id from the request
// body. Immutable fields (variant/targetType/sourceAlgorithmId) are ignored. For
// a generated context, records per-field userRenamed / userReparented flags so
// the plugin runner keeps the analyst's edit. Returns { error: {status, message}
// } on a validation failure, else { sets, params, parentChanged,
// oldParentId, newParentId }.
export async function buildContextUpdate(id, body, ctx, isGenerated) {
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  const invalid = collectScalarUpdates(body, ctx, isGenerated, push);
  if (invalid) return { error: invalid };

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
