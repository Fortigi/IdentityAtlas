-- Analyst overrides of who a principal reports to, for the Manager-Hierarchy
-- context tree.
--
-- The manager-hierarchy plugin places each principal as a direct member of their
-- manager's node, derived from Principals.managerId. An analyst can drag a member
-- onto a different team in the tree to say "this person now reports to that
-- manager". That intent is recorded here as an override of the principal's
-- effective manager, so it survives every plugin re-run (the plugin reads this
-- table and uses the override instead of the source managerId).
--
--   principalId          — the person being moved.
--   managerPrincipalId   — their new effective manager (a Principal id, which is
--                          the manager node's externalId). NULL = report to the
--                          root (no manager).
--
-- One override per principal. Dropping the person back on their source manager
-- removes the row (handled by the API).

CREATE TABLE IF NOT EXISTS "ManagerHierarchyOverrides" (
  "principalId"        uuid PRIMARY KEY REFERENCES "Principals"("id") ON DELETE CASCADE,
  "managerPrincipalId" uuid,
  "setBy"              text,
  "setAt"              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
