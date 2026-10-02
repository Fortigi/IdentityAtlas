// How much access hangs off each context that groups resources — recalculated
// after a sync and stored on the context (migration 083).
//
// Set-based, in three steps inside one transaction. The shape matters at scale
// and was measured on 41 million assignments, 800,000 resources and 1,500
// contexts:
//
//   1. Assignments are de-duplicated PER RESOURCE (one pass over the assignment
//      table) and only then summed per context. The governed model stores intent
//      and actual as two rows differing only in `governed`, so a plain count(*)
//      reports one person as two; see docs/architecture/reports.md -> "Counting
//      assignments at scale". 79 s.
//   2. Distinct holders cannot be summed from that — a person holding ten
//      resources of a context is one holder — so they are a second pass. 51 s.
//   3. One UPDATE writes both, and only to rows whose numbers changed:
//      "Contexts" is audited, and a sync that changed nothing must not add a
//      history row per context.
//
// Steps 1 and 2 land in temporary tables rather than in CTEs of one statement.
// As one statement the same work took 207 s: the planner had no row estimates
// for the intermediate sets and joined them the slow way. As two statements
// with a small table each, it is the sum of its parts.
//
// Computing the same numbers per context when a report asks for them took 101 s
// for a single count column, which is why they are stored at all.

import * as db from '../db/connection.js';
import { OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

export const COUNT_COLUMNS = [
  'resourceCount', 'directAssignmentCount', 'indirectAssignmentCount', 'eligibleAssignmentCount', 'holderCount',
];

// The resources of each context: live, and never the synthetic ownership rows.
const MEMBERS = `
    FROM "ContextMembers" cm
    JOIN "Resources" r ON r.id = cm."memberId"
     AND r."deletedAt" IS NULL
     AND r."resourceType" NOT IN ${OWNERSHIP_TYPES_SQL}`;

export const ASSIGNMENTS_SQL = `
CREATE TEMP TABLE ctx_assignment_counts ON COMMIT DROP AS
SELECT cm."contextId" AS cid,
       count(*)::int               AS resources,
       COALESCE(sum(pr.d), 0)::int AS d,
       COALESCE(sum(pr.i), 0)::int AS i,
       COALESCE(sum(pr.e), 0)::int AS e${MEMBERS}
    LEFT JOIN (
         SELECT x.rid,
                count(*) FILTER (WHERE x.t = 'Direct')   AS d,
                count(*) FILTER (WHERE x.t = 'Indirect') AS i,
                count(*) FILTER (WHERE x.t = 'Eligible') AS e
           FROM (SELECT DISTINCT ra."resourceId" AS rid,
                        COALESCE(ra."principalId", ra."identityId") AS h,
                        ra."assignmentType" AS t
                   FROM "ResourceAssignments" ra
                  WHERE ra."deletedAt" IS NULL) x
          GROUP BY x.rid) pr ON pr.rid = cm."memberId"
   WHERE cm."memberType" = 'Resource'
   GROUP BY cm."contextId"`;

export const HOLDERS_SQL = `
CREATE TEMP TABLE ctx_holder_counts ON COMMIT DROP AS
SELECT s.cid, count(*)::int AS holders
  FROM (SELECT DISTINCT cm."contextId" AS cid, COALESCE(ra."principalId", ra."identityId") AS h${MEMBERS}
          JOIN "ResourceAssignments" ra ON ra."resourceId" = cm."memberId"
         WHERE cm."memberType" = 'Resource'
           AND ra."deletedAt" IS NULL
           AND ra."assignmentType" IN ('Direct', 'Indirect')) s
 GROUP BY s.cid`;

const changed = COUNT_COLUMNS.map(c => `c."${c}" IS DISTINCT FROM n."${c}"`).join(' OR ');
const assign = COUNT_COLUMNS.map(c => `"${c}" = n."${c}"`).join(', ');

export const UPDATE_SQL = `
UPDATE "Contexts" c
   SET ${assign}
  FROM (SELECT x.id,
               COALESCE(a.resources, 0) AS "resourceCount",
               COALESCE(a.d, 0)         AS "directAssignmentCount",
               COALESCE(a.i, 0)         AS "indirectAssignmentCount",
               COALESCE(a.e, 0)         AS "eligibleAssignmentCount",
               COALESCE(h.holders, 0)   AS "holderCount"
          FROM "Contexts" x
          LEFT JOIN ctx_assignment_counts a ON a.cid = x.id
          LEFT JOIN ctx_holder_counts h ON h.cid = x.id
         WHERE x."targetType" = 'Resource') n
 WHERE c.id = n.id
   AND (${changed})`;

/**
 * Recalculate the stored assignment counts of every context that groups
 * resources. Returns how many contexts changed and how long it took.
 * @param {Function} [transaction]  runs a callback with a client inside one
 *   transaction; the temporary tables live exactly as long as it does.
 */
export async function refreshContextAssignmentCounts(transaction = db.tx) {
  const started = Date.now();
  const updated = await transaction(async (client) => {
    await client.query(ASSIGNMENTS_SQL);
    await client.query(HOLDERS_SQL);
    const result = await client.query(UPDATE_SQL);
    return result.rowCount ?? result.affectedRows ?? 0;
  });
  return { updated, durationMs: Date.now() - started };
}
