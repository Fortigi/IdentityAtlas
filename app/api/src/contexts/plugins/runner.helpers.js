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

// The (context, holder, role) keys a plugin run produces, as three parallel
// arrays for an unnest(): the roles to KEEP when reconciling. Same skipping
// rules as buildRoleInsertBatch, so a role that would not be inserted is not kept.
export function roleKeys(roles, newByExternalId) {
  const out = { ctx: [], holder: [], role: [] };
  for (const r of roles) {
    const ctxId = newByExternalId.get(r.contextExternalId);
    const holders = [r.principalId, r.identityId].filter(Boolean);
    if (!ctxId || holders.length !== 1) continue;
    out.ctx.push(ctxId);
    out.holder.push(String(holders[0]));
    out.role.push(r.role);
  }
  return out;
}

// Build the VALUES clause + params for one batch of role rows. A role names an
// account or a person, exactly one; a row with neither or both, or with a
// dangling context, is skipped.
export function buildRoleInsertBatch(slice, newByExternalId) {
  const values = [];
  const params = [];
  for (const r of slice) {
    const ctxId = newByExternalId.get(r.contextExternalId);
    const holders = [r.principalId, r.identityId].filter(Boolean);
    if (!ctxId || holders.length !== 1) continue;
    const n = params.length;
    params.push(ctxId, r.principalId || null, r.identityId || null, r.role);
    values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, 'algorithm')`);
  }
  return { values, params };
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

// The externalId of the root a run is wrapped under (see withPluginRoot). Fixed,
// so every re-run of a tree matches the same row and reuses its id.
export const PLUGIN_ROOT_EXTERNAL_ID = '__plugin-root__';

// A tree has one root. A plugin whose output has several (one context per
// department, one per risk tier) gets a root named after the plugin, and the
// nodes that had no parent in the output become its children. A plugin that
// already emits one root is left as it is. Once a tree has the plugin root it
// keeps it (hadRoot), even on a run that would leave one node, so the tree's
// shape and its ids don't flap between runs. An empty run gets no root.
export function withPluginRoot(contexts, plugin, hadRoot = false) {
  const ids = new Set(contexts.map(n => n.externalId));
  const isRoot = n => !n.parentExternalId || !ids.has(n.parentExternalId);
  const roots = contexts.filter(isRoot).length;
  if (contexts.length === 0 || (roots < 2 && !hadRoot)) return contexts;
  const root = {
    externalId: PLUGIN_ROOT_EXTERNAL_ID,
    displayName: plugin.rootDisplayName || plugin.displayName,
    contextType: plugin.contextTypes?.[0], // undefined → the runner writes the plugin name
    description: `Created by the ${plugin.displayName} rule.`,
  };
  return [root, ...contexts.map(n => (isRoot(n) ? { ...n, parentExternalId: PLUGIN_ROOT_EXTERNAL_ID } : n))];
}
