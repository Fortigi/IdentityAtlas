// Build SQL fragments for the wizard-driven Matrix filter.
//
// The filter has the shape:
//
//   {
//     rowType:  'principal' | 'identity',
//     subject:  { include: [...], exclude: [...] },
//     resource: { include: [...], exclude: [...] }
//   }
//
// Each condition is one of:
//   { kind: 'context',   contextId,  includeChildren }
//   { kind: 'attribute', field,      values: [...] }   // values are OR'd
//
// `buildEntitySubquery` turns a `{ include, exclude }` block into a parenthesised
// `(SELECT id FROM "<Table>" WHERE …)` that the matrix data and preview queries
// embed as `<col> IN (…)`. When no conditions are supplied the helper returns
// `sql: null` so the caller can skip the IN clause entirely.
//
// `resolveContextTargetTypes` does a single round-trip to look up `targetType`
// for every context referenced anywhere in the filter — the caller injects this
// map into `buildEntitySubquery` so the module stays free of DB knowledge.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;
const EXT_PREFIX = 'ext.';

const TABLE_BY_ENTITY = {
  Principal: 'Principals',
  Identity:  'Identities',
  Resource:  'Resources',
};

// ─── Public ──────────────────────────────────────────────────────────

// Walk an entire filter object and return every unique contextId referenced.
// Used by the route to fetch targetTypes in one query.
export function collectContextIds(filter) {
  const ids = new Set();
  const walk = (block) => {
    if (!block) return;
    for (const side of [block.include, block.exclude]) {
      if (!Array.isArray(side)) continue;
      for (const c of side) {
        if (c && c.kind === 'context' && typeof c.contextId === 'string' && UUID_RE.test(c.contextId)) {
          ids.add(c.contextId);
        }
      }
    }
  };
  walk(filter?.subject);
  walk(filter?.resource);
  return [...ids];
}

// Build a subquery that lists the IDs of the chosen entity table matching the
// include/exclude conditions. Returns:
//   { sql: '(SELECT id FROM "Principals" WHERE …)' | null,
//     warnings: ['unknown attribute foo dropped', …] }
//
// `validColumns` is a Set of allowed real-column names for the entity.
// `contextTypes` is a Map<contextId, targetType>.
// `bind` is a positional-parameter binder (from createParams): bind(value)
// appends the value to the caller's params array and returns its `$N` token.
// The caller re-invokes this per query with its own `bind`, so each query gets
// exactly the placeholders + params it references (the same subquery fragment
// is embedded in several INDEPENDENT queries — the flat grid, the four scope
// COUNTs, the roll-ups — and pg can't share params across queries).
export function buildEntitySubquery({
  entity,
  include = [],
  exclude = [],
  validColumns,
  contextTypes,
  bind,
}) {
  const table = TABLE_BY_ENTITY[entity];
  if (!table) return { sql: null, warnings: ['unknown entity: ' + entity] };

  const warnings = [];
  const includeClauses = [];
  const excludeClauses = [];

  const handle = (conditions, target) => {
    if (!Array.isArray(conditions)) return;
    conditions.forEach((cond) => {
      if (!cond || typeof cond !== 'object') return;

      // ─── context membership ─────────────────────────────────────
      if (cond.kind === 'context') {
        if (!UUID_RE.test(cond.contextId || '')) {
          warnings.push('context with invalid id dropped');
          return;
        }
        const ctxType = contextTypes.get(cond.contextId);
        if (!ctxType) {
          warnings.push(`context ${cond.contextId} not found — dropped`);
          return;
        }
        const clause = buildContextClause({
          entity,
          contextId: cond.contextId,
          includeChildren: !!cond.includeChildren,
          contextTargetType: ctxType,
          bind,
        });
        if (!clause) {
          warnings.push(`context type ${ctxType} incompatible with entity ${entity} — dropped`);
          return;
        }
        (target === 'inc' ? includeClauses : excludeClauses).push(clause);
        return;
      }

      // ─── attribute match ────────────────────────────────────────
      if (cond.kind === 'attribute') {
        const clause = buildAttributeClause({
          field: cond.field,
          values: cond.values,
          validColumns,
          bind,
        });
        if (!clause) {
          warnings.push(`attribute condition for ${cond.field} dropped`);
          return;
        }
        (target === 'inc' ? includeClauses : excludeClauses).push(clause);
        return;
      }

      warnings.push(`unknown condition kind: ${cond.kind}`);
    });
  };

  handle(include, 'inc');
  handle(exclude, 'exc');

  if (includeClauses.length === 0 && excludeClauses.length === 0) {
    return { sql: null, warnings };
  }

  const where = [];
  if (includeClauses.length) where.push(...includeClauses);
  // Exclude must treat NULL fields as "didn't match this condition, so keep
  // the row". `NOT (x IN (...))` returns NULL when x is NULL, and NULL is
  // falsy in WHERE — that would silently drop rows with empty attributes.
  // `(... ) IS NOT TRUE` evaluates to TRUE for both FALSE and NULL.
  if (excludeClauses.length) where.push(...excludeClauses.map(c => `(${c}) IS NOT TRUE`));

  const sql = `(SELECT id FROM "${table}" WHERE ${where.join(' AND ')})`;
  return { sql, warnings };
}

