-- Identity Atlas v5 — version history (replacement for v4 SQL Server temporal tables).
--
-- v4 used SQL Server temporal tables on every interesting table (Principals, Resources,
-- ResourceAssignments, AssignmentPolicies, ...). The detail pages used
-- "FOR SYSTEM_TIME ALL" to show diffs between sync runs.
--
-- Postgres has no equivalent built-in. We get the same behaviour with one
-- shared `_history` audit table populated by an AFTER trigger that snapshots
-- the row as jsonb. Storing snapshots (rather than diffs) keeps the trigger
-- function generic — one function works for every tracked table regardless
-- of column shape, so adding history to a new table is one CREATE TRIGGER.
--
-- Performance notes:
--   * The trigger has a WHEN (OLD IS DISTINCT FROM NEW) clause so re-ingesting
--     unchanged rows is a no-op — important because the crawler upserts every
--     row on every sync.
--   * Index on ("tableName","rowId","changedAt" DESC) supports the detail-page
--     query: "give me the history of this single entity, newest first".
--   * Storage cost: jsonb snapshots are denormalised. For high-churn tables
--     this can grow fast. Retention is intentionally NOT enforced here —
--     add a periodic VACUUM/DELETE job once we see real-world growth.

CREATE TABLE IF NOT EXISTS "_history" (
  id           bigserial PRIMARY KEY,
  "tableName"  text NOT NULL,
  "rowId"      text NOT NULL,
  operation    char(1) NOT NULL CHECK (operation IN ('I','U','D')),
  "changedAt"  timestamptz NOT NULL DEFAULT now(),
  "rowData"    jsonb NOT NULL,
  "prevData"   jsonb
);

CREATE INDEX IF NOT EXISTS "ix_history_table_row_changed"
  ON "_history" ("tableName", "rowId", "changedAt" DESC);

CREATE INDEX IF NOT EXISTS "ix_history_changedAt"
  ON "_history" ("changedAt" DESC);

-- Generic history-recording trigger function. Writes one row per actual change.
-- Skips UPDATE noise via the WHEN clause on the trigger itself, but we still
-- guard inside the function in case a caller attaches it without WHEN.
CREATE OR REPLACE FUNCTION fg_record_history() RETURNS trigger AS $$
DECLARE
  v_new_data jsonb;
  v_old_data jsonb;
  v_id       text;
  v_op       char(1);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
    v_id := COALESCE(v_old_data->>'id', v_old_data->>'Id');
    v_op := 'D';
  ELSIF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW);
    v_old_data := NULL;
    v_id := COALESCE(v_new_data->>'id', v_new_data->>'Id');
    v_op := 'I';
  ELSE -- UPDATE
    v_new_data := to_jsonb(NEW);
    v_old_data := to_jsonb(OLD);
    -- Defensive — also caught by the trigger WHEN clause
    IF v_old_data = v_new_data THEN
      RETURN NEW;
    END IF;
    v_id := COALESCE(v_new_data->>'id', v_new_data->>'Id');
    v_op := 'U';
  END IF;

  IF v_id IS NULL THEN
    -- No id column to key by — skip silently rather than fail the parent statement
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO "_history" ("tableName","rowId","operation","rowData","prevData")
  VALUES (TG_TABLE_NAME, v_id, v_op, COALESCE(v_new_data, v_old_data), v_old_data);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Attach the trigger to tracked tables. The WHEN clause on UPDATE filters out
-- no-op writes so unchanged rows during a re-sync don't bloat the audit log.
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
    'Systems'
  ];
BEGIN
  FOREACH t IN ARRAY tracked LOOP
    -- Skip silently if a table doesn't exist yet (e.g. risk-scoring tables in some envs)
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;

    -- INSERT/DELETE: always record
    EXECUTE format($f$
      DROP TRIGGER IF EXISTS trg_history_ins_del ON %I;
      CREATE TRIGGER trg_history_ins_del
      AFTER INSERT OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION fg_record_history();
    $f$, t, t);

    -- UPDATE: only when something actually changed
    EXECUTE format($f$
      DROP TRIGGER IF EXISTS trg_history_upd ON %I;
      CREATE TRIGGER trg_history_upd
      AFTER UPDATE ON %I
      FOR EACH ROW
      WHEN (OLD IS DISTINCT FROM NEW)
      EXECUTE FUNCTION fg_record_history();
    $f$, t, t);
  END LOOP;
END $$;
