-- Identity Atlas — Default matrix filter
--
-- Adds an isDefault flag to SavedMatrixFilters so that a single org-wide
-- filter can be auto-applied when the Matrix tab is first visited (e.g. after
-- loading the demo dataset). At most one row may have isDefault = true,
-- enforced by a unique partial index.

ALTER TABLE "SavedMatrixFilters" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "ix_SavedMatrixFilters_isDefault"
  ON "SavedMatrixFilters" ("isDefault") WHERE "isDefault" = true;
