-- Identity Atlas — version history for saved matrices.
--
-- A saved matrix is org-wide: anybody who can reach the Matrix tab can rename
-- it, re-cut it or delete it, and the row only ever remembered the LAST writer
-- (updatedBy/updatedAt). When a matrix that used to work stops producing rows,
-- "who changed this, and to what" had no answer at all.
--
-- The generic snapshot trigger from 009_history.sql already answers exactly
-- that for Principals/Resources/..., so this attaches it to SavedMatrixFilters
-- rather than inventing a second audit mechanism. Because each snapshot carries
-- the whole row, `updatedBy` inside the snapshot IS the actor of that change —
-- no separate actor column is needed.
--
-- Forward-only: rows written before this migration have no history, so a matrix
-- that predates it starts its trail at its next change. Its createdBy/createdAt
-- still name who first saved it.

DO $$
BEGIN
    IF to_regclass('public."SavedMatrixFilters"') IS NULL THEN
        RETURN;
    END IF;

    DROP TRIGGER IF EXISTS trg_history_ins_del ON "SavedMatrixFilters";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "SavedMatrixFilters"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "SavedMatrixFilters";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "SavedMatrixFilters"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();
END $$;
