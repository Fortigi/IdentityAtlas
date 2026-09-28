/**
 * Manager links that point at nobody — repaired once, at the end of a principals
 * load.
 *
 * A crawler knows its source's id for someone's manager, never ours, so it sends
 * `managerExternalId` and normalization.js turns it into the deterministic id the
 * manager's OWN row will be keyed by. That is what makes the link work with no
 * lookup and no ordering requirement — and it is also why the id exists whether
 * or not the manager does. Two ways it ends up pointing at nobody:
 *
 *   • the source names a manager it never exported — a leaver, a workgroup, a
 *     row outside the statement's WHERE clause;
 *   • the source names the person themselves (a self-managing CEO record is a
 *     real and common directory artefact).
 *
 * Neither can be judged per batch: the manager is usually further down the same
 * load. So the check runs once the whole set is in the table — at the end of a
 * sync session, or after a single-batch load, which are the only two shapes a
 * crawler ingest takes (tools/crawlers/shared/Invoke-CrawlerIngest.ps1 either
 * sends one batch or opens a session).
 *
 * Leaving a dangling id is not an option. "Principals"."managerId" has no foreign
 * key, so the value survives, and the `hasManager` reference filter
 * (lib/referenceFilters.js) asks only whether the column is set: an unresolvable
 * manager would read as "has a manager" while every join through it returns
 * nothing — a link that looks right and goes nowhere. Nulling it is honest, and
 * the count is returned rather than swallowed so the ingest response and the job
 * log can state how many were dropped.
 *
 * Scoped to the loading system's own rows: a system that only references another
 * directory's principals must not clear links the directory itself owns. A
 * manager that a LATER system's crawler loads is nulled here and re-resolves on
 * the referring system's next full sync — every full sync re-sends
 * managerExternalId — so a cross-system link settles one run later instead of
 * being lost.
 */

// One statement, one snapshot: `broken` is evaluated once, the data-modifying CTE
// runs to completion whether or not its output is read (Postgres guarantees
// that), and the counts describe exactly the rows that were cleared.
export const REPAIR_MANAGER_LINKS_SQL = `
WITH broken AS (
  SELECT p.id, (p."managerId" = p.id) AS self
    FROM "Principals" p
   WHERE p."systemId" = $1
     AND p."managerId" IS NOT NULL
     AND (p."managerId" = p.id
          OR NOT EXISTS (SELECT 1 FROM "Principals" m WHERE m.id = p."managerId"))
), cleared AS (
  UPDATE "Principals" SET "managerId" = NULL WHERE id IN (SELECT id FROM broken)
)
SELECT (count(*) FILTER (WHERE self))::int     AS "selfReferences",
       (count(*) FILTER (WHERE NOT self))::int AS "unresolved"
  FROM broken`;

/**
 * Whether a normalized batch wrote any manager link at all. The sweep is an
 * anti-join over every principal of the system, so it must not run for a batch
 * that could not have broken one: the Entra photo phase alone posts hundreds of
 * principal batches per run carrying nothing but an id and an image.
 */
export function batchHasManagerLink(records) {
  return Array.isArray(records) && records.some(r => r && r.managerId !== undefined && r.managerId !== null);
}

/**
 * The same question for a sync session, which keeps columns rather than rows.
 * A session's column set is fixed by its first batch, so a managerId absent
 * from it was never written by any batch of that session.
 */
export function columnsHaveManagerLink(activeColumns) {
  return Array.isArray(activeColumns) && activeColumns.some(c => c && c.name === 'managerId');
}

/**
 * Clear manager links that point at nobody, for one system's principals.
 *
 * @param {{query: Function}} runner - db module or an in-transaction pg client
 * @param {string} tableName - the table just loaded; anything but Principals is a no-op
 * @param {number} systemId - the loading system
 * @param {boolean} touchedManager - whether this load wrote any manager link
 *   (batchHasManagerLink / columnsHaveManagerLink); false makes the call free
 * @returns {Promise<{unresolved: number, selfReferences: number}|null>} null when
 *   the table is not Principals, no system is known, no manager was written, or
 *   nothing was broken.
 */
export async function repairManagerLinks(runner, tableName, systemId, touchedManager) {
  if (tableName !== 'Principals') return null;
  if (systemId === undefined || systemId === null) return null;
  if (!touchedManager) return null;
  const res = await runner.query(REPAIR_MANAGER_LINKS_SQL, [systemId]);
  const row = res?.rows?.[0] || {};
  const unresolved = row.unresolved || 0;
  const selfReferences = row.selfReferences || 0;
  if (unresolved === 0 && selfReferences === 0) return null;
  return { unresolved, selfReferences };
}

/**
 * The one-line warning for a repair result, or null when there is nothing to say.
 * Pure, so the wording is asserted without a database.
 */
export function managerLinkWarning(repair) {
  if (!repair) return null;
  const parts = [];
  if (repair.unresolved) parts.push(`${repair.unresolved} named a manager that was not loaded`);
  if (repair.selfReferences) parts.push(`${repair.selfReferences} named themselves as manager`);
  return `Manager links cleared: ${parts.join('; ')}.`;
}
