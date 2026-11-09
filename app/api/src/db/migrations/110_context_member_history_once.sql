-- Identity Atlas — a member who leaves is stored once in _history, not twice
--
-- Migration 109 recorded a ContextMembers DELETE with the removed row in both
-- "rowData" and "prevData". The timeline reads "rowData" only (it is NOT NULL
-- for every operation), so the copy in "prevData" was dead weight on every
-- leave. This replaces the trigger function: a delete keeps the row in
-- "rowData" and leaves "prevData" empty, as an insert already does. 109 has
-- already run on existing databases, so it is not edited.
--
-- The rows 109 already wrote get the same shape: only ContextMembers deletes
-- whose "prevData" is an exact copy of "rowData" (what 109 wrote) are touched,
-- and only their redundant copy is cleared — "rowData" keeps the member.

CREATE OR REPLACE FUNCTION fg_record_context_member_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
    VALUES (TG_TABLE_NAME, OLD."contextId"::text, 'D', to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
  INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
  VALUES (TG_TABLE_NAME, NEW."contextId"::text, 'I', to_jsonb(NEW), NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE "_history"
   SET "prevData" = NULL
 WHERE "tableName" = 'ContextMembers'
   AND operation = 'D'
   AND "prevData" = "rowData";
