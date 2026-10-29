-- Identity Atlas — who joined and left a context, in _history
--
-- A unit's timeline has to say "Lisa Vos joined", "Max Jacobs left". Nothing
-- recorded that: ContextMembers has no "id" column, so the shared history
-- trigger (fg_record_history, migration 009) would skip every row of it, and
-- it was never attached. This records each membership that is added or taken
-- away, in the same _history table, keyed by the CONTEXT ("rowId" = contextId):
-- a context's timeline then reads its memberships with the existing
-- ("tableName","rowId","changedAt") index, the way it reads the context row.
--
-- Only INSERT and DELETE: a membership either exists or it does not. An update
-- (an analyst taking over a synced row, say) is no join and no leave.
--
-- The plugin runner used to delete and re-insert every algorithm-added member
-- on each refresh; it now keeps the members it still produces
-- (contexts/plugins/runner.js, replaceOwnedMembers), so a refresh records only
-- what actually changed.
--
-- No row is changed and nothing is back-filled: memberships added before this
-- migration keep their addedAt, which the timeline reads for them.

CREATE OR REPLACE FUNCTION fg_record_context_member_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
    VALUES (TG_TABLE_NAME, OLD."contextId"::text, 'D', to_jsonb(OLD), to_jsonb(OLD));
    RETURN OLD;
  END IF;
  INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
  VALUES (TG_TABLE_NAME, NEW."contextId"::text, 'I', to_jsonb(NEW), NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextMembers";
CREATE TRIGGER trg_history_ins_del
AFTER INSERT OR DELETE ON "ContextMembers"
FOR EACH ROW EXECUTE FUNCTION fg_record_context_member_history();
