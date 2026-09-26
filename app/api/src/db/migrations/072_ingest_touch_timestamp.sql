-- Migration 072 — "when was this row last ingested?" for the entity tables,
-- and an audit trail that does not mistake that bookkeeping for a change.
--
-- WHY
-- A crawler whose source is too large to hold in memory or in one sync session
-- (the SQL crawler's entitlement-assignment tables run to tens of millions of
-- rows) cannot reconcile a full sync by set difference: that needs every key of
-- the run inside one 30-minute session on one pinned connection. It instead
-- upserts independent chunks and then asks the API to remove the rows it did
-- NOT touch — which requires the rows to record when they were last touched.
--
-- No entity table carried that fact. `updatedAt` existed only on config-ish
-- tables (WorkerConfig, Contexts, PrincipalActivity, SavedReports …), which is
-- why ingest/engine.js's updatedAtStamp() — written to stamp exactly this —
-- had no effect on Principals, Resources, ResourceAssignments or
-- ResourceRelationships. POST /ingest/reconcile refuses a table without the
-- column, so the reconcile simply could not run.
--
-- WHAT
--   1. Adds "updatedAt" to the five system-scoped entity tables. The default
--      backfills existing rows with the migration's own timestamp rather than
--      NULL, so the very first reconcile after this lands has a real cutoff to
--      compare against and cannot mistake "never stamped" for "gone from the
--      source". ADD COLUMN with a non-volatile default is a metadata-only
--      change in PostgreSQL 11+ — no table rewrite, so this stays fast on a
--      table with tens of millions of rows.
--
--   2. Rebuilds the history UPDATE trigger so a row whose ONLY difference is
--      "updatedAt" is not recorded as a change.
--
--      This second part is not optional. The trigger fires
--      `WHEN (OLD IS DISTINCT FROM NEW)`, and migration 009 added that clause
--      precisely so re-ingesting unchanged data records nothing. Stamping a
--      fresh timestamp on every upsert makes that condition true for every row
--      of every sync: one "_history" row per entity per run (millions), and a
--      fake "changed" event on every entity Timeline — the same class of
--      regression the directory-ownership work had to undo once already.
--      Comparing the rows minus this one key keeps the audit trail meaning
--      "something a user would recognise as a change".
--
-- The tracked-table list mirrors migration 022's; a table that does not exist
-- yet is skipped, as there.

-- ─── 1. The last-ingested stamp ─────────────────────────────────────────────
ALTER TABLE "Principals"             ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now();
ALTER TABLE "Resources"              ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now();
ALTER TABLE "ResourceAssignments"    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now();
ALTER TABLE "ResourceRelationships"  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public."PrincipalRelationships"') IS NOT NULL THEN
    ALTER TABLE "PrincipalRelationships" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;

-- A reconcile scans "rows of this system + scope not touched since T", so the
-- stamp is only ever read alongside the system id. Partial to keep it small:
-- a tombstoned row is never a reconcile candidate.
CREATE INDEX IF NOT EXISTS "ix_Principals_system_updatedAt"
  ON "Principals" ("systemId", "updatedAt") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_Resources_system_updatedAt"
  ON "Resources" ("systemId", "updatedAt") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_RA_system_updatedAt"
  ON "ResourceAssignments" ("systemId", "updatedAt") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_RR_system_updatedAt"
  ON "ResourceRelationships" ("systemId", "updatedAt");

-- ─── 2. History ignores the bookkeeping stamp ───────────────────────────────
DO $$
DECLARE
  t text;
  tracked text[] := ARRAY[
    'Principals',
    'Resources',
    'ResourceAssignments',
    'ResourceRelationships',
    'IdentityMembers'
  ];
BEGIN
  FOREACH t IN ARRAY tracked LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;

    -- `to_jsonb(row) - 'updatedAt'` drops the key when present and is a no-op
    -- on a table that has no such column, so one condition serves every
    -- tracked table. INSERT/DELETE tracking is untouched.
    EXECUTE format($f$
      DROP TRIGGER IF EXISTS trg_history_upd ON %I;
      CREATE TRIGGER trg_history_upd
      AFTER UPDATE ON %I
      FOR EACH ROW
      WHEN ((to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt'))
      EXECUTE FUNCTION fg_record_history();
    $f$, t, t);
  END LOOP;
END $$;
