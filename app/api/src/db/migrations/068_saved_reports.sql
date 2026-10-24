-- Identity Atlas — Saved reports (custom reports, experimental feature `customReports`)
--
-- A saved report is a validated report definition (see api/src/nlreports/spec.js)
-- plus a name. It is compiled to SQL at run time, so a saved report always runs
-- against the current catalog and the latest data — nothing is snapshotted.
--
-- Shared across the deployment, like SavedMatrixFilters: everyone who can read
-- data can list and run every saved report; creating, changing and deleting one
-- needs the data.write.reports permission. Names are unique case-insensitively.
-- createdBy / updatedBy record who built and last changed a report; the Reports
-- page shows them.

CREATE TABLE "SavedReports" (
    "id"          UUID PRIMARY KEY,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "definition"  JSONB NOT NULL,
    "question"    TEXT,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy"   TEXT,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ix_SavedReports_name" ON "SavedReports" (LOWER("name"));
