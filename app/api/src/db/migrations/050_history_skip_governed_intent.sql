-- 050: Don't audit governed-intent ResourceAssignments rows.
--
-- Governed-intent rows (governed=true) are derived data — regenerated from
-- governance memberships + Contains on every governance sync (see
-- /ingest/classify-business-role-assignments). Auditing them would churn tens
-- of thousands of _history rows per crawl with no analytical value (the facts
-- they derive from — the membership and the Contains edge — are themselves
-- audited). This redefines fg_record_history to skip them; the existing
-- triggers already point at this function, so no re-attach is needed.

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

  -- Governed-intent rows are derived/regenerated; skip auditing them.
  IF TG_TABLE_NAME = 'ResourceAssignments'
     AND COALESCE((v_key_src->>'governed')::boolean, false) THEN
    RETURN COALESCE(NEW, OLD);
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
