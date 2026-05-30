-- Identity Atlas — Saved matrix filters
--
-- Backs the new wizard-driven Matrix tab. A saved filter captures the full
-- subject/resource selection (rowType + include/exclude conditions) so an
-- analyst can return to the same view later or share it with the team.
--
-- Org-wide visibility: every signed-in analyst can list, load, rename, and
-- delete every saved filter. Name uniqueness (case-insensitive) is enforced
-- so accidental "Untitled" duplicates don't pile up.

CREATE TABLE "SavedMatrixFilters" (
    "id"          UUID PRIMARY KEY,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "filter"      JSONB NOT NULL,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedBy"   TEXT,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE UNIQUE INDEX "ix_SavedMatrixFilters_name" ON "SavedMatrixFilters" (LOWER("name"));
CREATE INDEX "ix_SavedMatrixFilters_updatedAt" ON "SavedMatrixFilters" ("updatedAt" DESC);
