-- Identity Atlas — Context uploads (docs/architecture/context-upload.md)
--
-- An analyst can upload a list of their own (customers, an application register)
-- as a context tree. Each list is a source system (systemType 'Upload'); its
-- contexts are ordinary synced contexts of that system, written through the
-- ingest. What a crawler does not have is the upload run itself: who uploaded
-- which file, when, with which mapping, and what it changed. One row per run.

CREATE TABLE "ContextUploads" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "systemId"         INTEGER NOT NULL REFERENCES "Systems"("id") ON DELETE CASCADE,
    "rootContextId"    UUID REFERENCES "Contexts"("id") ON DELETE SET NULL,
    "fileName"         TEXT NOT NULL,
    "template"         TEXT NOT NULL CHECK ("template" IN ('OrganizationalUnit', 'LogicalApplication')),
    "keyColumn"        TEXT NOT NULL,
    "mapping"          JSONB NOT NULL,
    "rowCount"         INTEGER NOT NULL DEFAULT 0,
    "created"          INTEGER NOT NULL DEFAULT 0,
    "updated"          INTEGER NOT NULL DEFAULT 0,
    "unchanged"        INTEGER NOT NULL DEFAULT 0,
    "removed"          INTEGER NOT NULL DEFAULT 0,
    "unmatchedMembers" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy"       TEXT,
    "uploadedAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The context page reads the first and the latest upload of its list.
CREATE INDEX "ix_ContextUploads_system" ON "ContextUploads" ("systemId", "uploadedAt");

-- Member matching (and the synced-owner reconcile, ingest/contextOwners.js)
-- compare e-mail addresses case-insensitively; ix_Principals_email (migration
-- 001) is on the raw value and cannot serve lower(email).
CREATE INDEX IF NOT EXISTS "ix_Principals_email_lower" ON "Principals" (lower("email"));
CREATE INDEX IF NOT EXISTS "ix_Identities_email_lower" ON "Identities" (lower("email"));
