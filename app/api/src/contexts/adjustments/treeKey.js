// Which tree an adjustment belongs to.
//
// A tree is not always one root: an imported list of logical applications is a
// flat set of roots, and the analyst's grouping units sit above them. So a tree is
// named by WHERE its units come from, not by a root id:
//
//   gen~<algorithmId>~<instanceKey>   one generated tree (a context plugin run)
//   sync~<systemId>~<template>         every imported unit of one source and one
//                                      template (contextCategory)
//   ctx~<rootContextId>                one hand-built tree
//
// Pure: building, parsing and the SQL filter of a tree's own units. Loading the
// tree (which also takes in the units its adjustments added) is in treeStore.js.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEP = '~';

export const TREE_KINDS = Object.freeze({ gen: 'generated', sync: 'synced', ctx: 'manual' });

export function generatedTreeKey(algorithmId, instanceKey) {
  return ['gen', algorithmId, instanceKey || ''].join(SEP);
}

export function syncedTreeKey(systemId, template) {
  return ['sync', systemId, template || ''].join(SEP);
}

export function manualTreeKey(rootId) {
  return ['ctx', rootId].join(SEP);
}

// Parse a key from a URL. Returns { kind, ... } or null when it is not a key.
export function parseTreeKey(key) {
  if (typeof key !== 'string' || key.length > 300) return null;
  const [prefix, a, ...rest] = key.split(SEP);
  const b = rest.join(SEP); // an instance key could contain the separator
  if (prefix === 'gen' && UUID_RE.test(a ?? '')) return { kind: 'generated', algorithmId: a.toLowerCase(), instanceKey: b };
  if (prefix === 'sync' && /^\d+$/.test(a ?? '') && b) return { kind: 'synced', systemId: Number(a), template: b };
  if (prefix === 'ctx' && UUID_RE.test(a ?? '') && rest.length === 0) return { kind: 'manual', rootId: a.toLowerCase() };
  return null;
}

// The units the SOURCE puts in this tree, as a WHERE clause on "Contexts" c with
// its parameters numbered from `offset + 1`. A hand-built tree's base is its root;
// the descendants are added by the loader for every kind alike.
export function baseUnitFilter(parsed, offset = 0) {
  const p = (n) => `$${offset + n}`;
  if (parsed.kind === 'generated') {
    return {
      sql: `c.variant = 'generated' AND c."sourceAlgorithmId" = ${p(1)} AND COALESCE(c."sourceInstanceKey", '') = ${p(2)}`,
      params: [parsed.algorithmId, parsed.instanceKey],
    };
  }
  if (parsed.kind === 'synced') {
    return {
      sql: `c.variant = 'synced' AND c."scopeSystemId" = ${p(1)} AND c."contextCategory" = ${p(2)}`,
      params: [parsed.systemId, parsed.template],
    };
  }
  return { sql: `c.id = ${p(1)}`, params: [parsed.rootId] };
}

// The tree key a context belongs to, from its own row and its root's row (both
// { id, variant, sourceAlgorithmId, sourceInstanceKey, scopeSystemId,
// contextCategory }). A unit an adjustment created is resolved by the caller
// before it gets here (it carries no source of its own).
export function treeKeyForContext(ctx, root) {
  const owner = ctx.variant === 'manual' ? root : ctx;
  if (owner.variant === 'generated' && owner.sourceAlgorithmId) {
    return generatedTreeKey(owner.sourceAlgorithmId, owner.sourceInstanceKey);
  }
  if (owner.variant === 'synced' && owner.scopeSystemId != null && owner.contextCategory) {
    return syncedTreeKey(owner.scopeSystemId, owner.contextCategory);
  }
  return manualTreeKey(root.id);
}
