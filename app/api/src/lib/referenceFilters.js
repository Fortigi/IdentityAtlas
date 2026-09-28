// Reference-field (relationship) filters for the entity list pages.
//
// The Users/Resources filter bars let an analyst filter on scalar columns
// (`buildFilterWhere` in routes/tags/shared.js). This module adds the SAME
// dropdown experience for *reference* fields — "how many owners / members /
// direct reports does this row have" — WITHOUT a new UI control. A reference
// field is surfaced as a pseudo-column keyed `rel.<name>` whose value list is a
// small fixed count picklist, so it renders through the existing FilterBar
// unchanged (see app/ui/src/hooks/useEntityPage.js).
//
// Three heterogeneous stores back these relationships, unified behind one
// registry so a route never has to know the difference:
//   * PrincipalRelationships (Owner / Sponsor)      — principal → principal
//   * Principals.managerId                          — single-valued column
//   * ResourceAssignments / ResourceRelationships   — principal → resource
//
// SAFETY: the picklist strings are defined HERE and echoed by the columns
// endpoints to the UI, which posts the chosen one back verbatim; this module is
// the sole definer AND parser, so the two sides can't drift. An unknown `rel`
// key or an unrecognised value FAILS CLOSED (`AND 1=0`) — it never widens the
// result set (which, on the bulk tag-by-filter path, would over-tag).

import * as db from '../db/connection.js';

// ─── Operator picklist (server-owned contract) ──────────────────
// Value string → { op, n } for a count comparison. Many-valued relations offer
// the full set; single-valued ones (a managerId) only None/Any.
export const MULTI_OPTIONS = ['None (0)', 'Any (1 or more)', 'Exactly 1', '2 or more', '3 or more'];
export const SINGLE_OPTIONS = ['None (0)', 'Any (1 or more)'];

// Null-prototype so a user-supplied value that happens to name an inherited
// member (e.g. 'constructor', 'toString') resolves to undefined and fails
// closed, rather than returning a truthy Object.prototype member.
const VALUE_TO_OPN = Object.assign(Object.create(null), {
  'None (0)': { op: '=', n: 0 },
  'Any (1 or more)': { op: '>=', n: 1 },
  'Exactly 1': { op: '=', n: 1 },
  '2 or more': { op: '>=', n: 2 },
  '3 or more': { op: '>=', n: 3 },
});

// Only these two shapes reach SQL, so op is never attacker-controlled.
const SAFE_ALIAS_RE = /^[a-z][a-z0-9]*$/;

// ─── Registry ───────────────────────────────────────────────────
// Each entry declares its relation ONCE, as a FROM clause plus a WHERE
// predicate that ties the related rows to the subject row `<a>`. Two SQL
// shapes are generated from that one declaration:
//
//   countSql(a)  — the correlated scalar count used by the list-page filter
//                  (`rel.owners = '2 or more'`), which needs a real number.
//   probeSql(…)  — the "does ANY row in this view have this relation" check
//                  the columns endpoints use to decide whether to offer the
//                  filter at all. It needs a boolean, not a count.
//
// They are generated rather than written twice on purpose. The probe used to
// be `EXISTS(SELECT 1 FROM Subject X WHERE scope AND (countSql) >= 1)`, and an
// aggregate is an optimisation fence: Postgres cannot flatten it into a
// semi-join, so it evaluated the correlated count once per subject row and
// stopped only when it found a hit. With no `directReports` index and no hit
// near the start of the heap that is a full table scan PER ROW — 8.1 s on a
// 176 k-principal tenant, on every filter-bar load, and unbounded when the
// relation is empty. Driving the probe from the relation side instead lets the
// planner use a plain semi-join (8.1 s → 22 ms, and 1.9 ms with the
// `ix_Principals_managerId` index from migration 075).
//
// `from` is null for a single-valued relation (a `managerId` column): there is
// no second table, so the count degrades to a CASE and the probe to a plain
// column test, with no special path in either generator.
//
// The relation's WHERE already filters soft-deleted related rows so the count
// matches the live-only list the routes render (the outer query hides
// `deletedAt IS NOT NULL`; an owner/member whose account is tombstoned must not
// keep a row "owned").
const REGISTRY = [
  // Principals ----------------------------------------------------
  {
    key: 'owners', label: 'Owners', table: 'principals', card: 'many',
    from: `"PrincipalRelationships" pr
       JOIN "Principals" rp ON rp.id = pr."relatedPrincipalId" AND rp."deletedAt" IS NULL`,
    where: (a) => `pr."principalId" = ${a}.id AND pr."relationshipType" = 'Owner'`,
  },
  {
    key: 'sponsors', label: 'Sponsors', table: 'principals', card: 'many',
    from: `"PrincipalRelationships" pr
       JOIN "Principals" rp ON rp.id = pr."relatedPrincipalId" AND rp."deletedAt" IS NULL`,
    where: (a) => `pr."principalId" = ${a}.id AND pr."relationshipType" = 'Sponsor'`,
  },
  {
    key: 'manager', label: 'Manager', table: 'principals', card: 'one',
    from: null,
    where: (a) => `${a}."managerId" IS NOT NULL`,
  },
  {
    key: 'ownsAgents', label: 'Owns agents', table: 'principals', card: 'many',
    from: `"PrincipalRelationships" pr
       JOIN "Principals" sp ON sp.id = pr."principalId" AND sp."deletedAt" IS NULL`,
    where: (a) => `pr."relatedPrincipalId" = ${a}.id AND pr."relationshipType" = 'Owner'`,
  },
  {
    key: 'directReports', label: 'Direct reports', table: 'principals', card: 'many',
    from: `"Principals" m`,
    where: (a) => `m."managerId" = ${a}.id AND m."deletedAt" IS NULL`,
  },
  // Resources -----------------------------------------------------
  {
    // All assignment types (Direct/Indirect/Eligible) to match the resource
    // detail page's memberCount — one definition of "member".
    key: 'members', label: 'Members', table: 'resources', card: 'many',
    from: `"ResourceAssignments" ra`,
    where: (a) => `ra."resourceId" = ${a}.id AND ra."deletedAt" IS NULL`,
  },
  {
    key: 'owners', label: 'Owners', table: 'resources', card: 'many',
    from: `"ResourceRelationships" rr
       JOIN "ResourceAssignments" ra ON ra."resourceId" = rr."childResourceId"
            AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL`,
    where: (a) => `rr."parentResourceId" = ${a}.id AND rr."relationshipType" = 'HasOwnership'`,
  },
];

