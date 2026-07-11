// Guards against cyclic parentContextId chains in the Contexts tree.
//
// The Contexts self-FK (`Contexts_parentContextId_fkey`) is not deferrable and
// only rejects a self-loop (A → A), never a multi-hop cycle (A → B → A). Read
// queries defend against cycles at query time with SQL `CYCLE` clauses, but the
// three write paths — the UI reparent (PATCH /contexts/:id), the ingest upsert,
// and the plugin runner — could still PERSIST a cycle. These helpers close that
// gap at the source.
//
// `db` is anything exposing `query(text, params) -> { rows }` — the shared pool
// or a transaction client both work.

// Would setting `childId`'s parent to `proposedParentId` create a cycle? That
// happens exactly when `childId` is already an ancestor of `proposedParentId`
// (or they are the same node). Walks up from the proposed parent with a single
// recursive query; the `CYCLE` clause keeps it terminating even if the existing
// tree is already corrupt. Replaces the old fragile fixed-50-hop JS loop, which
// silently gave up (reported "no cycle") on trees deeper than 50.
export async function wouldCreateCycle(db, childId, proposedParentId) {
  if (!proposedParentId) return false;
  if (childId === proposedParentId) return true;
  const { rows } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, "parentContextId"
         FROM "Contexts" WHERE id = $1
       UNION ALL
       SELECT c.id, c."parentContextId"
         FROM "Contexts" c
         JOIN ancestors a ON c.id = a."parentContextId"
     ) CYCLE id SET is_cycle USING path
     SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
    [proposedParentId, childId],
  );
  return rows.length > 0;
}

// Repair stored state: NULL the parentContextId of any node that sits on a
// cycle, so the tree is acyclic again. Returns the number of rows fixed. Safe to
// run after any write batch — it never throws on a cycle, it repairs one (and a
// clean tree is a no-op). Call it after ingest / plugin writes and BEFORE any
// recursive member-count roll-up, which would otherwise recurse on the cycle.
export async function breakCycles(db) {
  const { rows } = await db.query(
    `WITH RECURSIVE walk AS (
       SELECT id, "parentContextId" AS cur, ARRAY[id] AS path
         FROM "Contexts" WHERE "parentContextId" IS NOT NULL
       UNION ALL
       SELECT w.id, c."parentContextId", w.path || c.id
         FROM walk w
         JOIN "Contexts" c ON c.id = w.cur
        WHERE c.id <> ALL(w.path)            -- stop the step that would revisit
     )
     UPDATE "Contexts" t
        SET "parentContextId" = NULL
      WHERE t.id IN (
        -- a node is on a cycle iff its own parent is reachable back to itself:
        -- the walk from t reaches a node whose parent is t again.
        SELECT w.id FROM walk w
         JOIN "Contexts" c ON c.id = w.cur
        WHERE c."parentContextId" = w.id
      )
      RETURNING t.id`,
  );
  return rows.length;
}
