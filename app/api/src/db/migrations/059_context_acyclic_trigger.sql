-- Identity Atlas — enforce Contexts-tree acyclicity at the database (#627).
--
-- The Contexts self-FK ("Contexts_parentContextId_fkey") only rejects a 1-hop
-- self-loop (A -> A), never a multi-hop cycle (A -> B -> A). Until now the
-- invariant "the Contexts tree is acyclic" lived only in application code:
-- wouldCreateCycle() on the UI reparent, and breakCycles() run after ingest /
-- plugin batches. That has two problems this migration fixes at the source:
--   1. every raw-SQL / migration / future writer bypasses the JS guards; and
--   2. breakCycles "repaired" a cycle by SILENTLY NULLing an edge — trading a
--      detectable error for undetectable corruption.
--
-- Move the invariant to the layer that owns the data: a DEFERRABLE INITIALLY
-- DEFERRED constraint trigger checked at COMMIT. Deferring to commit lets a bulk
-- set-based batch build up the full tree (a batch-internal transient cycle that
-- resolves before commit is fine) while making it impossible for ANY writer to
-- COMMIT a real cycle. A cyclic write now fails loudly (the transaction aborts
-- with a check_violation) instead of being silently rewritten.

-- 1. One-time cleanup. A constraint trigger validates only NEW writes, never
--    pre-existing rows, so any cycle already stored (written before this trigger)
--    would sit undetected until a later touch failed unexpectedly. NULL the
--    parent of every node currently on a cycle so the tree is acyclic first.
WITH RECURSIVE walk AS (
    SELECT id, "parentContextId" AS cur, ARRAY[id] AS path
      FROM "Contexts" WHERE "parentContextId" IS NOT NULL
    UNION ALL
    SELECT w.id, c."parentContextId", w.path || c.id
      FROM walk w
      JOIN "Contexts" c ON c.id = w.cur
     WHERE c.id <> ALL(w.path)          -- stop the step that would revisit
)
UPDATE "Contexts" t
   SET "parentContextId" = NULL
 WHERE t.id IN (
     SELECT w.id FROM walk w
      JOIN "Contexts" c ON c.id = w.cur
     WHERE c."parentContextId" = w.id
 );

-- 2. The check: is NEW.id currently on a cycle? Walk UP from NEW.id over the LIVE
--    table and see whether the chain returns to NEW.id.
--
--    Crucially this re-reads the row's CURRENT parent rather than trusting
--    NEW."parentContextId": a DEFERRED FOR EACH ROW trigger captures a STALE NEW
--    for every intermediate update, but by commit the table already holds the
--    final state — so a transaction that briefly loops the tree and then fixes it
--    must pass. Re-reading is what makes that work; using the captured NEW value
--    would reject a transient-then-resolved cycle. The CYCLE clause flags the row
--    that closes a loop and stops recursion, so it terminates on any input.
CREATE OR REPLACE FUNCTION "fn_Contexts_reject_cycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    on_cycle boolean;
BEGIN
    SELECT EXISTS (
        WITH RECURSIVE chain AS (
            SELECT id, "parentContextId"
              FROM "Contexts" WHERE id = NEW.id
            UNION ALL
            SELECT c.id, c."parentContextId"
              FROM "Contexts" c
              JOIN chain ch ON c.id = ch."parentContextId"
        ) CYCLE id SET is_cycle USING path
        SELECT 1 FROM chain WHERE id = NEW.id AND is_cycle
    ) INTO on_cycle;

    IF on_cycle THEN
        RAISE EXCEPTION
            'Context % is on a parentContextId cycle — the Contexts tree must stay acyclic',
            NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- 3. Deferred constraint trigger. FOR EACH ROW, but checked at COMMIT because it
--    is DEFERRABLE INITIALLY DEFERRED — so a transaction that passes through a
--    cyclic intermediate state but resolves it before commit is allowed, while a
--    cycle that survives to commit aborts the whole transaction.
DROP TRIGGER IF EXISTS "trg_Contexts_reject_cycle" ON "Contexts";
CREATE CONSTRAINT TRIGGER "trg_Contexts_reject_cycle"
    AFTER INSERT OR UPDATE ON "Contexts"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "fn_Contexts_reject_cycle"();