// The correlated scalar count of related rows for subject row `<alias>`.
// A single-valued relation has no rows to count, so it yields 0 or 1 directly.
export function countSqlFor(entry, alias) {
  return entry.from
    ? `(SELECT count(*) FROM ${entry.from}
      WHERE ${entry.where(alias)})`
    : `(CASE WHEN ${entry.where(alias)} THEN 1 ELSE 0 END)`;
}

// "Does at least one subject row matching `subjectWhere` have this relation?"
// The subject table is listed in the SAME FROM as the relation, so the whole
// thing is one flat join the planner can answer with a semi-join — never a
// per-row correlated aggregate. `subjectWhere` is written against alias `X`.
export function probeSqlFor(entry, subjectTable, subjectWhere) {
  const from = entry.from ? `"${subjectTable}" X, ${entry.from}` : `"${subjectTable}" X`;
  return `EXISTS(SELECT 1 FROM ${from}
      WHERE ${subjectWhere} AND ${entry.where('X')})`;
}

const TABLES = { principals: 'Principals', resources: 'Resources' };
const SCOPE_COL = { principals: 'principalType', resources: 'resourceType' };

function entriesFor(table) {
  return REGISTRY.filter((e) => e.table === table);
}

function optionsFor(entry) {
  return entry.card === 'one' ? SINGLE_OPTIONS : MULTI_OPTIONS;
}

// Collect the `rel.*` reference-field filters as a list of {field, value}
// pairs. The user-supplied key is carried as a VALUE, never used as a property
// name (no dynamic property write → no prototype-pollution surface). We don't
// strip them from attrFilters: buildFilterWhere only matches `ext.*` and real
// column names, so a leftover `rel.*` key is already ignored there.
const REL_PREFIX = 'rel.';
export function extractRelFilters(attrFilters) {
  const rel = [];
  for (const k of Object.keys(attrFilters || {})) {
    if (k.startsWith(REL_PREFIX)) rel.push({ field: k, value: attrFilters[k] });
  }
  return rel;
}

// Build the WHERE fragment for a set of `rel.*` filters. No positional params
// are emitted — the operator is one of two whitelisted shapes and the threshold
// is a validated small integer — so callers need no `bind`, and the fragment is
// safe to append after `buildFilterWhere` (before the COUNT snapshot).
export function buildRelationshipWhere(relFilters, table, alias) {
  const list = Array.isArray(relFilters) ? relFilters : [];
  if (list.length === 0) return '';
  if (!SAFE_ALIAS_RE.test(alias) || !TABLES[table]) return ' AND 1=0';
  let where = '';
  for (const { field, value } of list) {
    const key = String(field).slice(REL_PREFIX.length); // strip 'rel.'
    const entry = REGISTRY.find((e) => e.table === table && e.key === key);
    const opn = VALUE_TO_OPN[value];
    // Fail closed: unknown field, unknown value, or a count operator on a
    // single-valued relation (which never offers >1) matches nothing.
    if (!entry || !opn || (entry.card === 'one' && opn.n > 1)) {
      where += ' AND 1=0';
      continue;
    }
    where += ` AND (${countSqlFor(entry, alias)}) ${opn.op} ${opn.n}`;
  }
  return where;
}

// Discover which reference fields have data in the CURRENT sub-view and should
// therefore appear in the filter dropdown. `scope` carries the page's active
// sub-tab (principalType for the Users page, resourceType for Resources) so a
// field only shows where it actually applies — e.g. `manager` never appears on
// the AI-Agents tab, `owners` never on the ordinary Users tab. Returns rows
// shaped like the columns endpoint's `{ column, values }`, plus a `label` the
// UI uses directly (so it needn't hardcode a name per page).
export async function discoverReferenceFields(table, scope = {}, conn = db) {
  const entries = entriesFor(table);
  if (!entries.length || !TABLES[table]) return [];
  const t = TABLES[table];

  const params = [];
  let scopeWhere = 'X."deletedAt" IS NULL';
  const scopeVal = scope?.[SCOPE_COL[table]];
  if (scopeVal != null && String(scopeVal).trim() !== '') {
    params.push(String(scopeVal));
    scopeWhere += ` AND X."${SCOPE_COL[table]}" = $${params.length}`;
  }

  const cols = entries.map((e, i) => `${probeSqlFor(e, t, scopeWhere)} AS c${i}`);
  const r = await conn.query(`SELECT ${cols.join(', ')}`, params);
  const row = r.rows[0] || {};
  return entries
    .filter((_, i) => row[`c${i}`])
    .map((e) => ({ column: `rel.${e.key}`, label: e.label, values: optionsFor(e) }));
}

// Map an assign-by-filter entityType to the registry's table discriminator.
export function storeForEntityType(entityType) {
  if (entityType === 'user') return 'principals';
  if (entityType === 'resource' || entityType === 'group') return 'resources';
  return null; // identities have no reference fields (accountCount already filters them)
}
