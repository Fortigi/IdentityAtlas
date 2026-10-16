-- Migration 084 — Identity Atlas Interviews: the proposal and evidence store.
--
-- Experimental, behind the `interviews` feature flag. Design:
-- docs/architecture/interviews.md.
--
-- What an interview leaves on the server is CLAIMS, never facts: who mentioned whom,
-- how a mention was resolved and by whom, what statement was made, where in the
-- recording it was made, and what an analyst decided about the proposal built on it.
-- Nothing here is read by the matrix, the reports or the context plugins, and nothing
-- here writes to Resources, ResourceAssignments, Principals, Identities or Contexts.
--
-- No audio and no transcript is stored. Evidence is a position (segment, milliseconds,
-- character span) plus the SHA-256 of the excerpt; the excerpt text itself only for an
-- interview created with storagePolicy 'evidence-excerpt'.
--
-- References to canonical rows (subjectIdentityId, scopeContextId, entityId) carry no
-- foreign key on purpose: the interview record must survive a crawl that deletes or
-- regenerates the row it points at, and must never block or cascade from one.
--
-- Append-only: every table except "Interviews" refuses UPDATE (trigger below). A
-- revision is a new row; the original evidence is never overwritten. DELETE happens
-- only through deleting the interview (cascade). "InterviewEvents", the audit trail,
-- refuses DELETE as well — it holds no spoken content, only who did what when.
--
-- The CHECK lists mirror src/interviews/contracts.js; 084_interviews.test.js fails if
-- they drift apart.

