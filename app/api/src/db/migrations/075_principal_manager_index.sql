-- Migration 075 — index "Principals"."managerId".
--
-- WHY
-- `managerId` is a self-reference on "Principals" with no index, so every
-- question of the form "who reports to this person" was answered by a full
-- table scan. That is one scan per probe, and two hot paths probe it a lot:
--
--   * The Users-page filter bar discovers whether the "Direct reports" filter
--     has any data at all. The probe used to be an aggregate the planner could
--     not flatten (see lib/referenceFilters.js), so it ran a full scan PER
--     principal until it found a manager — 8.1 s on a 176 k-principal tenant,
--     on every load of the filter bar, and effectively unbounded when nobody
--     in the directory has reports. That probe is now a semi-join, which needs
--     this index to be a lookup rather than a hash of the whole table.
--   * `rel.directReports` as an actual filter (`= 'None (0)'`, `'2 or more'`)
--     still runs the correlated count once per candidate row. Without the
--     index that filter is quadratic.
--
-- The manager hierarchy context plugin and the org-chart derivation walk the
-- same column and get the same benefit.
--
-- WHAT
-- A partial index: rows with no manager are the ones nobody looks up by
-- manager, and skipping them keeps the index small on a directory where most
-- accounts (service principals, managed identities) have none.
--
-- NOT CONCURRENTLY: the migration runner wraps each file in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. The build takes ~0.3 s on
-- 176 k rows, measured, so the exclusive lock is short.

CREATE INDEX IF NOT EXISTS "ix_Principals_managerId"
    ON "Principals" ("managerId")
 WHERE "managerId" IS NOT NULL;
