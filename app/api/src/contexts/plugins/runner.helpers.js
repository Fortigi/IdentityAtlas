// Pure helpers for the plugin runner's reconcile step.
//
// Kept side-effect-free (no DB, no I/O beyond minting ids) so they can be
// unit-tested directly and to keep the reconcile transaction body flat.

import { randomUUID } from 'crypto';

// Map every produced externalId to the final Contexts.id it will occupy:
// reuse the existing row's id when the context already exists, otherwise mint a
// fresh UUID. Built before the upsert so both passes (parent = NULL, then parent
// pointers) can resolve parents that appear after their children in the output.
export function buildNewIdMap(contexts, existingByExternalId) {
  const newByExternalId = new Map(); // externalId -> UUID (final Contexts.id)
  for (const node of contexts) {
    if (!node.externalId) continue;
    const existingId = existingByExternalId.get(node.externalId);
    newByExternalId.set(node.externalId, existingId || randomUUID());
  }
  return newByExternalId;
}

// Build the parameterised VALUES clause + params for one batch of member rows.
// Resolves each member's contextExternalId to its final id, silently skipping
// dangling references. Returns { values, params } ready for a single INSERT.
export function buildMemberInsertBatch(slice, newByExternalId, targetType) {
  const values = [];
  const params = [];
  let placeholderIdx = 0;
  for (const m of slice) {
    const ctxId = newByExternalId.get(m.contextExternalId);
    if (!ctxId) continue; // dangling reference — skip silently
    params.push(ctxId, targetType, m.memberId);
    values.push(`($${placeholderIdx + 1}, $${placeholderIdx + 2}, $${placeholderIdx + 3}, 'algorithm')`);
    placeholderIdx += 3;
  }
  return { values, params };
}
