-- Track when a DictionaryClassifierLink has been applied to the active classifier.
-- appliedAt IS NULL  → approved but not yet applied
-- appliedAt IS NOT NULL → patterns have been merged into a RiskClassifiers version

ALTER TABLE "DictionaryClassifierLinks"
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "ix_DictionaryClassifierLinks_unapplied"
  ON "DictionaryClassifierLinks" ("status", "appliedAt")
  WHERE "status" = 'approved' AND "appliedAt" IS NULL;
