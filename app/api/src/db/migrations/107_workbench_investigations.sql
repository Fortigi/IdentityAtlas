-- Identity Atlas — Authorization workbench: save and reopen (M2a)
-- (docs/architecture/m1-discovery-and-design.md, "M2a — save and reopen")
--
-- An INVESTIGATION is an analyst's saved workbench session on one organizational
-- unit: the view (columns, filters, sort), the marks on cells, and the proposed
-- roles (any number; each can be removed) — so the work can be stopped and picked up again. It is a hypothesis
-- workspace: nothing here is a business role, an assignment or a fact about a
-- person, and nothing here grants or removes access.
--
--   WorkbenchInvestigations      one saved session on a unit (org-wide, like saved matrices)
--   WorkbenchAccessSnapshots     the cells the analyst saw when saving, so a reopen can
--                                say what the access data changed since
--   WorkbenchMarks               person × resource × mark (other / unrelated / investigate)
--   RoleProposals                a proposed role. Its own table, never a "Resources" row
--                                with resourceType 'BusinessRole': a proposal must not show up
--                                in the matrix, reports or counts as if it existed.
--   RoleProposalMembers          the people it is meant for
--   RoleProposalEntitlements     what it would contain
--   RoleProposalEvidence         the claims (ContextClaims) it rests on
--
-- A person is (personKind, personId): an Identity, or an account (Principal) that is
-- linked to no identity — the workbench's own row key. People and resources carry NO
-- foreign key on purpose: a full sync can delete them, and a saved investigation must
-- then say "no longer found" instead of silently losing rows (as in 104).
--
-- Ready for M2b (review, approve, versions) without using it yet: status allows the
-- later values but the API writes only 'draft'; version stays 1.
--
-- Additive: no existing row is changed. Nothing here touches ResourceAssignments.

CREATE TABLE "WorkbenchInvestigations" (
    "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"    UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    "name"         TEXT NOT NULL CHECK (length(btrim("name")) > 0),
    "description"  TEXT,
    "view"         JSONB NOT NULL DEFAULT '{}'::jsonb,
    "accessReadAt" TIMESTAMPTZ,
    "createdBy"    TEXT NOT NULL,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy"    TEXT NOT NULL,
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ux_WorkbenchInvestigations_name" ON "WorkbenchInvestigations" ("contextId", lower(btrim("name")));

-- Kept apart from the investigation row so the history trigger does not copy it on every save.
CREATE TABLE "WorkbenchAccessSnapshots" (
    "investigationId" UUID PRIMARY KEY REFERENCES "WorkbenchInvestigations"("id") ON DELETE CASCADE,
    "cells"           JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE "WorkbenchMarks" (
    "investigationId" UUID NOT NULL REFERENCES "WorkbenchInvestigations"("id") ON DELETE CASCADE,
    "personKind"      TEXT NOT NULL CHECK ("personKind" IN ('identity', 'principal')),
    "personId"        UUID NOT NULL,
    "resourceId"      UUID NOT NULL,
    "mark"            TEXT NOT NULL CHECK ("mark" IN ('other', 'unrelated', 'investigate')),
    "note"            TEXT,
    "markedBy"        TEXT NOT NULL,
    "markedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("investigationId", "personKind", "personId", "resourceId")
);

CREATE TABLE "RoleProposals" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "investigationId"    UUID NOT NULL REFERENCES "WorkbenchInvestigations"("id") ON DELETE CASCADE,
    "name"               TEXT NOT NULL DEFAULT '',
    "description"        TEXT,
    "mode"               TEXT NOT NULL DEFAULT 'new' CHECK ("mode" IN ('new', 'extend')),
    "baseBusinessRoleId" UUID REFERENCES "Resources"("id") ON DELETE SET NULL,
    "status"             TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'inReview', 'approved', 'rejected')),
    "version"            INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
    "createdBy"          TEXT NOT NULL,
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy"          TEXT NOT NULL,
    "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_RoleProposals_investigation" ON "RoleProposals" ("investigationId");
CREATE INDEX "ix_RoleProposals_base" ON "RoleProposals" ("baseBusinessRoleId") WHERE "baseBusinessRoleId" IS NOT NULL;

CREATE TABLE "RoleProposalMembers" (
    "proposalId" UUID NOT NULL REFERENCES "RoleProposals"("id") ON DELETE CASCADE,
    "personKind" TEXT NOT NULL CHECK ("personKind" IN ('identity', 'principal')),
    "personId"   UUID NOT NULL,
    PRIMARY KEY ("proposalId", "personKind", "personId")
);
CREATE INDEX "ix_RoleProposalMembers_person" ON "RoleProposalMembers" ("personId");

CREATE TABLE "RoleProposalEntitlements" (
    "proposalId" UUID NOT NULL REFERENCES "RoleProposals"("id") ON DELETE CASCADE,
    "resourceId" UUID NOT NULL,
    PRIMARY KEY ("proposalId", "resourceId")
);
CREATE INDEX "ix_RoleProposalEntitlements_resource" ON "RoleProposalEntitlements" ("resourceId");

CREATE TABLE "RoleProposalEvidence" (
    "proposalId" UUID NOT NULL REFERENCES "RoleProposals"("id") ON DELETE CASCADE,
    "claimId"    UUID NOT NULL REFERENCES "ContextClaims"("id") ON DELETE CASCADE,
    PRIMARY KEY ("proposalId", "claimId")
);

-- Who saved what, and when: the analyst's judgement, recorded like the adjustments (104).
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['WorkbenchInvestigations', 'RoleProposals'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_ins_del ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_ins_del AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fg_record_history()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_upd ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION fg_record_history()', t);
    END LOOP;
END $$;
