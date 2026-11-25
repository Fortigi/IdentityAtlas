/**
 * A person's manager, derived from the managers of their accounts (#1640).
 *
 * The manager relation is stored twice:
 *   • "Principals"."managerId"         → the manager's ACCOUNT — every source sends it
 *   • "Identities"."managerIdentityId" → the manager's PERSON  — only some sources do
 *
 * Without this step a person had a manager only when the source sent the
 * person-level value itself, so on CSV, SQL and Account Linking datasets every
 * person ended up managerless while all their accounts had one. The person-level
 * manager follows from the account level through the links:
 *
 *   person ─IdentityMembers→ account ─managerId→ manager's account ─IdentityMembers→ manager
 *
 * Rules (the certified spec on #1640):
 *   • A manager the source sent ("managerIdentitySource" = 'Source', stamped by
 *     normalization.js) is never touched. Only empty rows and rows this step
 *     wrote itself ('Derived') are filled, refreshed or cleared.
 *   • When a person's accounts disagree, the HR-authoritative account counts,
 *     then the primary one — the precedence the matrix uses to pick a person's
 *     representative account (routes/matrix.js). Accounts that still tie must
 *     agree; otherwise the manager stays empty rather than guessed.
 *   • No guessing either when the deciding account's manager is linked to no
 *     person, or resolves to the person themselves.
 *   • Rejected links ("analystOverride" = 'rejected') stay in IdentityMembers as
 *     tombstones; they are not memberships, on either hop.
 *   • A manager account linked to several persons (a data defect) resolves to
 *     the lowest identity id, so reruns are stable.
 *
 * Not system-scoped: "Identities" has no systemId (one person, many systems),
 * and the links that decide it may come from any system. One set-based
 * statement over the whole table, run once at the end of a load that could have
 * changed the answer (see shouldDeriveIdentityManagers).
 */

export const DERIVE_IDENTITY_MANAGERS_SQL = `
WITH ranked AS (
  SELECT im."identityId",
         mi."identityId" AS "managerIdentityId",
         rank() OVER (PARTITION BY im."identityId"
                      ORDER BY im."isHrAuthoritative" DESC NULLS LAST,
                               im."isPrimary" DESC NULLS LAST) AS rnk
    FROM "IdentityMembers" im
    JOIN "Principals" p ON p.id = im."principalId" AND p."managerId" IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT m."identityId"
        FROM "IdentityMembers" m
       WHERE m."principalId" = p."managerId"
         AND m."analystOverride" IS DISTINCT FROM 'rejected'
       ORDER BY m."identityId"
       LIMIT 1
    ) mi ON true
   WHERE im."analystOverride" IS DISTINCT FROM 'rejected'
), derived AS (
  SELECT "identityId", (array_agg("managerIdentityId"))[1] AS "managerIdentityId"
    FROM ranked
   WHERE rnk = 1
   GROUP BY "identityId"
  HAVING count("managerIdentityId") = count(*)
     AND count(DISTINCT "managerIdentityId") = 1
     AND bool_and("managerIdentityId" <> "identityId")
), target AS (
  SELECT i.id, d."managerIdentityId"
    FROM "Identities" i
    LEFT JOIN derived d ON d."identityId" = i.id
   WHERE (i."managerIdentitySource" = 'Derived'
          OR (i."managerIdentitySource" IS NULL AND i."managerIdentityId" IS NULL))
     AND i."managerIdentityId" IS DISTINCT FROM d."managerIdentityId"
), changed AS (
  UPDATE "Identities" i
     SET "managerIdentityId" = t."managerIdentityId",
         "managerIdentitySource" = CASE WHEN t."managerIdentityId" IS NULL THEN NULL ELSE 'Derived' END
    FROM target t
   WHERE i.id = t.id
  RETURNING (t."managerIdentityId" IS NULL) AS cleared
)
SELECT (count(*) FILTER (WHERE NOT cleared))::int AS "derived",
       (count(*) FILTER (WHERE cleared))::int     AS "cleared"
  FROM changed`;

/**
 * Whether a load could have changed any person's derived manager. Pure.
 *
 * - IdentityMembers: links decide both hops, so every membership load counts.
 * - Principals / Identities: only when the load wrote a manager link
 *   (batchHasManagerLink / columnsHaveManagerLink in managerLinks.js). The Entra
 *   photo phase alone posts hundreds of principal batches carrying nothing but
 *   an id and an image; they must stay free.
 */
export function shouldDeriveIdentityManagers(tableName, touchedManager) {
  if (tableName === 'IdentityMembers') return true;
  if (tableName === 'Principals' || tableName === 'Identities') return touchedManager === true;
  return false;
}

/**
 * Derive person-level managers from the linked accounts.
 *
 * @param {{query: Function}} runner - db module or an in-transaction pg client
 * @returns {Promise<{derived: number, cleared: number}>} persons whose manager
 *   was set or changed, and persons whose derived manager no longer holds
 */
export async function deriveIdentityManagers(runner) {
  const res = await runner.query(DERIVE_IDENTITY_MANAGERS_SQL);
  const row = res?.rows?.[0] || {};
  return { derived: row.derived || 0, cleared: row.cleared || 0 };
}

/**
 * The step as an ingest load runs it: a no-op (null) for a load that could not
 * have changed the answer, otherwise deriveIdentityManagers.
 */
export async function deriveIdentityManagersAfterLoad(runner, tableName, touchedManager) {
  if (!shouldDeriveIdentityManagers(tableName, touchedManager)) return null;
  return deriveIdentityManagers(runner);
}
