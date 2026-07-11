-- Drop the redundant "Owner @ " prefix from GroupOwnership resource displayNames.
--
-- The resourceType ('GroupOwnership') already conveys that the resource represents
-- ownership, so the "Owner @ " prefix restated it. The resource is now simply named
-- after the group it belongs to (e.g. "Sales" instead of "Owner @ Sales"), matching
-- the convention the upcoming AppOwnership type will follow.
--
-- The crawler now emits the bare group name and refreshes these on every sync
-- (upsert on the deterministic ownership id), so this only backfills existing rows.
-- Guarded + idempotent: a second run finds no 'Owner @ %' rows left to change.

UPDATE "Resources"
   SET "displayName" = regexp_replace("displayName", '^Owner @ ', '')
 WHERE "resourceType" = 'GroupOwnership'
   AND "displayName" LIKE 'Owner @ %';
