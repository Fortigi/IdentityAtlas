// Row scope for the custom-report engine: "this query may only see the records
// that caller may open", applied INSIDE the compiled SQL — on the report's own
// table, inside every relation condition and inside every relation column — so
// a filter, a count, a grouping or a name list can never reach past it. It is
// applied before anything is aggregated, never to the rows afterwards.
//
// Today one kind of scope exists: a context owner's (auth/contextOwner.js). The
// predicates are the owner-access tiers themselves (auth/ownerAccess/tiers.js
// OPENABLE_SQL), the same SQL the REST API decides "may this owner open that
// page" with, so an MCP answer and a REST page cannot disagree.
//
//   const scope = createRowScope(owner.contextIds);
//   compileSpec(spec, extFields, { scope });
//   resolveNamedObjects(spec, query, { scope });
//
// A record's OWN fields stay as they are, including counts stored on or computed
// for it (a group's member count, a context's holder count): they are what its
// detail page shows, and the record is one the caller may open. What it is
// RELATED to is restricted: a relation reaches only records in scope.
//
// Fail closed: a table this file does not know throws instead of compiling an
// unscoped query (scope.test.js lists every catalog table, so a new entity
// cannot slip past by accident).

import { OPENABLE_SQL } from '../auth/ownerAccess/tiers.js';

const KIND_OF_TABLE = Object.freeze({
  Principals: 'principal',
  Identities: 'identity',
  Resources: 'resource',
  Contexts: 'context',
});

// A change is an event about an account and a resource. It is visible when
// either end opens — exactly what that account's and that resource's timelines
// show an owner over REST.
const CHANGE_TABLE = 'AssignmentChanges';

/** The tables a scope can restrict — every table the catalog reads a record from. */
export const SCOPED_TABLES = Object.freeze([...Object.keys(KIND_OF_TABLE), CHANGE_TABLE]);

/**
 * The predicate restricting `alias` (a row of `table`) to the scope.
 * `scopeRef` is the SQL expression holding the context ids, e.g. `$4::uuid[]`.
 */
export function scopePredicate(table, alias, scopeRef) {
  if (table === CHANGE_TABLE) {
    return `(${OPENABLE_SQL.principal(`${alias}."principalId"`, scopeRef)} OR ${OPENABLE_SQL.resource(`${alias}."resourceId"`, scopeRef)})`;
  }
  const kind = Object.hasOwn(KIND_OF_TABLE, table) ? KIND_OF_TABLE[table] : null;
  if (!kind) throw new Error(`no row scope is defined for table ${table}`);
  return OPENABLE_SQL[kind](`${alias}."id"`, scopeRef);
}

/**
 * A context owner's row scope. `basis` names why the caller is scoped; it rides
 * along into the response metadata (mcp/scopeMeta.js).
 */
export function createRowScope(contextIds, { basis = 'context-owner' } = {}) {
  const ids = [...new Set([...(contextIds || [])].map(id => String(id).toLowerCase()))].sort();
  return Object.freeze({ basis, contextIds: ids });
}
