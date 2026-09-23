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
-- "Principals" is in the fg_record_history() tracked set (009_history.sql).
-- That trigger stores to_jsonb(NEW) — and to_jsonb() renders a bytea as a hex
-- string, two characters per byte. Worse, an UPDATE stores both rowData AND
-- prevData, so every unrelated change to a user (job title, department, a
-- disabled account) would write the photo to "_history" twice. On a tenant of
-- any size that dominates the audit log with data nobody ever reviews, and
-- history is never pruned.
--
-- So strip the blob columns before recording. The '-' operator on jsonb
-- removes a key; the columns keep their audit value through "photoFetchedAt",
-- which stays in the record, so you can still see WHEN a photo changed —
-- just not the pixels.
--
-- This redefines the shared function used by all seven tracked tables. Tables
-- without a "photo" key are unaffected: `jsonb - 'photo'` on an object that
-- lacks the key is a no-op.

CREATE OR REPLACE FUNCTION fg_record_history() RETURNS trigger AS $$
DECLARE
  v_new_data jsonb;
  v_old_data jsonb;
  v_id       text;
  v_op       char(1);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD) - 'photo';
    v_new_data := NULL;
    v_id := COALESCE(v_old_data->>'id', v_old_data->>'Id');
    v_op := 'D';
  ELSIF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW) - 'photo';
    v_old_data := NULL;
    v_id := COALESCE(v_new_data->>'id', v_new_data->>'Id');
    v_op := 'I';
  ELSE -- UPDATE
    v_new_data := to_jsonb(NEW) - 'photo';
    v_old_data := to_jsonb(OLD) - 'photo';
    -- Defensive — also caught by the trigger WHEN clause. Note this now also
    -- means a run that ONLY changed the photo records no history row, which is
    -- what we want: the pixels aren't audit-relevant.
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
