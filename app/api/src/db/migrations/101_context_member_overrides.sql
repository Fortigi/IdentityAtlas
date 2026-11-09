-- Identity Atlas — Context interviews: a member marked former by a decision
-- (docs/architecture/context-interviews.md → "Marked former by a decision")
--
-- An analyst decides a contradiction "the interview is right" for a person the
-- interview says left while the member list (its source: a sync, an upload, a
-- plugin, or kept by hand) still lists them. That decision is an OVERRIDE on top
-- of ContextMembers, never a change to it: the source would add the row back on
-- its next sync or re-import. One row per (context, member): the claim it was
-- decided on, the source it overrides (its name when decided), who and when.
--
-- The members list leaves an overridden member out of the current members (on
-- request it shows them, flagged), Previous members lists them with the decision,
-- the unit report marks them. Undoing the decision deletes the row; deleting the
-- interview deletes it with its claim. Access is untouched: what the person
-- still holds stays in ResourceAssignments, and the matrix shows it.
--
-- Additive: no row is changed. Nothing here touches ResourceAssignments or ContextMembers.

CREATE TABLE "ContextMemberOverrides" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"  UUID NOT NULL REFERENCES "Contexts"("id")      ON DELETE CASCADE,
    "memberId"   UUID NOT NULL,
    "claimId"    UUID NOT NULL REFERENCES "ContextClaims"("id") ON DELETE CASCADE,
    "overrides"  TEXT NOT NULL,
    "decidedBy"  TEXT,
    "decidedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "uq_ContextMemberOverrides_member" UNIQUE ("contextId", "memberId")
);
CREATE INDEX "ix_ContextMemberOverrides_claim" ON "ContextMemberOverrides" ("claimId");

-- A decision is a governed judgement: record it like the claims it rests on (097).
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextMemberOverrides";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextMemberOverrides"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ContextMemberOverrides";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ContextMemberOverrides"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();
END $$;
