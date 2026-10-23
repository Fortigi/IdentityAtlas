-- Identity Atlas — Change requests: what should change in the source
-- (docs/architecture/change-requests.md)
--
-- An analyst's decision can override a source: "the interview is right: Led left,
-- even though Klanten (upload) still lists him" marks Led former on top of the
-- member list (ContextMemberOverrides, migration 099). The source itself is still
-- wrong, and its next sync or re-import brings the fact back. A change request
-- records what should change THERE: which source, which kind of change, about what,
-- resting on which claim and override.
--
-- The data closes it, not a person: an open request whose change the source now
-- shows is resolved on the next read (the member is no longer listed, the unit is
-- gone). Undoing the decision withdraws it. Who receives a request, and how, is not
-- modelled yet.
--
-- The names are copied at raise time (targetName, contextName, memberName) so a
-- request still reads after its system, unit or person is removed.
--
-- Additive: no row is changed. Nothing here touches ResourceAssignments or ContextMembers.

CREATE TABLE "ChangeRequests" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "changeKind"     TEXT NOT NULL CHECK ("changeKind" IN ('EntityCreate', 'EntityDelete', 'RelationshipAdd', 'RelationshipRemove', 'AttributeUpdate')),
    "targetSystemId" INTEGER REFERENCES "Systems"("id")                ON DELETE SET NULL,
    "targetName"     TEXT NOT NULL,
    "contextId"      UUID    REFERENCES "Contexts"("id")               ON DELETE SET NULL,
    "contextName"    TEXT,
    "memberId"       UUID,
    "memberName"     TEXT,
    "attribute"      TEXT,
    "currentValue"   TEXT,
    "expectedValue"  TEXT,
    "summary"        TEXT NOT NULL,
    "requestStatus"  TEXT NOT NULL DEFAULT 'open' CHECK ("requestStatus" IN ('open', 'resolved', 'withdrawn')),
    "basisClaimId"   UUID    REFERENCES "ContextClaims"("id")          ON DELETE SET NULL,
    "overrideId"     UUID    REFERENCES "ContextMemberOverrides"("id") ON DELETE SET NULL,
    "raisedBy"       TEXT,
    "raisedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "closedAt"       TIMESTAMPTZ,
    "closedReason"   TEXT,
    CONSTRAINT "ck_ChangeRequests_closed" CHECK (("requestStatus" = 'open') = ("closedAt" IS NULL))
);

-- At most one open request for the same change: deciding it twice updates it.
-- COALESCE makes a missing system, unit or member count as one value.
CREATE UNIQUE INDEX "uq_ChangeRequests_open" ON "ChangeRequests" (
    "changeKind",
    COALESCE("targetSystemId", 0),
    COALESCE("contextId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("memberId",  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("attribute", '')
) WHERE "requestStatus" = 'open';
CREATE INDEX "ix_ChangeRequests_context" ON "ChangeRequests" ("contextId");
CREATE INDEX "ix_ChangeRequests_override" ON "ChangeRequests" ("overrideId");

-- A request is a governed judgement: record it like the decisions it rests on (097, 099).
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ChangeRequests";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ChangeRequests"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ChangeRequests";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ChangeRequests"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();
END $$;
