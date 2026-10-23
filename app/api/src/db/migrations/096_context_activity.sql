-- Identity Atlas — Context activity (docs/architecture/context-activity.md)
--
-- An analyst can upload an activity export — a time registration (hours per
-- person per customer), an audit log of a document library — onto a context,
-- also onto the root of a tree, so each row lands on the matching child. An
-- activity row is EVIDENCE of who works on what: an observation that a subject
-- did an amount of activity on a context on a date, from a source. It is not
-- access (only ResourceAssignments hold access) and not membership (only
-- ContextMembers say who belongs to a context). Nothing here changes either.
--
-- One ContextActivityUploads row per upload run; its rows in ContextActivity.
-- Re-upload: a new upload for the same context and source label replaces the
-- rows of earlier uploads whose activityDate falls in the new file's
-- [periodStart, periodEnd] — the service deletes those before inserting, in
-- one transaction, so an overlapping export is never counted twice.

CREATE TABLE "ContextActivityUploads" (
    "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"     UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    "fileName"      TEXT NOT NULL,
    "sourceLabel"   TEXT NOT NULL,
    "mapping"       JSONB NOT NULL,
    "periodStart"   DATE,
    "periodEnd"     DATE,
    "rowCount"      INTEGER NOT NULL DEFAULT 0,
    "matchedRows"   INTEGER NOT NULL DEFAULT 0,
    "unmatchedRows" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy"    TEXT,
    "uploadedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The upload history of a context, and the replace step's lookup of earlier
-- uploads of the same context and source.
CREATE INDEX "ix_ContextActivityUploads_context" ON "ContextActivityUploads" ("contextId", "uploadedAt");

CREATE TABLE "ContextActivity" (
    "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "uploadId"     UUID NOT NULL REFERENCES "ContextActivityUploads"("id") ON DELETE CASCADE,
    "contextId"    UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    -- The subject as resolved at upload time; both stay NULL for a name that
    -- matched nobody ("active, unknown person"). An account or person removed
    -- later leaves the observation, with its raw name (SET NULL).
    "principalId"  UUID REFERENCES "Principals"("id") ON DELETE SET NULL,
    "identityId"   UUID REFERENCES "Identities"("id") ON DELETE SET NULL,
    "subjectName"  TEXT,
    "subjectEmail" TEXT,
    "activityDate" DATE NOT NULL,
    "amount"       NUMERIC NOT NULL,
    "unit"         TEXT NOT NULL,
    "kind"         TEXT,
    "attributes"   JSONB
);
CREATE INDEX "ix_ContextActivity_context_date" ON "ContextActivity" ("contextId", "activityDate");
CREATE INDEX "ix_ContextActivity_principal" ON "ContextActivity" ("principalId");
CREATE INDEX "ix_ContextActivity_upload" ON "ContextActivity" ("uploadId", "activityDate");
