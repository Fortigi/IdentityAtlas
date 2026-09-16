// Which resource types are hidden from an ordinary resource listing by default.
//
// Some resourceTypes are not "actual access" (IST) rows at all — they are
// governance intent (SOLL) that every surface already shows another way. A
// BusinessRole (Entra access package, Omada business role, SailPoint access
// profile) carries a real Direct assignment per member, so without a filter it
// surfaces as a plain resource row *in addition to* the business-role columns
// the same view already renders — the same role twice, once per axis (#937).
//
// This is a DENY-list, not an allow-list: `resourceType` is an open vocabulary
// (CSV / Omada / midPoint / Azure crawlers emit arbitrary types — see
// ingest/resourceTypes.guard.test.js), so anything unknown stays visible.
//
// Ownership types (`GroupOwnership`, …) deliberately do NOT belong here: an
// ownership row is the only place the matrix shows who controls a group, so it
// is unique IST information rather than a duplicate of a governance column.
// See docs/architecture/matrix.md → "Owner rows are their own resource".
export const HIDDEN_BY_DEFAULT_RESOURCE_TYPES = ['BusinessRole'];

// Is this resourceType hidden unless something explicitly asks for it?
export function isHiddenByDefaultResourceType(resourceType) {
  return HIDDEN_BY_DEFAULT_RESOURCE_TYPES.includes(resourceType);
}

// SQL predicate that keeps only the resource types visible by default.
// `columnExpr` is the expression holding the type — a bare column in a
// `FROM "Resources"` subquery (the default), an aliased column (`r."resourceType"`),
// or a JSONB extraction from an as-of snapshot (`sr.state->>'resourceType'`).
// NULL counts as visible: a type-less resource is not a governance row.
export function visibleResourceTypesSql(columnExpr = '"resourceType"') {
  const list = HIDDEN_BY_DEFAULT_RESOURCE_TYPES.map(t => `'${t}'`).join(', ');
  return `(${columnExpr} IS NULL OR ${columnExpr} NOT IN (${list}))`;
}

// Does a resource scope block explicitly ask for one of the hidden types?
// An include condition like `resourceType ∈ {BusinessRole}` is the analyst
// saying "I want exactly these" — explicit scope beats the default, so the
// "matrix of which access packages users hold" stays buildable on purpose.
export function scopeTargetsHiddenResourceTypes(block) {
  const include = block?.include;
  if (!Array.isArray(include)) return false;
  return include.some(cond =>
    cond && cond.kind === 'attribute' && cond.field === 'resourceType'
    && Array.isArray(cond.values)
    && cond.values.some(v => isHiddenByDefaultResourceType(String(v))));
}

// Should this matrix filter hide the default-hidden resource types?
// No when the matrix definition opts in (`filter.includeBusinessRoles`, the
// flag the wizard's "Show business roles as rows" checkbox sets and saved
// matrices persist), and no when the resource scope explicitly targets them.
export function shouldHideDefaultResourceTypes(filter) {
  if (filter?.includeBusinessRoles === true) return false;
  return !scopeTargetsHiddenResourceTypes(filter?.resource);
}
