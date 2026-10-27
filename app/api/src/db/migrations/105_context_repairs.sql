-- Identity Atlas — context roles and relationships: a repair, and the owner marker
--
-- Two things, both safe to run on any database and a no-op where there is
-- nothing to do.
--
-- 1. The owner a source names gets its own addedBy.
--    The contexts ingest states a synced context's ownerUserId as its
--    Accountable (ingest/contextOwners.js) and drops that Accountable again when
--    the owner goes. It wrote those rows as addedBy 'sync' — the same value a
--    crawler gets when it names an Accountable directly (POST
--    /ingest/context-roles) — so on a context without an ownerUserId the next
--    contexts sync deleted the crawler's Accountable. The reconcile now writes,
--    replaces and removes only 'sourceOwner' rows. This widens the three addedBy
--    CHECKs (one value scheme, ia:MembershipSource, covers all three tables) and
--    relabels the rows the reconcile wrote before: a 'sync' Accountable on a
--    synced context that has an ownerUserId. On such a context the source's
--    owner field is what the Accountable answers to, so the reconcile is the
--    right keeper even if a crawler also posted the same row. A 'sync'
--    Accountable on a context without an owner stays 'sync' — exactly the rows
--    the old reconcile would have deleted.
--    The CHECKs are re-added NOT VALID: every existing row already satisfies the
--    wider list, and ContextMembers can be large; nothing needs scanning.
--
-- 2. Databases that ran the first version of 092 (now 094) before 2026-10-20.
--    That version stored relationshipType 'DedicatedTo', one way round, unique
--    per ordered triple, and had no _history triggers on ContextRoles and
--    ContextRelationships. 094 as it stands has 'SameUnitAs', unique per
--    unordered pair, and the triggers; renames.json keeps such a database from
--    running 094 again, so this brings it level. On a correct database every
--    step finds nothing to convert and recreates what is already there.
--
-- Nothing here touches Contexts, so the deferred cycle check (059) queues
-- nothing; SET CONSTRAINTS below is belt and braces before the index DDL.

-- ─── 1. addedBy 'sourceOwner' ────────────────────────────────────────────────
ALTER TABLE "ContextMembers"       DROP CONSTRAINT IF EXISTS "ContextMembers_addedBy_check";
ALTER TABLE "ContextMembers"       ADD CONSTRAINT "ContextMembers_addedBy_check"
  CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst', 'sourceOwner')) NOT VALID;
ALTER TABLE "ContextRoles"         DROP CONSTRAINT IF EXISTS "ContextRoles_addedBy_check";
ALTER TABLE "ContextRoles"         ADD CONSTRAINT "ContextRoles_addedBy_check"
  CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst', 'sourceOwner')) NOT VALID;
ALTER TABLE "ContextRelationships" DROP CONSTRAINT IF EXISTS "ContextRelationships_addedBy_check";
ALTER TABLE "ContextRelationships" ADD CONSTRAINT "ContextRelationships_addedBy_check"
  CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst', 'sourceOwner')) NOT VALID;

UPDATE "ContextRoles" r
   SET "addedBy" = 'sourceOwner'
  FROM "Contexts" c
 WHERE c.id = r."contextId"
   AND r.role = 'Accountable'
   AND r."addedBy" = 'sync'
   AND c.variant = 'synced'
   AND NULLIF(c."ownerUserId", '') IS NOT NULL;

-- ─── 2. DedicatedTo → SameUnitAs ─────────────────────────────────────────────
ALTER TABLE "ContextRelationships" DROP CONSTRAINT IF EXISTS "ContextRelationships_relationshipType_check";

UPDATE "ContextRelationships" SET "relationshipType" = 'SameUnitAs' WHERE "relationshipType" = 'DedicatedTo';

-- A pair stored both ways round under the old triple key: keep the older row.
DELETE FROM "ContextRelationships" r
 USING "ContextRelationships" o
 WHERE r."relationshipType" = o."relationshipType"
   AND LEAST(r."contextId", r."relatedContextId")    = LEAST(o."contextId", o."relatedContextId")
   AND GREATEST(r."contextId", r."relatedContextId") = GREATEST(o."contextId", o."relatedContextId")
   AND (r."createdAt", r.id) > (o."createdAt", o.id);

ALTER TABLE "ContextRelationships" ADD CONSTRAINT "ContextRelationships_relationshipType_check"
  CHECK ("relationshipType" IN ('SameUnitAs'));
ALTER TABLE "ContextRelationships" DROP CONSTRAINT IF EXISTS "ux_ContextRelationships_triple";

SET CONSTRAINTS ALL IMMEDIATE;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_ContextRelationships_pair" ON "ContextRelationships"
  (LEAST("contextId", "relatedContextId"), GREATEST("contextId", "relatedContextId"), "relationshipType");

-- ─── 3. The _history triggers ────────────────────────────────────────────────
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextRoles";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextRoles"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ContextRoles";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ContextRoles"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextRelationships";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextRelationships"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();
END $$;