CREATE TABLE "Interviews" (
    "id"                 UUID PRIMARY KEY,
    "interviewType"      TEXT NOT NULL CHECK ("interviewType" IN ('role-mining','data-owner')),
    "title"              TEXT,
    -- 'oid:<Entra object id>' for a signed-in caller, 'anonymous' while auth is off.
    "ownerKey"           TEXT NOT NULL,
    "ownerName"          TEXT,
    "subjectIdentityId"  UUID,
    "scopeContextId"     UUID,
    "storagePolicy"      TEXT NOT NULL CHECK ("storagePolicy" IN ('local-only','evidence-excerpt')),
    "noticeVersion"      TEXT NOT NULL,
    "noticeConfirmedAt"  TIMESTAMPTZ NOT NULL,
    "retainUntil"        TIMESTAMPTZ NOT NULL,
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_Interviews_owner" ON "Interviews" ("ownerKey", "createdAt" DESC);
CREATE INDEX "ix_Interviews_retainUntil" ON "Interviews" ("retainUntil");

CREATE TABLE "InterviewMentions" (
    "id"              UUID PRIMARY KEY,
    "interviewId"     UUID NOT NULL REFERENCES "Interviews"("id") ON DELETE CASCADE,
    "segmentId"       TEXT NOT NULL,
    "startMs"         INTEGER NOT NULL CHECK ("startMs" >= 0),
    "endMs"           INTEGER NOT NULL,
    "spanStart"       INTEGER NOT NULL CHECK ("spanStart" >= 0),
    "spanEnd"         INTEGER NOT NULL,
    "literalText"     TEXT NOT NULL,
    "entityKindHint"  TEXT CHECK ("entityKindHint" IN ('identity','account','resource','context')),
    "detector"        TEXT NOT NULL,
    "createdBy"       TEXT NOT NULL,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ("endMs" >= "startMs"),
    CHECK ("spanEnd" > "spanStart")
);
CREATE INDEX "ix_InterviewMentions_interview" ON "InterviewMentions" ("interviewId");

-- One row per decision; the latest row (highest id) is the mention's current state.
-- matchScore is MATCH confidence (how well the name matched) — not claim confidence,
-- and not the decision.
CREATE TABLE "InterviewResolutions" (
    "id"              BIGSERIAL PRIMARY KEY,
    "mentionId"       UUID NOT NULL REFERENCES "InterviewMentions"("id") ON DELETE CASCADE,
    "state"           TEXT NOT NULL CHECK ("state" IN ('unresolved','suggested','confirmed','rejected','not_found','deferred')),
    "origin"          TEXT NOT NULL CHECK ("origin" IN ('analyst','detector')),
    "entityKind"      TEXT CHECK ("entityKind" IN ('identity','account','resource','context')),
    "entityId"        UUID,
    "matchScore"      NUMERIC(4,3) CHECK ("matchScore" BETWEEN 0 AND 1),
    "candidateCount"  INTEGER CHECK ("candidateCount" >= 0),
    "rationale"       TEXT,
    "decidedBy"       TEXT NOT NULL,
    "decidedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (("entityId" IS NULL) = ("entityKind" IS NULL)),
    -- Automation never confirms, rejects or defers; only an analyst does.
    CHECK ("origin" = 'analyst' OR "state" IN ('unresolved','suggested','not_found'))
);
CREATE INDEX "ix_InterviewResolutions_mention" ON "InterviewResolutions" ("mentionId", "id" DESC);

-- A claim made in the interview. A revision is a new row in the same lineage with the
-- next version; the earlier version and its evidence stay as they were.
CREATE TABLE "InterviewStatements" (
    "id"               UUID PRIMARY KEY,
    "interviewId"      UUID NOT NULL REFERENCES "Interviews"("id") ON DELETE CASCADE,
    "lineageId"        UUID NOT NULL,
    "version"          INTEGER NOT NULL CHECK ("version" >= 1),
    "subject"          JSONB NOT NULL,
    "predicate"        TEXT NOT NULL,
    "object"           JSONB NOT NULL,
    "attribution"      TEXT,
    "claimConfidence"  NUMERIC(4,3) CHECK ("claimConfidence" BETWEEN 0 AND 1),
    "extractor"        TEXT NOT NULL,
    "createdBy"        TEXT NOT NULL,
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("lineageId", "version")
);
CREATE INDEX "ix_InterviewStatements_interview" ON "InterviewStatements" ("interviewId");

CREATE TABLE "InterviewEvidence" (
    "id"           UUID PRIMARY KEY,
    "statementId"  UUID NOT NULL REFERENCES "InterviewStatements"("id") ON DELETE CASCADE,
    "segmentId"    TEXT NOT NULL,
    "startMs"      INTEGER NOT NULL CHECK ("startMs" >= 0),
    "endMs"        INTEGER NOT NULL,
    "spanStart"    INTEGER NOT NULL CHECK ("spanStart" >= 0),
    "spanEnd"      INTEGER NOT NULL,
    "excerptHash"  TEXT NOT NULL CHECK ("excerptHash" ~ '^[0-9a-f]{64}$'),
    "excerptText"  TEXT,
    "sttEngine"    TEXT NOT NULL,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ("endMs" >= "startMs"),
    CHECK ("spanEnd" > "spanStart")
);
CREATE INDEX "ix_InterviewEvidence_statement" ON "InterviewEvidence" ("statementId");

-- A proposal to turn one statement VERSION into governed knowledge. Its review state is
-- its latest review decision. Approval records the decision only — promotion into the
-- canonical model is a later, separate step that this slice does not have.
CREATE TABLE "InterviewProposals" (
    "id"            UUID PRIMARY KEY,
    "interviewId"   UUID NOT NULL REFERENCES "Interviews"("id") ON DELETE CASCADE,
    "statementId"   UUID NOT NULL REFERENCES "InterviewStatements"("id") ON DELETE CASCADE,
    "proposalKind"  TEXT NOT NULL CHECK ("proposalKind" IN ('relationship','role','responsibility','new-entity')),
    "summary"       TEXT NOT NULL,
    "createdBy"     TEXT NOT NULL,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_InterviewProposals_interview" ON "InterviewProposals" ("interviewId");

CREATE TABLE "InterviewReviewDecisions" (
    "id"             BIGSERIAL PRIMARY KEY,
    "proposalId"     UUID NOT NULL REFERENCES "InterviewProposals"("id") ON DELETE CASCADE,
    "action"         TEXT NOT NULL CHECK ("action" IN ('approve','reject','defer')),
    "targetVersion"  INTEGER NOT NULL CHECK ("targetVersion" >= 1),
    "rationale"      TEXT,
    "reviewer"       TEXT NOT NULL,
    "reviewerName"   TEXT,
    "decidedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_InterviewReviewDecisions_proposal" ON "InterviewReviewDecisions" ("proposalId", "id" DESC);

-- The audit trail. No foreign key: it outlives the interview it describes.
CREATE TABLE "InterviewEvents" (
    "id"           BIGSERIAL PRIMARY KEY,
    "interviewId"  UUID NOT NULL,
    "action"       TEXT NOT NULL,
    "actor"        TEXT NOT NULL,
    "detail"       JSONB,
    "at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "ix_InterviewEvents_interview" ON "InterviewEvents" ("interviewId", "id");

CREATE OR REPLACE FUNCTION fg_interviews_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_InterviewMentions_append_only" BEFORE UPDATE ON "InterviewMentions"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewResolutions_append_only" BEFORE UPDATE ON "InterviewResolutions"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewStatements_append_only" BEFORE UPDATE ON "InterviewStatements"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewEvidence_append_only" BEFORE UPDATE ON "InterviewEvidence"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewProposals_append_only" BEFORE UPDATE ON "InterviewProposals"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewReviewDecisions_append_only" BEFORE UPDATE ON "InterviewReviewDecisions"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
CREATE TRIGGER "trg_InterviewEvents_append_only" BEFORE UPDATE OR DELETE ON "InterviewEvents"
    FOR EACH ROW EXECUTE FUNCTION fg_interviews_append_only();
