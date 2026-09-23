-- Profile photo on Principals.
--
-- Entra (and any other source that has one) can supply a small profile photo
-- per account. It lives in a column on "Principals" rather than its own table
-- because it is a plain per-principal attribute and rides the existing
-- ingest/principals upsert — no new endpoint, no join.
--
-- Why a column is safe here: Postgres moves a bytea over ~2KB into TOAST
-- storage, out of line with the heap row. Queries that don't name the column
-- never read those bytes, so list/matrix queries are unaffected. Only a
-- caller that explicitly selects "photo" pays for it.
--
--   "photo"            raw image bytes, NULL when the account has none
--   "photoContentType" MIME type as returned by the source (image/jpeg)
--   "photoFetchedAt"   when we last asked the source
--
-- The pair (photo NULL + photoFetchedAt set) is meaningful: it records
-- "we asked, this account has no photo", so the crawler can skip re-asking
-- every run. (photo NULL + photoFetchedAt NULL) means we never looked.

ALTER TABLE "Principals" ADD COLUMN IF NOT EXISTS "photo"            BYTEA;
ALTER TABLE "Principals" ADD COLUMN IF NOT EXISTS "photoContentType" TEXT;
ALTER TABLE "Principals" ADD COLUMN IF NOT EXISTS "photoFetchedAt"   TIMESTAMPTZ;

-- ─── Keep photo bytes out of the audit history ───────────────────────────
--
-- "Principals" is in the fg_record_history() tracked set. That trigger stores
-- to_jsonb(NEW) — and to_jsonb() renders a bytea as a hex string, two
-- characters per byte. Worse, an UPDATE stores both rowData AND prevData, so
-- every unrelated change to a user (a job title, a department, a disabled
-- account) would write the photo to "_history" twice. On a tenant of any size
-- that dominates the audit log with data nobody ever reviews, and history is
-- never pruned.
--
-- So strip the blob before recording. `jsonb - 'photo'` removes the key, and
-- is a no-op on the tracked tables that have no such column. The audit value
-- is kept through "photoFetchedAt", which stays in the record: you can still
-- see WHEN a photo changed, just not the pixels.
--
-- THIS BODY IS 022_history_composite_keys.sql's, NOT 009_history.sql's.
-- Read that before touching it again. 009 keyed every history row by
-- rowData->>'id'; 022 replaced the function because the composite-PK tables
-- (ResourceAssignments, ResourceRelationships, IdentityMembers) have no id
-- column, so their changes were silently never recorded at all. A
-- CREATE OR REPLACE built on 009's body — as the first version of this
-- migration was — reintroduces exactly that: assignment history goes quiet
-- while every id-keyed table keeps working, so nothing looks broken. It was
-- caught only because the demo timeline's governed-% trend flattened.
--
-- The rule this file is an instance of: a CREATE OR REPLACE of a shared
-- function must start from the LATEST definition of it, not the first one a
-- grep finds.

CREATE OR REPLACE FUNCTION fg_record_history() RETURNS trigger AS $$
DECLARE
  v_new_data jsonb;
  v_old_data jsonb;
  v_key_src  jsonb;
  v_id       text;
  v_op       char(1);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD) - 'photo';
    v_new_data := NULL;
    v_key_src  := v_old_data;
    v_op := 'D';
  ELSIF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW) - 'photo';
    v_old_data := NULL;
    v_key_src  := v_new_data;
    v_op := 'I';
  ELSE -- UPDATE
    v_new_data := to_jsonb(NEW) - 'photo';
    v_old_data := to_jsonb(OLD) - 'photo';
    -- Comparing the STRIPPED rows also means a run that changed only the photo
    -- records no history row, which is what we want: the pixels aren't audit
    -- relevant, and a nightly photo refresh should not write a row per user.
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
