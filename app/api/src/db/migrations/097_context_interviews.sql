-- Identity Atlas — Context interviews (docs/architecture/context-interviews.md)
--
-- An analyst uploads the transcript of an interview about an organizational
-- unit or a logical application and says who was interviewed and when. What
-- the interview says becomes CLAIMS: statements by that source about the
-- context or about a person, each with the verbatim quote it rests on. Nothing
-- a claim says is a fact until someone confirms it; a confirmed claim may then
-- add to the context's description, set one of its attributes, or become one
-- of its ContextRoles. A claim never creates access.
--
-- Nothing here touches ResourceAssignments or assignmentType.

-- ─── 1. The interview: a source ──────────────────────────────────────────────
-- The interviewee is an account or a person (at most one; both NULL once the
-- row they named is gone). intervieweeName is their name when the transcript
-- was uploaded, so a source keeps its name after a crawl removes the account.
CREATE TABLE "ContextInterviews" (
    "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"           UUID NOT NULL REFERENCES "Contexts"("id")   ON DELETE CASCADE,
    "principalId"         UUID          REFERENCES "Principals"("id") ON DELETE SET NULL,
    "identityId"          UUID          REFERENCES "Identities"("id") ON DELETE SET NULL,
    "intervieweeName"     TEXT NOT NULL,
    "interviewedAt"       DATE NOT NULL,
    "fileName"            TEXT NOT NULL,
    "transcript"          TEXT NOT NULL,
    "language"            TEXT,
    "extractionStatus"    TEXT NOT NULL DEFAULT 'pending'
                            CHECK ("extractionStatus" IN ('pending', 'running', 'done', 'failed', 'notConfigured')),
    "extractionMessage"   TEXT,
    "extractionStartedAt" TIMESTAMPTZ,
    "model"               TEXT,
    "createdBy"           TEXT,
    "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ContextInterviews_one_interviewee" CHECK ("principalId" IS NULL OR "identityId" IS NULL)
);
CREATE INDEX "ix_ContextInterviews_context" ON "ContextInterviews" ("contextId", "interviewedAt");

-- ─── 2. The claims an interview makes ────────────────────────────────────────
-- claimKind: description (about the context, in words), property (one
-- attribute: `attribute` is its key), role (who answers for or works on it:
-- `attribute` is the relation the speaker stated — owner, notOwner, dayToDay,
-- delegate, member, other) and roleHistory (a role a person held over time).
-- The subject is the context itself (subjectKind 'Context') or a person
-- (subjectKind 'Person'): the account or person it was matched to, if any,
-- and always the name as spoken. roleSuggestion is what a confirmed role claim
-- becomes. A claim is proposed until someone decides it: confirmed, edited
-- (confirmed with a changed value or period) or rejected.
CREATE TABLE "ContextClaims" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "interviewId"    UUID NOT NULL REFERENCES "ContextInterviews"("id") ON DELETE CASCADE,
    "contextId"      UUID NOT NULL REFERENCES "Contexts"("id")          ON DELETE CASCADE,
    "claimKind"      TEXT NOT NULL CHECK ("claimKind" IN ('description', 'property', 'role', 'roleHistory')),
    "subjectKind"    TEXT NOT NULL CHECK ("subjectKind" IN ('Context', 'Person')),
    "principalId"    UUID          REFERENCES "Principals"("id") ON DELETE SET NULL,
    "identityId"     UUID          REFERENCES "Identities"("id") ON DELETE SET NULL,
    "subjectName"    TEXT,
    "subjectMatch"   TEXT CHECK ("subjectMatch" IN ('interviewee', 'key', 'name', 'fuzzy', 'firstName')),
    "attribute"      TEXT,
    "value"          TEXT NOT NULL,
    "periodFrom"     DATE,
    "periodTo"       DATE,
    "periodText"     TEXT,
    "quote"          TEXT,
    "confidence"     NUMERIC(3, 2) CHECK ("confidence" >= 0 AND "confidence" <= 1),
    "roleSuggestion" TEXT CHECK ("roleSuggestion" IN ('Accountable', 'Responsible')),
    "status"         TEXT NOT NULL DEFAULT 'proposed' CHECK ("status" IN ('proposed', 'confirmed', 'rejected', 'edited')),
    "origin"         TEXT NOT NULL CHECK ("origin" IN ('model', 'analyst')),
    "decidedBy"      TEXT,
    "decidedAt"      TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ContextClaims_one_subject" CHECK ("principalId" IS NULL OR "identityId" IS NULL)
);
CREATE INDEX "ix_ContextClaims_context"   ON "ContextClaims" ("contextId", "status");
CREATE INDEX "ix_ContextClaims_interview" ON "ContextClaims" ("interviewId");
CREATE INDEX "ix_ContextClaims_principal" ON "ContextClaims" ("principalId") WHERE "principalId" IS NOT NULL;
CREATE INDEX "ix_ContextClaims_identity"  ON "ContextClaims" ("identityId")  WHERE "identityId"  IS NOT NULL;

-- ─── 3. A role's provenance ──────────────────────────────────────────────────
-- A role confirmed from an interview is an analyst's decision (addedBy stays
-- 'analyst', so the plugin runner and the synced-owner reconcile leave it
-- alone, as they do every analyst role); sourceClaimId says which claim it
-- came from. Deleting the interview deletes its claims and clears this link;
-- the role itself stays.
ALTER TABLE "ContextRoles"
  ADD COLUMN "sourceClaimId" UUID REFERENCES "ContextClaims"("id") ON DELETE SET NULL;
CREATE INDEX "ix_ContextRoles_sourceClaim" ON "ContextRoles" ("sourceClaimId") WHERE "sourceClaimId" IS NOT NULL;

-- ─── 4. History ──────────────────────────────────────────────────────────────
-- A decision on a claim is a governed judgement: record it like the roles it
-- may become (092).
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextClaims";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextClaims"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ContextClaims";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ContextClaims"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();
END $$;
