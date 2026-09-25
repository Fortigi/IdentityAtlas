-- Identity Atlas demo data — give the access history a past.
--
-- WHAT PROBLEM THIS SOLVES. Every membership in a freshly ingested demo
-- environment was created in the same second, so `_history` says the whole
-- company got all of its access today and nobody ever lost any. Questions about
-- change — "which groups was Jeroen added to in the last 90 days", "is anybody
-- still being removed from the finance groups", "what changed since the last
-- review" — are among the first an analyst asks, and on that data they are all
-- answerable only as "everything" or "nothing". The report catalog's `change`
-- entity reads the `AssignmentChanges` view over `_history` (migration
-- 070_assignment_changes_view.sql), so a believable past means giving those
-- history rows believable timestamps, plus some removals to find.
--
-- FOR DEV / TEST ONLY. It rewrites audit timestamps and soft-deletes a slice of
-- memberships. Never point it at a customer environment.
--
-- Run it AFTER the demo data has been ingested (the realism slice makes it worth
-- running; it works on the standard slice too, with less to show):
--
--   docker compose exec -T postgres psql -U identity_atlas -d identity_atlas \
--     -f /path/to/Simulate-AccessChanges.sql
--
-- It is written to be safe to run twice: the removal step is skipped once enough
-- removals exist, and the back-dating steps are idempotent in effect.
--
-- The story it creates:
--   * Access was granted over the last half year, not all at once — spread over
--     20 to 180 days, so both "in the last 30 days" and "in the last 90 days"
--     have answers of different sizes.
--   * About one membership in sixteen on a project, application or distribution
--     group was taken away again, a few days to six weeks after it was granted.
--   * A handful of those came back: removed, then granted again — which is the
--     case the view exists to get right, because a returning membership clears
--     `deletedAt` instead of inserting a second row.

BEGIN;

-- ── 1. Grants happened over the last half year ───────────────────────────────
-- Deterministic: the same row always lands on the same day, because the offset
-- is a hash of the row's own key rather than a random number.
UPDATE "_history" h
   SET "changedAt" = now() - (((abs(hashtext(h."rowId")) % 161) + 20) || ' days')::interval
 WHERE h."tableName" = 'ResourceAssignments'
   AND h."operation" = 'I';

-- ── 2. Some access was taken away again ──────────────────────────────────────
-- Soft delete, which is how the application removes a membership: the row stays
-- and `deletedAt` is stamped, and the audit trigger records that as an UPDATE.
-- Project, application and distribution-list memberships only — nobody removes
-- people from "all staff", and licence groups are driven by other automation.
DO $$
DECLARE
  v_existing int;
BEGIN
  SELECT count(*) INTO v_existing
    FROM "_history"
   WHERE "tableName" = 'ResourceAssignments'
     AND "operation" = 'U'
     AND ("prevData"->>'deletedAt') IS NULL
     AND ("rowData"->>'deletedAt') IS NOT NULL;

  IF v_existing >= 50 THEN
    RAISE NOTICE 'Simulate-AccessChanges: % removals already present, skipping the removal step', v_existing;
    RETURN;
  END IF;

  UPDATE "ResourceAssignments" ra
     SET "deletedAt" = now()
    FROM "Resources" r
   WHERE r."id" = ra."resourceId"
     AND ra."deletedAt" IS NULL
     AND ra."assignmentType" = 'Direct'
     AND (r."displayName" LIKE 'PRJ-%' OR r."displayName" LIKE 'APP-%' OR r."displayName" LIKE 'DL-%')
     AND (abs(hashtext(ra."resourceId"::text || ra."principalId"::text)) % 16) = 0;
END $$;

-- ── 3. A removal happened after the grant it undoes ──────────────────────────
-- Joined back to the row's own insert event (the trigger keys assignment history
-- as "resourceId|principalId|assignmentType", so a membership's events can be
-- tied together), three to forty-five days later, and never in the future.
UPDATE "_history" h
   SET "changedAt" = LEAST(
         now() - interval '1 day',
         ins."changedAt" + (((abs(hashtext(h."rowId" || 'rm')) % 43) + 3) || ' days')::interval)
  FROM (SELECT "rowId", min("changedAt") AS "changedAt"
          FROM "_history"
         WHERE "tableName" = 'ResourceAssignments' AND "operation" = 'I'
         GROUP BY "rowId") ins
 WHERE h."tableName" = 'ResourceAssignments'
   AND h."operation" = 'U'
   AND h."rowId" = ins."rowId"
   AND ("prevData"->>'deletedAt') IS NULL
   AND ("rowData"->>'deletedAt') IS NOT NULL;

-- ── 4. A few came back ───────────────────────────────────────────────────────
-- One in six of the removed memberships is restored: `deletedAt` is cleared,
-- which the view reads as an addition. This is the shape that made the view
-- necessary — a membership that returns does not insert a second row.
UPDATE "ResourceAssignments" ra
   SET "deletedAt" = NULL
 WHERE ra."deletedAt" IS NOT NULL
   AND (abs(hashtext(ra."resourceId"::text || ra."principalId"::text || 'back')) % 6) = 0;

-- The restore's own history row is the most recent thing that happened to it.
UPDATE "_history" h
   SET "changedAt" = now() - (((abs(hashtext(h."rowId" || 'back')) % 14) + 1) || ' days')::interval
 WHERE h."tableName" = 'ResourceAssignments'
   AND h."operation" = 'U'
   AND ("prevData"->>'deletedAt') IS NOT NULL
   AND ("rowData"->>'deletedAt') IS NULL;

COMMIT;

-- What the result looks like, for whoever ran it.
SELECT "action",
       count(*)                                        AS events,
       count(*) FILTER (WHERE "changedAt" > now() - interval '30 days')  AS last_30_days,
       count(*) FILTER (WHERE "changedAt" > now() - interval '90 days')  AS last_90_days,
       min("changedAt")::date                          AS oldest,
       max("changedAt")::date                          AS newest
  FROM "AssignmentChanges"
 GROUP BY "action"
 ORDER BY "action";