// ─── Internals ──────────────────────────────────────────────────────

function buildAttributeClause({ field, values, validColumns, bind }) {
  if (typeof field !== 'string') return null;
  if (!Array.isArray(values) || values.length === 0) return null;

  const vals = values
    .filter(v => v != null && v !== '')
    .map(v => String(v))
    .slice(0, 200);  // safety cap on OR list size
  if (vals.length === 0) return null;

  // ext.<key> — JSONB path
  if (field.startsWith(EXT_PREFIX)) {
    const key = field.slice(EXT_PREFIX.length);
    if (!SAFE_IDENT_RE.test(key)) return null;
    const placeholders = vals.map(v => bind(v));
    return `"extendedAttributes"->>'${key}' IN (${placeholders.join(',')})`;
  }

  // real column — must be in the entity's column whitelist
  if (!SAFE_IDENT_RE.test(field)) return null;
  if (!validColumns.has(field)) return null;

  const placeholders = vals.map(v => bind(v));
  return `"${field}"::text IN (${placeholders.join(',')})`;
}

function buildContextClause({ entity, contextId, includeChildren, contextTargetType, bind }) {
  const idPh  = bind(contextId);
  const memPh = bind(contextTargetType);

  const scope = includeChildren
    ? `(
        WITH RECURSIVE scope AS (
          SELECT id FROM "Contexts" WHERE id = ${idPh}
          UNION ALL
          SELECT c.id FROM "Contexts" c JOIN scope ON c."parentContextId" = scope.id
        )
        SELECT "memberId" FROM "ContextMembers"
         WHERE "memberType" = ${memPh}
           AND "contextId" IN (SELECT id FROM scope)
      )`
    : `(
        SELECT "memberId" FROM "ContextMembers"
         WHERE "memberType" = ${memPh}
           AND "contextId" = ${idPh}
      )`;

  // Direct match — context targets the same entity we're filtering.
  if (contextTargetType === entity) {
    return `id IN ${scope}`;
  }

  // Cross-rollup via IdentityMembers.
  // Identity context constraining Principal entity → use IdentityMembers to
  // expand to member principals.
  if (entity === 'Principal' && contextTargetType === 'Identity') {
    return `id IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" IN ${scope})`;
  }
  // Principal context constraining Identity entity → roll up to identities.
  if (entity === 'Identity' && contextTargetType === 'Principal') {
    return `id IN (SELECT "identityId" FROM "IdentityMembers" WHERE "principalId" IN ${scope})`;
  }
  // System context constraining Resource entity → match on systemId. The
  // ContextMembers.memberId is UUID, but System ids are integers, so this
  // works only if the upstream sync writes the integer id as a UUID-shaped
  // string. If it doesn't, the filter just matches nothing — which is the
  // same behaviour as the legacy contextFilters helper.
  if (entity === 'Resource' && contextTargetType === 'System') {
    return `"systemId"::text IN ${scope}`;
  }

  return null;
}
