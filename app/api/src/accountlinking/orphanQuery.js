// The orphan-account definition — one place, every consumer.
//
// "Orphan" means: a *live* Principal with no IdentityMembers row, excluding the
// non-human principal classes (a service principal is not a person's account
// that linking failed to attach, so it is never an orphan). Live matters
// because a full sync tombstones principals that vanished from the source
// (`deletedAt`, see ingest/reconcileStale.js) instead of deleting the row — a
// removed account is not work left undone for the analyst, and must never be
// newly linked to a person.
//
// The orphaned-accounts context plugin, the orphaned-accounts report template
// and the linking engine itself all answer that question. Re-inlining the
// anti-join in any of them would be several mechanisms for one concept, kept in
// sync by hand — which is exactly how the `deletedAt` filter came to be missing
// from all three. So the query text, the query builder for callers that need a
// different projection, and the rule-loading they need live here instead.

import * as db from '../db/connection.js';
import { DEFAULT_RULES } from './defaultRules.js';
import { effectiveLinkingRules } from './rulesMerge.js';

/** Principal classes that are never treated as orphaned accounts. */
export const NON_HUMAN_PRINCIPAL_TYPES = ['ServicePrincipal', 'ManagedIdentity', 'AIAgent'];

/**
 * The parameters every orphan query takes — bound to `$1` of the SQL built by
 * {@link orphanPrincipalsSql}. Pass this, never a hand-written array.
 */
export const ORPHAN_QUERY_PARAMS = [NON_HUMAN_PRINCIPAL_TYPES];

/**
 * Build a query over the orphan set: the `Principals` anti-join against
 * `IdentityMembers`, restricted to live rows and human principal classes. This
 * is the single place the definition is expressed — callers choose only their
 * projection, not which rows are orphans.
 *
 * @param {string} selectList what to project (`Principals` is aliased `p`)
 * @param {{ joins?: string, tail?: string }} [opts] extra joins / trailing clauses
 * @returns {string} SQL whose only parameter is {@link ORPHAN_QUERY_PARAMS}
 */
export function orphanPrincipalsSql(selectList, { joins = '', tail = '' } = {}) {
  return `
    SELECT ${selectList}
      FROM "Principals" p
      LEFT JOIN "IdentityMembers" m ON m."principalId" = p."id"
      ${joins}
     WHERE m."principalId" IS NULL
       AND p."deletedAt" IS NULL
       AND COALESCE(p."principalType", '') <> ALL($1::text[])
     ${tail}
  `;
}

/**
 * The identity behind an account's manager, as a scalar subquery over the
 * `Principals` alias `p` — the context the name-uniqueness guard breaks a tie on
 * where the name alone leaves two people (#1455). A scalar subquery rather than
 * a join: a manager principal attached to two identities would otherwise
 * duplicate the account's row.
 *
 * It is null until the manager's own account is linked, which on the first run
 * after an import it usually is not — the evidence then simply does not fire and
 * a later run picks it up.
 *
 * Both halves of a run read the guard's evidence off this one expression: the
 * orphan load that scores new matches, and the retroactive cleanup that re-judges
 * the links an earlier run made. Written twice they would drift, and a cleanup
 * that cannot see the evidence detaches exactly the links the guard creates.
 */
export const MANAGER_IDENTITY_ID_SQL = `
  (SELECT im."identityId" FROM "IdentityMembers" im
    WHERE im."principalId" = p."managerId" LIMIT 1) AS "managerIdentityId"`;

/**
 * The active account-linking rule set, merged over the defaults by the one
 * merge the engine uses (`effectiveLinkingRules`) — so this answers with the
 * same dictionary a run would use, newly shipped signals included (#1469).
 * Falls back to the defaults when no config row exists or the table is
 * unreachable — callers only use it to classify, so a missing config must not
 * fail the read.
 */
export async function loadActiveLinkingRules() {
  try {
    const row = await db.queryOne(
      `SELECT "rules" FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`
    );
    return effectiveLinkingRules(row?.rules);
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * Every orphaned principal, with the columns the report and the context plugin
 * need (the context plugin ignores the ones it doesn't file into contexts).
 *
 * @returns {Promise<Array<{id: string, displayName: string|null, email: string|null,
 *   principalType: string|null, extendedAttributes: Object|null, systemId: number|null,
 *   systemName: string|null}>>}
 */
export async function fetchOrphanPrincipals() {
  const { rows } = await db.query(orphanPrincipalsSql(
    `p."id", p."displayName", p."email", p."principalType",
     p."extendedAttributes", p."systemId", s."displayName" AS "systemName"`,
    {
      joins: `LEFT JOIN "Systems" s ON s."id" = p."systemId"`,
      tail: `ORDER BY p."displayName" NULLS LAST, p."id"`,
    },
  ), ORPHAN_QUERY_PARAMS);
  return rows;
}
