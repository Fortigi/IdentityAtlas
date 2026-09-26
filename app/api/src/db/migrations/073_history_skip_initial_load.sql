-- Migration 073 — no per-row audit history for a system's initial load.
--
-- WHY
-- The audit trigger writes a JSON snapshot of every inserted row to "_history".
-- For a system's FIRST load that is not an audit trail of changes, it is a second
-- copy of the data: at 41M assignments it was 25.7 GB of a 34.9 GB database —
-- about 1 KB of history per ~340-byte assignment — and in a controlled insert of
-- 4.1M rows it cost more time (+188 s) than all 13 ResourceAssignments indexes
-- together (111 s). See docs/architecture/scale-rehearsal.md. Nobody needs a
-- per-row "created" event for rows that arrived because the system was loaded for
-- the first time; the load itself is the event.
--
-- WHAT
-- The combined AFTER INSERT OR DELETE trigger of each ingested entity table is
-- split in two:
--   trg_history_ins  AFTER INSERT, skipped while the transaction-local setting
--                    identity_atlas.initial_load is 'on';
--   trg_history_del  AFTER DELETE, unconditional.
-- UPDATE tracking (trg_history_upd, migration 072) is untouched.
--
-- The setting is only ever set by the ingest engine, with SET LOCAL, inside the
-- transaction of a batch for a system that has never completed a sync
-- (Systems."lastSyncDateTime" IS NULL — see app/api/src/ingest/initialLoad.js).
-- Everything else — analyst edits, later syncs, any direct INSERT — leaves it
-- unset and is recorded exactly as before. Checking it in the trigger's WHEN
-- clause means a skipped row costs no PL/pgSQL call at all.
--
-- The tracked-table list mirrors migration 022's; a table that does not exist
-- yet is skipped, as there.

DO $$
DECLARE
  t text;
  tracked text[] := ARRAY[
    'Principals',
    'Resources',
    'ResourceAssignments',
    'ResourceRelationships',
    'AssignmentPolicies',
    'GovernanceCatalogs',
    'Systems',
    'IdentityMembers'
  ];
BEGIN
  FOREACH t IN ARRAY tracked LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format($f$
      DROP TRIGGER IF EXISTS trg_history_ins_del ON %I;
      DROP TRIGGER IF EXISTS trg_history_ins ON %I;
      DROP TRIGGER IF EXISTS trg_history_del ON %I;

      CREATE TRIGGER trg_history_ins
      AFTER INSERT ON %I
      FOR EACH ROW
      WHEN (current_setting('identity_atlas.initial_load', true) IS DISTINCT FROM 'on')
      EXECUTE FUNCTION fg_record_history();

      CREATE TRIGGER trg_history_del
      AFTER DELETE ON %I
      FOR EACH ROW
      EXECUTE FUNCTION fg_record_history();
    $f$, t, t, t, t, t);
  END LOOP;
END $$;
