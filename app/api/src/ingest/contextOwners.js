/**
 * The owner a source names for a synced context, stated as its Accountable.
 *
 * "Contexts"."ownerUserId" is free text: whatever the source calls the owner of
 * a grouping — an account key, an employee number. The context page shows who
 * answers for a context from "ContextRoles" (migration 094), so an owner that
 * stays a string there reads as "Nobody is accountable yet" on every logical
 * application a source delivered with an owner. This turns the string into the
 * role, at the end of every contexts ingest.
 *
 * Only for SYNCED contexts. On a manual context ownerUserId is the analyst who
 * created it, which is not a statement about who answers for it; a generated
 * context gets its roles from its plugin (addedBy 'algorithm').
 *
 * Resolution — one set-based statement per batch, never one lookup per context:
 *   1. "Principals"."externalId" = ownerUserId, tie broken exactly as the read
 *      endpoints break it (OWNER_PRINCIPAL_ORDER, shared with
 *      routes/contexts/read.js): a live row over a soft-deleted one, the
 *      context's own scope system over any other, then the id.
 *   2. Else "Principals"."employeeId" = ownerUserId, but only when exactly ONE
 *      live principal carries it. Two accounts of one person in two systems
 *      share an employee number, and picking one of them would be a guess.
 * Both joins are index lookups: ix_Principals_externalId (migration 076) and
 * ix_Principals_employeeId (migration 001), so no index is added for this.
 *
 * What it writes, per context in the batch:
 *   - owner resolves to P, no Accountable yet      → add P, addedBy 'sync'   (set)
 *   - owner resolves to P, 'sync' Accountable ≠ P  → point that row at P     (replaced)
 *   - no owner, or it resolves to nobody           → drop a 'sync' Accountable (removed)
 *   - an 'analyst' or 'algorithm' Accountable      → left alone, whatever the source says
 * The Accountable is unique per context (ux_ContextRoles_accountable), so a
 * choice an analyst made is never overwritten by the next sync; it gives way
 * only when the analyst removes it. A Responsible is never touched.
 *
 * Runs after the batch's own upsert, in the same place and the same way
 * managerLinks.js runs: after a single-batch load and inside a sync session's
 * transaction at its end. Migration 096 did the insert-only half once for
 * databases that held synced owners before this existed.
 */

import { ROLE_BEARING_CATEGORIES } from '../lib/contextCategories.js';

// The tie-break among principals sharing an externalId. `p` is the principal,
// `c` the context (any relation with a "scopeSystemId" column).
export const OWNER_PRINCIPAL_ORDER = `(p."deletedAt" IS NULL) DESC,
                    (p."systemId" IS NOT DISTINCT FROM c."scopeSystemId") DESC,
                    p.id`;

const ROLE_BEARING_SQL = [...ROLE_BEARING_CATEGORIES].map(cat => `'${cat}'`).join(', ');

// The CTEs `scoped` (the synced contexts of the batch and the owner each names,
// NULL when it names none or the context carries no roles) and `resolved`
// (contextId → principalId). `scopePredicate` selects contexts from "Contexts" c.
export function ownerResolutionCtes(scopePredicate) {
  return `
scoped AS (
  SELECT c.id, c."scopeSystemId",
         CASE WHEN c."contextCategory" IN (${ROLE_BEARING_SQL}) THEN NULLIF(c."ownerUserId", '') END AS owner
    FROM "Contexts" c
   WHERE c.variant = 'synced' AND (${scopePredicate})
),
by_external_id AS (
  SELECT DISTINCT ON (c.id) c.id AS "contextId", p.id AS "principalId"
    FROM scoped c
    JOIN "Principals" p ON p."externalId" = c.owner
   ORDER BY c.id, ${OWNER_PRINCIPAL_ORDER}
),
by_employee_id AS (
  SELECT c.id AS "contextId", (array_agg(p.id))[1] AS "principalId"
    FROM scoped c
    JOIN "Principals" p ON p."employeeId" = c.owner AND p."deletedAt" IS NULL
   WHERE NOT EXISTS (SELECT 1 FROM by_external_id x WHERE x."contextId" = c.id)
   GROUP BY c.id
  HAVING count(*) = 1
),
resolved AS (
  SELECT "contextId", "principalId" FROM by_external_id
  UNION ALL
  SELECT "contextId", "principalId" FROM by_employee_id
)`;
}

