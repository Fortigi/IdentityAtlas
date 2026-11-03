// The team matrix: what a context owner's POST /api/matrix/data may ask for.
//
// The owner opens the matrix of their unit — its members as subjects, what
// they hold as resources. Whatever filter arrives, the rows must stay members
// of the owner's in-scope contexts. The matrix ANDs every subject include
// condition (matrix/filterSql.js buildEntitySubquery), so one anchor among them
// bounds the rows; extra conditions can only narrow. The checks:
//
//   - every context condition, anywhere in the filter (subject or resource,
//     include or exclude), names an in-scope context, without includeChildren
//     (the children of an owned unit may be somebody else's);
//   - the subject include has at least one of them on a unit of accounts or
//     people — a context of resources is dropped by the subject query (it has
//     no clause for it), which would leave the rows unbounded;
//   - the modes that aggregate over a context tree or an attribute (roll-ups,
//     the hierarchy sort, the attribute fold, inherited access) are removed:
//     the flat grid is the one mode whose rows are exactly the subjects.
//
// Anything else is refused. The verdict carries the filter to run, with the
// context ids lower-cased (the subject query looks them up by exact id).

export const MATRIX_DATA_PATH = '/api/matrix/data';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);
const SIDES = ['include', 'exclude'];

export const AGGREGATE_FIELDS = Object.freeze([
  'rollup', 'rollupKind', 'rollupContextId', 'rollupPath', 'rollupExpanded', 'rollupCollapsed',
  'rollupLevel', 'rollupContent', 'sortHierarchy', 'foldAttributes', 'drill', 'includeInheritedAccess',
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
      if (typeof c.contextId !== 'string' || !UUID_RE.test(c.contextId) || c.includeChildren) return null;
      const id = c.contextId.toLowerCase();
      if (!contextIds.has(id)) return null;
      ids.add(id);
    }
  }
  return [...ids];
}

const lowerContext = (c) => (c && c.kind === 'context' ? { ...c, contextId: c.contextId.toLowerCase(), includeChildren: false } : c);

function normalisedBlock(block) {
  if (!block) return { include: [], exclude: [] };
  return { include: (block.include || []).map(lowerContext), exclude: (block.exclude || []).map(lowerContext) };
}

/**
 * { ok: true, filter } — the filter to run — or { ok: false }.
 * `contextTypes` maps each named (lower-cased) context id to its targetType.
 */
export function ownerMatrixVerdict(body, contextIds, contextTypes) {
  const f = body?.filter;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return DENIED;
  if (!ownerContextIds(f, contextIds)) return DENIED;
  const subject = normalisedBlock(f.subject);
  const anchored = subject.include.some(c => c?.kind === 'context' && PEOPLE_TARGETS.has(contextTypes.get(c.contextId)));
  if (!anchored) return DENIED;
  const filter = { ...f, subject, resource: normalisedBlock(f.resource) };
  for (const field of AGGREGATE_FIELDS) delete filter[field];
  return { ok: true, filter };
}
