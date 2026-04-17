-- Add scheduling support to risk scoring classifiers.
--
-- This migration adds a `schedules` JSONB column to RiskClassifiers to support
-- automatic scheduled re-scoring (similar to crawler scheduling). The scheduler
-- (scheduler.js) polls this table and queues scoring runs when schedules match.
--
-- Schedule shape (same as CrawlerConfigs):
--   [{ enabled: true, frequency: 'daily'|'hourly'|'weekly',
--      hour: 0-23, minute: 0-59, day?: 0-6 }]

ALTER TABLE "RiskClassifiers"
  ADD COLUMN IF NOT EXISTS "schedules" jsonb DEFAULT '[]'::jsonb;

-- Index for scheduler queries (only checks active classifiers with schedules)
CREATE INDEX IF NOT EXISTS "ix_RiskClassifiers_schedules"
  ON "RiskClassifiers" ("isActive")
  WHERE "isActive" = true AND jsonb_array_length("schedules") > 0;
