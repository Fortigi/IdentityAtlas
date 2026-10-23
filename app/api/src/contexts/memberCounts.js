// Shared helper for keeping Contexts.directMemberCount and totalMemberCount
// in sync after a write to ContextMembers. Used by every code path that
// adds or removes members:
//
//   - contexts.js POST   /api/contexts/:id/members         (analyst add)
//   - contexts.js DELETE /api/contexts/:id/members/:mid    (analyst remove)
//   - tags.js     POST   /api/tags/:id/assign              (tag bulk add)
//   - tags.js     POST   /api/tags/:id/unassign            (tag bulk remove)
//   - tags.js     POST   /api/tags/:id/assign-by-filter    (tag filter add)
//
// The plugin runner (runner.js) has its own batched version that also
// recomputes counts for every produced context — that doesn't go through
// here because it needs a different scope. This helper is for one-context-
// at-a-time analyst writes.

import * as db from '../db/connection.js';

// Refresh directMemberCount on `contextId` and totalMemberCount on every
// ancestor up to the root. Cheap because each ancestor's subtree count is
// done in a single recursive CTE.
export async function recalcMemberCountsForChain(contextId) {
  // Walk up parentContextId to collect the full chain (including self).
  // 100 hops is way more than any realistic tree, so the bound is just a
  // cycle-safety net.
  const chain = [contextId];
  let current = contextId;
  for (let i = 0; i < 100; i++) {
    const r = await db.queryOne(
      `SELECT "parentContextId" FROM "Contexts" WHERE id = $1`,
      [current]
    );
    if (!r?.parentContextId) break;
    if (chain.includes(r.parentContextId)) break;
    chain.push(r.parentContextId);
    current = r.parentContextId;
  }

  // directMemberCount is only stored on the affected context — ancestors
  // didn't gain or lose direct members.
  await db.query(
    `UPDATE "Contexts"
        SET "directMemberCount" = COALESCE((
              SELECT COUNT(*)::int FROM "ContextMembers" WHERE "contextId" = $1
            ), 0),
            "lastCalculatedAt"  = now() AT TIME ZONE 'utc'
      WHERE id = $1`,
    [contextId]
  );

  // totalMemberCount on every node in the chain. For each chain node,
  // walk down its subtree and count distinct members.
  await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id AS root_id, id AS node_id
         FROM "Contexts" WHERE id = ANY($1::uuid[])
       UNION
       SELECT s.root_id, c.id
         FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.node_id
     ),
     totals AS (
       SELECT s.root_id, COUNT(DISTINCT cm."memberId")::int AS cnt
         FROM subtree s
         LEFT JOIN "ContextMembers" cm ON cm."contextId" = s.node_id
        GROUP BY s.root_id
     )
     UPDATE "Contexts" c
        SET "totalMemberCount" = t.cnt
       FROM totals t
      WHERE c.id = t.root_id`,
    [chain]
  );
}

// Refresh directMemberCount on every listed context, then roll up
// totalMemberCount over each one's subtree (distinct members, so a person who is
// a direct member of two sibling leaves in the same tree isn't double-counted).
// For a batch writer: the plugin runner (`runner` = its transaction client) and
// the context upload (`runner` = the db module). A context left with no members
// is set to 0 — a re-run or re-upload that empties a unit must not keep its old
// count.
export async function refreshMemberCounts(runner, contextIds) {
  if (contextIds.length === 0) return;

  await runner.query(`
    UPDATE "Contexts" c
       SET "directMemberCount" = COALESCE((
             SELECT COUNT(*)::int FROM "ContextMembers" cm WHERE cm."contextId" = c.id
           ), 0),
           "lastCalculatedAt"  = now() AT TIME ZONE 'utc'
     WHERE c.id = ANY($1::uuid[])
  `, [contextIds]);

  await runner.query(`
    WITH RECURSIVE subtree AS (
      SELECT id AS root_id, id AS node_id
        FROM "Contexts"
       WHERE id = ANY($1::uuid[])
      UNION
      SELECT s.root_id, c.id
        FROM "Contexts" c
        JOIN subtree s ON c."parentContextId" = s.node_id
    ),
    totals AS (
      SELECT s.root_id, COUNT(DISTINCT cm."memberId")::int AS cnt
        FROM subtree s
        LEFT JOIN "ContextMembers" cm ON cm."contextId" = s.node_id
       GROUP BY s.root_id
    )
    UPDATE "Contexts" c
       SET "totalMemberCount" = t.cnt
      FROM totals t
     WHERE c.id = t.root_id
  `, [contextIds]);
}
