// The owner matrices: what a context owner's POST /api/matrix/data may ask for.
//
// Two shapes, one per kind of context the owner answers for:
//   - the team matrix of a unit of accounts or people: its members as rows,
//     what they hold as columns — the rows must stay members of an in-scope
//     unit;
//   - the application matrix of a context of resources: the application's
//     resources as columns, whoever holds one of them as rows — the columns
//     must stay resources of an in-scope context (the flat grid lists only
//     subjects with a cell in the columns, so the rows are its holders).
// The matrix ANDs every include condition of a block (matrix/filterSql.js
// buildEntitySubquery), so one anchor among them bounds that axis; extra
// conditions can only narrow. The checks:
//
//   - every context condition, anywhere in the filter (subject or resource,
//     include or exclude), names an in-scope context. With includeChildren its
//     descendants are read too: an owner answers for every descendant of what
//     they hold, but a variant in scope does not bring its sub-units along, so
//     the verdict names those contexts (`childrenOf`) for the caller to check
//     that all their descendants are in scope;
//   - an anchor: the subject include names one of them on a unit of accounts
//     or people, or the resource include one on a context of resources. A
//     context of the other kind on an axis is dropped by that axis's query
//     (it has no clause for it), which would leave the axis unbounded — so it
//     never counts as an anchor;
//   - the context roll-up (the org-unit tree as collapsible column groups:
//     sortHierarchy / rollupKind 'context' with rollupContextId, rollupPath,
//     rollupExpanded) is kept when its root is an in-scope context — its whole
//     subtree must be in scope, the caller checks that through `childrenOf` —
//     and every node it names is in scope. Its cells and member counts run
//     through the same subject filter, so the anchor still bounds them;
//   - the other aggregate modes (the attribute roll-up and fold, roles-only
//     drill, inherited access) are removed.
//
// Anything else is refused. The verdict carries the filter to run, with the
// context ids lower-cased (the subject query looks them up by exact id).

export const MATRIX_DATA_PATH = '/api/matrix/data';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);
const RESOURCE_TARGETS = new Set(['Resource']);
const SIDES = ['include', 'exclude'];

export const AGGREGATE_FIELDS = Object.freeze([
  'rollup', 'rollupCollapsed', 'rollupLevel', 'foldAttributes', 'drill', 'includeInheritedAccess',
]);
// The context roll-up's fields, kept only when they pass contextRollup().
export const CONTEXT_ROLLUP_FIELDS = Object.freeze([
  'rollupKind', 'rollupContextId', 'rollupPath', 'rollupExpanded', 'rollupContent', 'sortHierarchy',
]);

const DENIED = Object.freeze({ ok: false });

// Every condition object of a block, or null when the block is malformed.
function conditionsOf(block) {
  if (block === undefined || block === null) return [];
  if (typeof block !== 'object') return null;
  const out = [];
  for (const side of SIDES) {
    const list = block[side];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    out.push(...list);
  }
  return out;
}

// The context ids a filter names (lower-cased), or null when one of its
// context conditions is not one an owner may use.
export function ownerContextIds(filter, contextIds) {
  const ids = new Set();
  for (const block of [filter.subject, filter.resource]) {
    const conds = conditionsOf(block);
    if (!conds) return null;
    for (const c of conds) {
      if (!c || c.kind !== 'context') continue;
      if (typeof c.contextId !== 'string' || !UUID_RE.test(c.contextId)) return null;
      const id = c.contextId.toLowerCase();
      if (!contextIds.has(id)) return null;
      ids.add(id);
    }
  }
  return [...ids];
}

const lowerContext = (c) => (c && c.kind === 'context' ? { ...c, contextId: c.contextId.toLowerCase(), includeChildren: !!c.includeChildren } : c);
const withChildren = (block) => [...block.include, ...block.exclude]
  .filter(c => c?.kind === 'context' && c.includeChildren).map(c => c.contextId);

function normalisedBlock(block) {
  if (!block) return { include: [], exclude: [] };
  return { include: (block.include || []).map(lowerContext), exclude: (block.exclude || []).map(lowerContext) };
}

const isScopedId = (v, contextIds) => typeof v === 'string' && UUID_RE.test(v) && contextIds.has(v.toLowerCase());
const idList = (v) => (v === undefined || v === null ? [] : v);

// The context roll-up a filter asks for: null when it asks for none,
// { root, fields } when every id it names is in scope (root lower-cased; its
// descendants are for the caller to check), or false when it names anything
// else — an out-of-scope root, path or expanded node, or a malformed one.
export function contextRollup(f, contextIds) {
  const roots = [f.rollupKind === 'context' ? f.rollupContextId : null, f.sortHierarchy?.contextId].filter(v => v !== null && v !== undefined);
  const nodes = [idList(f.rollupPath), idList(f.rollupExpanded)];
  if (roots.length === 0) return nodes.every(n => Array.isArray(n) && n.length === 0) ? null : false;
  if (!roots.every(r => isScopedId(r, contextIds))) return false;
  if (!nodes.every(n => Array.isArray(n) && n.every(id => isScopedId(id, contextIds)))) return false;
  const lower = (v) => v.toLowerCase();
  const fields = { rollupPath: nodes[0].map(lower), rollupExpanded: nodes[1].map(lower) };
  if (f.rollupKind === 'context') Object.assign(fields, { rollupKind: 'context', rollupContextId: lower(f.rollupContextId) });
  if (f.sortHierarchy) fields.sortHierarchy = { contextId: lower(f.sortHierarchy.contextId) };
  if (typeof f.rollupContent === 'string') fields.rollupContent = f.rollupContent;
  return { roots: [...new Set(roots.map(lower))], fields };
}

/**
 * { ok: true, filter, childrenOf } — the filter to run, and the context ids
 * whose descendants it reads (all must be in scope) — or { ok: false }.
 * `contextTypes` maps each named (lower-cased) context id to its targetType.
 */
export function ownerMatrixVerdict(body, contextIds, contextTypes) {
  const f = body?.filter;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return DENIED;
  if (!ownerContextIds(f, contextIds)) return DENIED;
  const subject = normalisedBlock(f.subject);
  const resource = normalisedBlock(f.resource);
  const anchoredBy = (conds, targets) => conds.some(c => c?.kind === 'context' && targets.has(contextTypes.get(c.contextId)));
  if (!anchoredBy(subject.include, PEOPLE_TARGETS) && !anchoredBy(resource.include, RESOURCE_TARGETS)) return DENIED;
  const rollup = contextRollup(f, contextIds);
  if (rollup === false) return DENIED;
  const filter = { ...f, subject, resource };
  for (const field of [...AGGREGATE_FIELDS, ...CONTEXT_ROLLUP_FIELDS]) delete filter[field];
  if (rollup) Object.assign(filter, rollup.fields);
  const childrenOf = [...new Set([...withChildren(subject), ...withChildren(resource), ...(rollup?.roots || [])])];
  return { ok: true, filter, childrenOf };
}
