-- Identity Atlas — access changes as something you can ask a question about.
--
-- The audit trail already records every membership change: `_history` (009)
-- holds one row per change with the before and after payload. What it does not
-- have is a SHAPE anything can query. It is keyed by table name and row id,
-- the interesting values live inside jsonb, and — the part that catches people
-- — "removed" is not an operation you can look for.
--
-- WHY A REMOVAL IS AN UPDATE. `ResourceAssignments` is a soft-delete table
-- (ingest/engine.js, SOFT_DELETE_TABLES): removing a membership stamps
-- `deletedAt` and keeps the row, so the trigger writes 'U'. A reader looking
-- for 'D' finds only the hard deletes, which on this data stopped the day soft
-- delete shipped. This view is where that rule is written down once, instead of
-- in every caller that ever wants to know what changed.
--
-- WHAT IT IS FOR. The report catalog's `change` entity (nlreports/catalog.js)
-- reads this, which is what makes "zijn er recent leden aan deze groepen
-- toegevoegd of verwijderd?" a question the report generator can express. The
-- catalog needs an ordinary table with `id` and `displayName`, so those are
-- projected here rather than assembled per query.
--
-- NOT A TABLE. Nothing is copied: the view is a projection of `_history`, so it
-- inherits that table's retention and cannot drift from it.

-- Assignment history is ~12% of `_history` on a real tenant, so every index
-- here is partial. On the deployment this was written against that is ~25k rows
-- of 222k, which builds in well under a second — worth knowing, because a
-- migration that takes minutes crash-loops the container on startup.
CREATE INDEX IF NOT EXISTS "ix_history_assignment_changedAt"
  ON "_history" ("changedAt" DESC) WHERE "tableName" = 'ResourceAssignments';

CREATE INDEX IF NOT EXISTS "ix_history_assignment_resource"
  ON "_history" (("rowData"->>'resourceId')) WHERE "tableName" = 'ResourceAssignments';

CREATE INDEX IF NOT EXISTS "ix_history_assignment_principal"
  ON "_history" (("rowData"->>'principalId')) WHERE "tableName" = 'ResourceAssignments';

CREATE OR REPLACE VIEW "AssignmentChanges" AS
SELECT
    h."id",
    h."changedAt",

    -- Added or Removed, from the two ways each can be recorded. An insert and
    -- a CLEARED deletedAt are both additions: re-ingesting a membership that
    -- came back clears the stamp rather than inserting a second row.
    CASE
      WHEN h."operation" = 'I' THEN 'Added'
      WHEN h."operation" = 'D' THEN 'Removed'
      WHEN (h."prevData"->>'deletedAt') IS NULL
       AND (h."rowData"->>'deletedAt') IS NOT NULL THEN 'Removed'
      ELSE 'Added'
    END AS "action",

    h."rowData"->>'assignmentType' AS "assignmentType",
    (h."rowData"->>'resourceId')::uuid  AS "resourceId",
    (h."rowData"->>'principalId')::uuid AS "principalId",

    -- The account's manager, carried as a column rather than reached through a
    -- second relation. A report condition may nest a relation one level deep,
    -- so "changes to the access of the people who report to me" has to be
    -- expressible without walking change → account → manager.
    p."managerId",

    -- The catalog orders and aggregates on displayName, so a change needs one.
    -- Reads as "Jan de Vries — Finance".
    COALESCE(p."displayName", '(unknown account)')
      || ' — ' || COALESCE(r."displayName", '(unknown resource)') AS "displayName"

  FROM "_history" h
  LEFT JOIN "Principals" p ON p."id" = (h."rowData"->>'principalId')::uuid
  LEFT JOIN "Resources"  r ON r."id" = (h."rowData"->>'resourceId')::uuid
 WHERE h."tableName" = 'ResourceAssignments'
   AND (
        h."operation" IN ('I', 'D')
        -- An update is a change only when it crossed the deleted line. Updates
        -- that touched some other column outnumber real removals 60:1 in this
        -- data (7617 against 127), so admitting them would bury the ones that
        -- matter under backfills and renames.
     OR ((h."prevData"->>'deletedAt') IS NULL) <> ((h."rowData"->>'deletedAt') IS NULL)
   );

COMMENT ON VIEW "AssignmentChanges" IS
  'Membership and access grants added or removed over time, projected from _history. '
  'Soft-deleted rows (deletedAt stamped by an UPDATE) count as removals; '
  'updates that changed anything else are not changes. Read by the report catalog''s "change" entity.';
