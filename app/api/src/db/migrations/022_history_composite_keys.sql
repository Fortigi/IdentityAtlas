-- Identity Atlas v5 — relationship history
--
-- Migration 009 wired the _history audit trigger onto ResourceAssignments,
-- ResourceRelationships, AssignmentPolicies, etc. But the trigger function
-- (`fg_record_history`) keys every history row by `rowData->>'id'` — and
-- the composite-PK tables (ResourceAssignments, ResourceRelationships,
-- IdentityMembers) have no `id` column, so those inserts/deletes never
-- ended up in `_history`. Assignments could move around and the audit
-- log was completely silent.
--
-- This migration:
--   1. Upgrades `fg_record_history` so when `id` is missing it synthesises
--      a composite key string from the known PKs of these three tables.
--      Existing id-keyed tables (Principals, Resources, …) are unchanged.
--   2. Adds `IdentityMembers` to the set of history-tracked tables.
--
-- Existing assignment rows aren't back-filled — history only captures
-- changes from this point forward. That's fine for the "recent changes"
-- feature: the timeline starts empty and fills as crawlers run.

CREATE OR REPLACE FUNCTION fg_record_history() RETURNS trigger AS $$
DECLARE
  v_new_data jsonb;
  v_old_data jsonb;
  v_key_src  jsonb;
  v_id       text;
  v_op       char(1);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
    v_key_src  := v_old_data;
    v_op := 'D';
  ELSIF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW);
    v_old_data := NULL;
    v_key_src  := v_new_data;
    v_op := 'I';
  ELSE -- UPDATE
    v_new_data := to_jsonb(NEW);
    v_old_data := to_jsonb(OLD);
    IF v_old_data = v_new_data THEN
      RETURN NEW;
    END IF;
    v_key_src := v_new_data;
    v_op := 'U';
  END IF;

  -- Prefer a surrogate id when the table has one.
  v_id := COALESCE(v_key_src->>'id', v_key_src->>'Id');

  -- Composite-PK fallbacks. Build a stable `a|b|c` key so a single
  -- assignment's history can be queried back by rowId.
  IF v_id IS NULL THEN
    IF TG_TABLE_NAME = 'ResourceAssignments' THEN
      v_id := COALESCE(v_key_src->>'resourceId','')   || '|' ||
              COALESCE(v_key_src->>'principalId','')  || '|' ||
              COALESCE(v_key_src->>'assignmentType','');
    ELSIF TG_TABLE_NAME = 'ResourceRelationships' THEN
      v_id := COALESCE(v_key_src->>'parentResourceId','') || '|' ||
              COALESCE(v_key_src->>'childResourceId','')  || '|' ||
              COALESCE(v_key_src->>'relationshipType','');
    ELSIF TG_TABLE_NAME = 'IdentityMembers' THEN
      v_id := COALESCE(v_key_src->>'identityId','')  || '|' ||
              COALESCE(v_key_src->>'principalId','');
    END IF;
  END IF;

  IF v_id IS NULL OR v_id = '||' OR v_id = '|' THEN
    -- Still nothing to key by — skip rather than fail the parent statement.
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO "_history" ("tableName","rowId","operation","rowData","prevData")
  VALUES (TG_TABLE_NAME, v_id, v_op, COALESCE(v_new_data, v_old_data), v_old_data);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Re-attach triggers on the originally-tracked tables + IdentityMembers.
-- Idempotent — CREATE TRIGGER after DROP IF EXISTS.
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
      CREATE TRIGGER trg_history_ins_del
      AFTER INSERT OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION fg_record_history();
    $f$, t, t);

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