// One statement: the data-modifying CTEs all see the same snapshot of
// `accountable`, so each context lands in exactly one branch.
export function buildAccountableReconcileSql(scopePredicate) {
  return `
WITH ${ownerResolutionCtes(scopePredicate)},
accountable AS (
  SELECT r.id, r."contextId", r."principalId", r."addedBy"
    FROM "ContextRoles" r
    JOIN scoped c ON c.id = r."contextId"
   WHERE r.role = 'Accountable'
),
replaced AS (
  UPDATE "ContextRoles" r
     SET "principalId" = res."principalId", "identityId" = NULL,
         "updatedAt" = (now() AT TIME ZONE 'utc')
    FROM accountable a
    JOIN resolved res ON res."contextId" = a."contextId"
   WHERE r.id = a.id AND a."addedBy" = 'sync'
     AND a."principalId" IS DISTINCT FROM res."principalId"
  RETURNING r.id
),
removed AS (
  DELETE FROM "ContextRoles" r
   USING accountable a
   WHERE r.id = a.id AND a."addedBy" = 'sync'
     AND NOT EXISTS (SELECT 1 FROM resolved res WHERE res."contextId" = a."contextId")
  RETURNING r.id
),
added AS (
  INSERT INTO "ContextRoles" ("contextId", "principalId", "role", "addedBy")
  SELECT res."contextId", res."principalId", 'Accountable', 'sync'
    FROM resolved res
   WHERE NOT EXISTS (SELECT 1 FROM accountable a WHERE a."contextId" = res."contextId")
  ON CONFLICT DO NOTHING
  RETURNING id
)
SELECT (SELECT count(*) FROM added)::int    AS "set",
       (SELECT count(*) FROM replaced)::int AS "replaced",
       (SELECT count(*) FROM removed)::int  AS "removed",
       (SELECT count(*) FROM scoped c
         WHERE c.owner IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM resolved res WHERE res."contextId" = c.id))::int AS "unresolved"`;
}

async function runReconcile(runner, scopePredicate, params) {
  const r = await runner.query(buildAccountableReconcileSql(scopePredicate), params);
  const row = r.rows[0] || {};
  return {
    set: row.set ?? 0,
    replaced: row.replaced ?? 0,
    removed: row.removed ?? 0,
    unresolved: row.unresolved ?? 0,
  };
}

/**
 * After a single-batch contexts load: reconcile the contexts of that batch.
 *
 * @param {{query: Function}} runner - db module or an in-transaction pg client
 * @param {string} tableName - the table just loaded; anything but Contexts is a no-op
 * @param {Array<object>} records - the normalized batch
 * @returns {Promise<{set:number,replaced:number,removed:number,unresolved:number}|null>}
 */
export async function reconcileBatchAccountables(runner, tableName, records) {
  if (tableName !== 'Contexts' || !Array.isArray(records)) return null;
  const ids = records.map(r => r?.id).filter(Boolean);
  if (ids.length === 0) return null;
  return runReconcile(runner, 'c.id = ANY($1::uuid[])', [ids]);
}

/**
 * At the end of a contexts sync session, inside its transaction: reconcile every
 * context the session staged (its temp table holds the whole set).
 */
export async function reconcileSessionAccountables(runner, tableName, tempTable) {
  if (tableName !== 'Contexts' || !tempTable) return null;
  return runReconcile(runner, `c.id IN (SELECT "id" FROM "${tempTable}")`, []);
}
