// Relationship/reference list filters — filter an entity list by whether the
// object HAS (or lacks) a given relationship, not just by an attribute on the
// object itself. E.g. "AI agents without an owner", "groups without members",
// "groups without an owner".
//
// This is the single source of truth for the feature. The list route handlers
// (/api/users, /api/resources) call `applyRelationshipFilters` to append the
// WHERE fragment, and the column-discovery routes (/api/user-columns-page,
// /api/resource-columns) call `advertiseRelationshipColumns` to surface the
// filter fields in the UI filter bar. Keeping the SQL + advertisement here (a)
// avoids a jscpd clone across the two route files and (b) keeps the route
// handlers to a single call-statement each so they don't cross the per-function
// complexity ratchet.
//
// Design notes:
//   - Filter keys are plain (`hasOwner`, `hasMembers`), NOT `__`-prefixed like
//     the tag virtual keys. The UI filter bar humanizes an unknown column key
//     for its label (`hasOwner` -> "Has Owner"), so plain keys give a clean
//     label with ZERO UI code — no per-page FIELD_LABELS entry needed. The keys
//     are still safe against buildFilterWhere: they are not real columns and not
//     `ext.`-prefixed, so buildFilterWhere ignores them even if not stripped.
//   - The value is "Yes"/"No" (equality picker in the existing FilterBar);
//     "Yes" -> EXISTS, "No" -> NOT EXISTS. Any other value is ignored (no-op).
//   - The EXISTS/NOT EXISTS operator is chosen from a fixed whitelist and every
//     other token in the fragment is a literal — no user value reaches the SQL,
//     so the fragment is injection-safe and binds NO params (leaving each
//     handler's countParams snapshot untouched).
//   - Existence-guarded: a filter that reads a table which may be absent on an
//     older deployment (PrincipalRelationships, migration 057) is skipped rather
//     than 500ing the whole list — this matters because active filters are
//     persisted in the browser's localStorage and re-sent after a rollback.

const OP_BY_VALUE = { Yes: 'EXISTS', No: 'NOT EXISTS' };

// Per-domain relationship filter specs.
//   sql(alias, op) -> the `<op> ( SELECT 1 ... )` predicate for the WHERE clause
//   probe          -> a `SELECT EXISTS(...) AS e` used to decide whether to
//                     advertise the field (only show it when the tenant has the
//                     relevant relationship data — same idea as the tag filters)
//   requires       -> tables that must exist for the predicate to be runnable
export const RELATIONSHIP_FILTERS = {
  principal: {
    hasOwner: {
      label: 'Has owner',
      requires: ['PrincipalRelationships'],
      // An AI agent / guest "has an owner" when a PrincipalRelationships row
      // (migration 057) points at it with relationshipType='Owner'.
      sql: (a, op) => `${op} (SELECT 1 FROM "PrincipalRelationships" pr`
        + ` WHERE pr."principalId" = ${a}.id AND pr."relationshipType" = 'Owner')`,
      probe: `SELECT EXISTS (SELECT 1 FROM "PrincipalRelationships" WHERE "relationshipType" = 'Owner') AS e`,
    },
  },
  resource: {
    hasOwner: {
      label: 'Has owner',
      requires: ['ResourceRelationships', 'ResourceAssignments'],
      // A resource "has an owner" when a Direct assignment sits on its synthetic
      // ownership resource (GroupOwnership / ServicePrincipalOwnership /
      // ApplicationOwnership) linked via HasOwnership / HasAppOwnership. Covers
      // both group ownership (migration 046) and app/SP ownership.
      sql: (a, op) => `${op} (SELECT 1 FROM "ResourceRelationships" rr`
        + ` JOIN "ResourceAssignments" ra ON ra."resourceId" = rr."childResourceId"`
        + ` AND ra."deletedAt" IS NULL AND ra."assignmentType" = 'Direct'`
        + ` AND ra."resourceType" IN ('GroupOwnership','ServicePrincipalOwnership','ApplicationOwnership')`
        + ` WHERE rr."parentResourceId" = ${a}.id`
        + ` AND rr."relationshipType" IN ('HasOwnership','HasAppOwnership'))`,
      probe: `SELECT EXISTS (SELECT 1 FROM "ResourceRelationships" WHERE "relationshipType" IN ('HasOwnership','HasAppOwnership')) AS e`,
    },
    hasMembers: {
      label: 'Has members',
      requires: ['ResourceAssignments'],
      // A resource "has members" when it has a Direct assignment that is not the
      // ownership assignment. Mirrors the existing member-count source
      // (resources.js / riskscoring engine): Direct only, GroupOwnership
      // excluded (an owner is not a member), soft-deleted excluded. A nested
      // subgroup counts — it is itself a Direct member — so a group whose only
      // members arrive via nesting is correctly NOT "memberless".
      sql: (a, op) => `${op} (SELECT 1 FROM "ResourceAssignments" ra`
        + ` WHERE ra."resourceId" = ${a}.id AND ra."deletedAt" IS NULL`
        + ` AND ra."assignmentType" = 'Direct'`
        + ` AND ra."resourceType" IS DISTINCT FROM 'GroupOwnership')`,
      probe: `SELECT EXISTS (SELECT 1 FROM "ResourceAssignments" WHERE "assignmentType" = 'Direct' AND "resourceType" IS DISTINCT FROM 'GroupOwnership') AS e`,
    },
  },
};

// Module-level cache of table existence (feature tables never disappear within a
// process lifetime once present). Keyed by unquoted table name.
const _tableExists = new Map();

async function tableExists(pool, name) {
  if (_tableExists.has(name)) return _tableExists.get(name);
  const r = await pool.query('SELECT to_regclass($1) AS t', [`"${name}"`]);
  const exists = r.rows[0]?.t != null;
  _tableExists.set(name, exists);
  return exists;
}

async function allTablesExist(pool, names) {
  for (const n of names) {
    if (!(await tableExists(pool, n))) return false;
  }
  return true;
}

// Resolve the WHERE fragment for the relationship filters present in `filters`.
// Consumes (deletes) the keys it handles so a later buildFilterWhere never sees
// them. Returns '' when nothing applies. Never throws — a catalog/probe error
// degrades to "skip this filter" rather than failing the list request.
export async function applyRelationshipFilters(pool, domain, filters, alias) {
  const specs = RELATIONSHIP_FILTERS[domain];
  if (!specs || !filters) return '';
  let frag = '';
  for (const [key, spec] of Object.entries(specs)) {
    const op = OP_BY_VALUE[filters[key]];
    delete filters[key];
    if (!op) continue;
    try {
      if (await allTablesExist(pool, spec.requires)) frag += ` AND ${spec.sql(alias, op)}`;
    } catch { /* skip filter on any schema/catalog error */ }
  }
  return frag;
}

// Build the `{ column: ['Yes','No'] }` map of relationship filter fields to
// advertise for a domain, including only fields whose relationship data exists.
// Returned map is merged into the column-discovery response. Never throws.
export async function advertiseRelationshipColumns(pool, domain) {
  const specs = RELATIONSHIP_FILTERS[domain];
  if (!specs) return {};
  const out = {};
  for (const [key, spec] of Object.entries(specs)) {
    try {
      if (!(await allTablesExist(pool, spec.requires))) continue;
      const r = await pool.query(spec.probe);
      if (r.rows[0]?.e) out[key] = ['Yes', 'No'];
    } catch { /* skip advertisement on any schema/probe error */ }
  }
  return out;
}

// Exposed for tests: reset the table-existence cache between cases.
export function _resetTableExistsCache() {
  _tableExists.clear();
}
