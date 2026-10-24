-- Identity Atlas — Survey templates (docs/architecture/survey-templates.md)
--
-- An analyst defines a survey: the questions to ask about a kind of context (an
-- organizational unit, a logical application), in the analyst's own words and
-- languages, and what each answer means — which claim it becomes. From a
-- context's page the analyst sends it to a person; that person (or the analyst
-- on their behalf) answers it. A submitted answer is a SOURCE like an interview:
-- one ContextInterviews row whose transcript is the questions and answers, and
-- one ContextClaims row per answer that means something, proposed by the
-- respondent and reviewed like any other claim. A survey never writes a fact.
--
-- Nothing here touches ResourceAssignments or assignmentType.

-- ─── 1. The template ─────────────────────────────────────────────────────────
-- `key` is the template's stable name (the seeds use it to add themselves once).
-- It applies to one context category, optionally only under one context
-- (scopeRootContextId: "the customers", not every unit). The questions live in
-- its versions; currentVersion is the one a new survey request is sent with.
-- archivedAt hides it from the picker; requests already sent keep working.
CREATE TABLE "SurveyTemplates" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "key"                TEXT NOT NULL UNIQUE,
    "name"               TEXT NOT NULL,
    "description"        TEXT,
    "contextCategory"    TEXT NOT NULL CHECK ("contextCategory" IN ('OrganizationalUnit', 'LogicalApplication')),
    "scopeRootContextId" UUID REFERENCES "Contexts"("id") ON DELETE SET NULL,
    "currentVersion"     INTEGER NOT NULL DEFAULT 1 CHECK ("currentVersion" >= 1),
    "builtIn"            BOOLEAN NOT NULL DEFAULT FALSE,
    "createdBy"          TEXT,
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "archivedAt"         TIMESTAMPTZ
);

-- ─── 2. Its versions ─────────────────────────────────────────────────────────
-- A version is never changed: a request is answered against the exact questions
-- it was sent with. Saving changed questions adds a version.
CREATE TABLE "SurveyTemplateVersions" (
    "templateId"  UUID NOT NULL REFERENCES "SurveyTemplates"("id") ON DELETE CASCADE,
    "version"     INTEGER NOT NULL CHECK ("version" >= 1),
    "definition"  JSONB NOT NULL,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("templateId", "version")
);

-- ─── 3. A survey sent to one person about one context ────────────────────────
-- The recipient is an account or a person (at most one; recipientName keeps the
-- name when that row goes). answers holds what was filled in so far (a draft is
-- saved as it is answered); on submit the answers become an interview
-- (interviewId) and its claims. status: sent → submitted, or cancelled.
-- Overdue is read from dueAt, not stored.
CREATE TABLE "SurveyRequests" (
    "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "templateId"      UUID NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "contextId"       UUID NOT NULL REFERENCES "Contexts"("id")   ON DELETE CASCADE,
    "principalId"     UUID          REFERENCES "Principals"("id") ON DELETE SET NULL,
    "identityId"      UUID          REFERENCES "Identities"("id") ON DELETE SET NULL,
    "recipientName"   TEXT NOT NULL,
    "language"        TEXT,
    "message"         TEXT,
    "dueAt"           DATE,
    "status"          TEXT NOT NULL DEFAULT 'sent' CHECK ("status" IN ('sent', 'submitted', 'cancelled')),
    "answers"         JSONB NOT NULL DEFAULT '{}'::jsonb,
    "sentBy"          TEXT,
    "sentAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "openedAt"        TIMESTAMPTZ,
    "submittedAt"     TIMESTAMPTZ,
    "submittedBy"     TEXT,
    "onBehalf"        BOOLEAN NOT NULL DEFAULT FALSE,
    "interviewId"     UUID REFERENCES "ContextInterviews"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_SurveyRequests_version" FOREIGN KEY ("templateId", "templateVersion")
        REFERENCES "SurveyTemplateVersions"("templateId", "version") ON DELETE CASCADE,
    CONSTRAINT "ck_SurveyRequests_one_recipient" CHECK ("principalId" IS NULL OR "identityId" IS NULL)
);
CREATE INDEX "ix_SurveyRequests_context"   ON "SurveyRequests" ("contextId", "sentAt");
CREATE INDEX "ix_SurveyRequests_principal" ON "SurveyRequests" ("principalId") WHERE "principalId" IS NOT NULL;
CREATE INDEX "ix_SurveyRequests_identity"  ON "SurveyRequests" ("identityId")  WHERE "identityId"  IS NOT NULL;

-- ─── 4. The interview a survey answer is ─────────────────────────────────────
-- An interview made from a submitted survey points back at it; its claims are
-- proposed by the respondent and say which question they answer.
ALTER TABLE "ContextInterviews"
  ADD COLUMN "surveyRequestId" UUID REFERENCES "SurveyRequests"("id") ON DELETE SET NULL;

ALTER TABLE "ContextClaims" DROP CONSTRAINT IF EXISTS "ContextClaims_proposedBy_check";
ALTER TABLE "ContextClaims" ADD CONSTRAINT "ContextClaims_proposedBy_check"
  CHECK ("proposedBy" IN ('model', 'analyst', 'respondent'));

ALTER TABLE "ContextClaims"
  ADD COLUMN "surveyQuestionId" TEXT;

-- A survey asked per entitlement ("is this entitlement's owner right?") makes a
-- claim about a RESOURCE of the context: subjectKind 'Resource', the resource in
-- resourceId (cleared when the resource goes; subjectName keeps its name).
-- Knowledge only — confirming one never changes the crawled Resources row.
ALTER TABLE "ContextClaims"
  ADD COLUMN "resourceId" UUID REFERENCES "Resources"("id") ON DELETE SET NULL;
CREATE INDEX "ix_ContextClaims_resource" ON "ContextClaims" ("resourceId") WHERE "resourceId" IS NOT NULL;

ALTER TABLE "ContextClaims" DROP CONSTRAINT IF EXISTS "ContextClaims_subjectKind_check";
ALTER TABLE "ContextClaims" ADD CONSTRAINT "ContextClaims_subjectKind_check"
  CHECK ("subjectKind" IN ('Context', 'Person', 'Resource'));

-- ─── 5. History ──────────────────────────────────────────────────────────────
-- Who sent what to whom, and when it was answered, is part of the record. A
-- saved draft (answers, openedAt) is not: only a change of status or due date
-- is recorded.
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "SurveyRequests";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "SurveyRequests"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "SurveyRequests";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "SurveyRequests"
    FOR EACH ROW
    WHEN (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."dueAt" IS DISTINCT FROM NEW."dueAt")
    EXECUTE FUNCTION fg_record_history();
END $$;
