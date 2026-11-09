-- Identity Atlas — Adjust tree: corrections on top of a generated or imported tree
-- (docs/architecture/adjust-tree.md)
--
-- A generated tree (a context plugin) or an imported one (a crawler, an uploaded
-- list) is rebuilt from its source on every run or sync. An analyst's correction
-- of that tree — move a unit, move a member, rename, add a grouping unit, split a
-- unit, set an (interim) manager — is stored here as one ADJUSTMENT and applied
-- again after every rebuild, so it survives the source instead of being
-- overwritten by it.
--
--   treeKey            which tree: 'gen~<algorithmId>~<instanceKey>',
--                      'sync~<systemId>~<template>' or 'ctx~<rootContextId>'
--   scopeSystemId      the source system, so a sync of that system re-applies
--                      the tree's adjustments (NULL for a hand-built tree)
--   seq                apply order
--   subjectId          the unit it is about; deliberately no FK — the unit can
--                      vanish from the source, and the adjustment must then be
--                      shown for review instead of disappearing with it
--   memberId           the member it is about (moveMember)
--   payload            the op's own fields
--   before             what the op replaced, so undo restores it even for an
--                      imported tree that cannot be regenerated on demand
--   snapshot           the subject's name and members when the adjustment was
--                      made; used to recognise the unit when the source gives it
--                      a new key (a renamed department, a re-keyed list row)
--   status             the outcome of the latest apply, or 'reverted' (undone)
--   suggestion         for needsDecision: where the subject probably went
--
-- Additive: no existing row is changed.

CREATE TABLE "ContextTreeAdjustments" (
    "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "treeKey"       TEXT NOT NULL,
    "scopeSystemId" INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "seq"           BIGINT GENERATED ALWAYS AS IDENTITY,
    "op"            TEXT NOT NULL CHECK ("op" IN ('moveUnit', 'renameUnit', 'moveMember', 'addUnit', 'splitUnit', 'setManager')),
    "subjectId"     UUID,
    "memberId"      UUID,
    "payload"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "before"        JSONB NOT NULL DEFAULT '{}'::jsonb,
    "snapshot"      JSONB,
    "reason"        TEXT,
    "validUntil"    DATE,
    "status"        TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'needsDecision', 'orphaned', 'matches', 'expired', 'reverted')),
    "statusDetail"  TEXT,
    "suggestion"    JSONB,
    "createdBy"     TEXT NOT NULL,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_ContextTreeAdjustments_tree"   ON "ContextTreeAdjustments" ("treeKey", "seq");
CREATE INDEX "ix_ContextTreeAdjustments_system" ON "ContextTreeAdjustments" ("scopeSystemId") WHERE "status" <> 'reverted';

-- An adjustment is an analyst's judgement on governed data: record it like the
-- roles and decisions next to it.
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextTreeAdjustments";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextTreeAdjustments"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ContextTreeAdjustments";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ContextTreeAdjustments"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();
END $$;
