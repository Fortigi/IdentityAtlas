-- Identity Atlas — Account Linking (rebuilds the retired "Account Correlation").
--
-- 1. Rename the correlation* columns to link* on Identities + IdentityMembers.
--    Account linking attaches accounts to an existing Identity with a
--    confidence score; "link" is the accurate verb. Guarded so the migration
--    is safe to (re)apply.
-- 2. Drop the abandoned LLM ruleset table (GraphCorrelationRulesets) and replace
--    it with a deterministic, editable config table + a run-progress table,
--    mirroring the risk-scoring substrate (RiskClassifiers / ScoringRuns).
--
-- Orphan-ness is NOT modelled here as a property — the engine emits the
-- "Orphaned Accounts" generated Context instead. Identities.orphanStatus is
-- left in place for now and retired once the UI orphan filter moves to the
-- context (separate change).

-- ─── 1. Rename correlation* → link* ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'Identities' AND column_name = 'correlationConfidence') THEN
    ALTER TABLE "Identities" RENAME COLUMN "correlationConfidence" TO "linkConfidence";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'Identities' AND column_name = 'correlationSignals') THEN
    ALTER TABLE "Identities" RENAME COLUMN "correlationSignals" TO "linkSignals";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'Identities' AND column_name = 'correlatedAt') THEN
    ALTER TABLE "Identities" RENAME COLUMN "correlatedAt" TO "linkedAt";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'IdentityMembers' AND column_name = 'correlationSignals') THEN
    ALTER TABLE "IdentityMembers" RENAME COLUMN "correlationSignals" TO "linkSignals";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'IdentityMembers' AND column_name = 'signalConfidence') THEN
    ALTER TABLE "IdentityMembers" RENAME COLUMN "signalConfidence" TO "linkConfidence";
  END IF;
END $$;

-- ─── 2. Retire the LLM ruleset table ─────────────────────────────────────
DROP TABLE IF EXISTS "GraphCorrelationRulesets";

-- ─── 3. Deterministic config (the dictionary + schedules) ────────────────
CREATE TABLE IF NOT EXISTS "AccountLinkingConfig" (
  "id"         SERIAL PRIMARY KEY,
  "rules"      JSONB NOT NULL,
  "schedules"  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  "updatedBy"  TEXT
);

-- Scheduler reads this to find active configs that have at least one schedule.
CREATE INDEX IF NOT EXISTS "ix_AccountLinkingConfig_active"
  ON "AccountLinkingConfig" ("isActive")
  WHERE "isActive" = true AND jsonb_array_length("schedules") > 0;

-- ─── 4. Run progress / audit (mirrors ScoringRuns) ───────────────────────
CREATE TABLE IF NOT EXISTS "AccountLinkingRuns" (
  "id"                      BIGSERIAL PRIMARY KEY,
  "configId"                INTEGER REFERENCES "AccountLinkingConfig"("id") ON DELETE SET NULL,
  "status"                  TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  "step"                    TEXT,
  "pct"                     INT NOT NULL DEFAULT 0,
  "candidatesScanned"       INT NOT NULL DEFAULT 0,
  "linksCreated"            INT NOT NULL DEFAULT 0,
  "linksUpdated"            INT NOT NULL DEFAULT 0,
  "skippedAnalystOverride"  INT NOT NULL DEFAULT 0,
  "orphansRemaining"        INT,
  "errorMessage"            TEXT,
  "startedAt"               TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  "completedAt"             TIMESTAMPTZ,
  "triggeredBy"             TEXT
);
CREATE INDEX IF NOT EXISTS "ix_AccountLinkingRuns_status" ON "AccountLinkingRuns" ("status");
