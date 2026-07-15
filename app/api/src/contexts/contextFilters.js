// Build SQL fragments that constrain the Matrix query by membership in one
// or more contexts. Each filter is AND'd to the existing WHERE so the caller
// composes sub-selects into the main query.
//
// A filter is { id (uuid), includeChildren (bool) }. The targetType of the
// context determines which side of the matrix it constrains:
//   Identity / Principal → principalId side  (u.id)
//   Resource             → resourceId side   (r.id)
//   System               → resource's systemId side (r.systemId)
//
// Caller supplies the context-row lookup (we don't want two DB round-trips
// baked into this helper; the caller already has a pool).
//
// Return shape:
//   { principalClauses: string[], resourceClauses: string[],
//     innerPrincipalClauses: string[], innerResourceClauses: string[] }
//
// Clauses carry positional `$N` tokens rendered by the caller's `bind` (from
// createParams); each bound value is appended to the caller's params array.
//
// principalClauses / resourceClauses reference the outer matrix query's
// `p.` (view alias) and `r.` (Resources alias). innerPrincipalClauses /
// innerResourceClauses use unqualified column names so they can be dropped
// inside a top-N `SELECT "principalId" FROM vw_… GROUP BY` subquery that
// has no aliases. Pushing the filter into the top-N avoids picking the
// most-permissioned 25 users tenant-wide and then throwing them all out
// because none happen to be in the filtered context.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Pure SQL generator ───────────────────────────────────────────────────────
// Exposed for unit tests. Takes already-resolved filters (each with a known
// targetType) and a positional binder (`bind` from createParams — bind(value)
// appends the value and returns its `$N` token), and returns the clauses the
// matrix query should append to its WHERE. Each context's outer + inner clause
// share one scope sub-select (same $N), so the caller embeds both in ONE query;
// when the clauses feed several independent queries the caller re-invokes this
// with each query's own bind.
export function buildContextFilterSql(resolvedFilters, bind) {
  const principalClauses = [];
  const resourceClauses = [];
  const innerPrincipalClauses = [];
  const innerResourceClauses = [];

  for (let i = 0; i < resolvedFilters.length; i++) {
    const f = resolvedFilters[i];
    if (!UUID_RE.test(f.id)) continue;

    const idPh  = bind(f.id);
    const memPh = bind(normaliseMemberType(f.targetType));

    const scope = f.includeChildren
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

    if (f.targetType === 'Identity' || f.targetType === 'Principal') {
      // principalId is UUID, ContextMembers.memberId is UUID — direct IN works.
      principalClauses.push(`p."principalId" IN ${scope}`);
      innerPrincipalClauses.push(`"principalId" IN ${scope}`);
    } else if (f.targetType === 'Resource') {
      resourceClauses.push(`r.id IN ${scope}`);
      // The top-N view has "resourceId" (not r.id); same scope sub-select works.
      innerResourceClauses.push(`"resourceId" IN ${scope}`);
    } else if (f.targetType === 'System') {
      // System memberIds are integers stored as text in the member column.
      // Resolve to systemId set, then constrain r.systemId. Can't push into
      // the top-N because vw_ResourceUserPermissionAssignments doesn't expose
      // systemId — left in outer WHERE only.
      resourceClauses.push(`r."systemId"::text IN ${scope}`);
    }
  }

  return {
    principalClauses,
    resourceClauses,
    innerPrincipalClauses,
    innerResourceClauses,
  };
}

// memberType values stored in ContextMembers map 1:1 to Contexts.targetType.
// If callers ever supply a non-canonical value, reject it (return empty string;
// the clause will be syntactically valid but match nothing).
function normaliseMemberType(t) {
  if (t === 'Identity' || t === 'Resource' || t === 'Principal' || t === 'System') return t;
  return '';
}

// ─── Parse + resolve helper ───────────────────────────────────────────────────
// The /api/permissions query param is a JSON array. This parses it, validates
// each entry, and fetches each referenced context's targetType in one round
// trip (so the SQL generator can be pure).
//
// `fetchContextsByIds` is injected so this module has no DB dependency of its
// own — easier to test, easier to share between request paths.
export async function parseAndResolveContextFilters(raw, fetchContextsByIds) {
  if (!raw) return [];
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const validEntries = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    if (!UUID_RE.test(entry.id)) continue;
    validEntries.push({
      id: entry.id,
      includeChildren: !!entry.includeChildren,
    });
  }
  if (validEntries.length === 0) return [];

  const rows = await fetchContextsByIds(validEntries.map(e => e.id));
  const byId = new Map(rows.map(r => [r.id, r.targetType]));
  return validEntries
    .map(e => ({ ...e, targetType: byId.get(e.id) }))
    .filter(e => !!e.targetType);
}
