// The orphan-account definition — one place, two consumers.
//
// "Orphan" means: a Principal with no IdentityMembers row, excluding the
// non-human principal classes (a service principal is not a person's account
// that linking failed to attach, so it is never an orphan).
//
// Both the orphaned-accounts context plugin and the orphaned-accounts report
// template answer that question. Re-inlining the anti-join in the second
// consumer would be two mechanisms for one concept, kept in sync by hand — so
// the query and the rule-loading it needs live here instead.

import * as db from '../db/connection.js';
import { DEFAULT_RULES } from './defaultRules.js';

/** Principal classes that are never treated as orphaned accounts. */
export const NON_HUMAN_PRINCIPAL_TYPES = ['ServicePrincipal', 'ManagedIdentity', 'AIAgent'];

/**
 * The active account-linking rule set, merged over the defaults. Falls back to
 * the defaults when no config row exists or the table is unreachable — callers
 * only use it to classify, so a missing config must not fail the read.
 */
export async function loadActiveLinkingRules() {
  try {
    const row = await db.queryOne(
      `SELECT "rules" FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`
    );
    return (row && row.rules) ? { ...DEFAULT_RULES, ...row.rules } : DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * Every orphaned principal, with the columns both consumers need (the context
 * plugin ignores the ones it doesn't file into contexts).
 *
 * @returns {Promise<Array<{id: string, displayName: string|null, email: string|null,
 *   principalType: string|null, extendedAttributes: Object|null, systemId: number|null,
 *   systemName: string|null}>>}
 */
export async function fetchOrphanPrincipals() {
  const { rows } = await db.query(`
    SELECT p."id", p."displayName", p."email", p."principalType",
           p."extendedAttributes", p."systemId", s."displayName" AS "systemName"
      FROM "Principals" p
      LEFT JOIN "IdentityMembers" m ON m."principalId" = p."id"
      LEFT JOIN "Systems" s ON s."id" = p."systemId"
     WHERE m."principalId" IS NULL
       AND COALESCE(p."principalType", '') <> ALL($1::text[])
     ORDER BY p."displayName" NULLS LAST, p."id"
  `, [NON_HUMAN_PRINCIPAL_TYPES]);
  return rows;
}
