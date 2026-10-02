// How much access hangs off each context that groups resources — recalculated
// after a sync and stored on the context (migration 083).
//
// One statement, set-based. The shape matters at scale and each part was
// measured on 41 million assignments, 800,000 resources and 1,500 contexts:
//
//   * Assignments are de-duplicated PER RESOURCE first (one pass over the
//     assignment table, 73 s) and only then summed per context. The governed
//     model stores intent and actual as two rows differing only in `governed`,
//     so a plain count(*) reports one person as two; see
//     docs/architecture/reports.md -> "Counting assignments at scale".
//   * Distinct holders cannot be summed from that — a person holding ten
//     resources of a context is one holder — so they are a second pass (49 s).
//
// Computing the same numbers per context when a report asks for them took 101 s
// for a single count column, which is why they are stored.
//
// Only rows whose numbers changed are written: "Contexts" is audited, and a
// sync that changed nothing must not add a history row per context.

import * as db from '../db/connection.js';
import { OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

export const COUNT_COLUMNS = [
  'resourceCount', 'directAssignmentCount', 'indirectAssignmentCount', 'eligibleAssignmentCount', 'holderCount',
];

const changed = COUNT_COLUMNS.map(c => `c."${c}" IS DISTINCT FROM n."${c}"`).join(' OR ');
const assign = COUNT_COLUMNS.map(c => `"${c}" = n."${c}"`).join(', ');

export const REFRESH_SQL = `
WITH per_resource AS (
  SELECT x.rid,
         count(*) FILTER (WHERE x.t = 'Direct')::int   AS d,
         count(*) FILTER (WHERE x.t = 'Indirect')::int AS i,
         count(*) FILTER (WHERE x.t = 'Eligible')::int AS e
    FROM (SELECT DISTINCT ra."resourceId" AS rid,
                 COALESCE(ra."principalId", ra."identityId") AS h,
                 ra."assignmentType" AS t
            FROM "ResourceAssignments" ra
           WHERE ra."deletedAt" IS NULL) x
   GROUP BY x.rid
),
members AS (
  SELECT cm."contextId" AS cid, cm."memberId" AS rid
    FROM "ContextMembers" cm
    JOIN "Resources" r ON r.id = cm."memberId"
   WHERE cm."memberType" = 'Resource'
     AND r."deletedAt" IS NULL
     AND r."resourceType" NOT IN ${OWNERSHIP_TYPES_SQL}
),
assignments AS (
  SELECT m.cid,
         count(*)::int               AS resources,
         COALESCE(sum(pr.d), 0)::int AS d,
         COALESCE(sum(pr.i), 0)::int AS i,
         COALESCE(sum(pr.e), 0)::int AS e
    FROM members m
    LEFT JOIN per_resource pr ON pr.rid = m.rid
   GROUP BY m.cid
),
holders AS (
  SELECT s.cid, count(*)::int AS holders
    FROM (SELECT DISTINCT m.cid, COALESCE(ra."principalId", ra."identityId") AS h
            FROM members m
            JOIN "ResourceAssignments" ra ON ra."resourceId" = m.rid
           WHERE ra."deletedAt" IS NULL
             AND ra."assignmentType" IN ('Direct', 'Indirect')) s
   GROUP BY s.cid
),
new_counts AS (
  SELECT c.id,
         COALESCE(a.resources, 0) AS "resourceCount",
         COALESCE(a.d, 0)         AS "directAssignmentCount",
         COALESCE(a.i, 0)         AS "indirectAssignmentCount",
         COALESCE(a.e, 0)         AS "eligibleAssignmentCount",
         COALESCE(h.holders, 0)   AS "holderCount"
    FROM "Contexts" c
    LEFT JOIN assignments a ON a.cid = c.id
    LEFT JOIN holders h ON h.cid = c.id
   WHERE c."targetType" = 'Resource'
)
UPDATE "Contexts" c
   SET ${assign}
  FROM new_counts n
 WHERE c.id = n.id
   AND (${changed})`;

/**
 * Recalculate the stored assignment counts of every context that groups
 * resources. Returns how many contexts changed and how long it took.
 * @param {{query: Function}} [client]
 */
export async function refreshContextAssignmentCounts(client = db) {
  const started = Date.now();
  const result = await client.query(REFRESH_SQL);
  return { updated: result.rowCount ?? result.affectedRows ?? 0, durationMs: Date.now() - started };
}
