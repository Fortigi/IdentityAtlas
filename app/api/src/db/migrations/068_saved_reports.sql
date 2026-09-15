-- Identity Atlas — Saved reports (PROTOTYPE: natural-language / custom reports)
--
-- A saved report is a validated report definition (see api/src/nlreports/spec.js)
-- plus a name. It is compiled to SQL at run time, so a saved report always runs
-- against the current catalog and the latest data — nothing is snapshotted.
--
-- Org-wide, like SavedMatrixFilters: every analyst can list, run, edit and
-- delete every saved report. Names are unique case-insensitively.

CREATE TABLE "SavedReports" (
    "id"          UUID PRIMARY KEY,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "definition"  JSONB NOT NULL,
    "question"    TEXT,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedBy"   TEXT,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE UNIQUE INDEX "ix_SavedReports_name" ON "SavedReports" (LOWER("name"));
