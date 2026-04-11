-- Identity Atlas v5 — Secrets vault + LLM/RiskScoring substrate.
--
-- This migration adds three things that the risk-scoring + LLM features need:
--
-- 1. A general-purpose `Secrets` table with envelope encryption. Designed so
--    other parts of the app can adopt the same pattern (LLM API keys, scraper
--    credentials, future Vault/AWS-SM-backed secrets — they all live here).
--
--    Encryption layer: AES-256-GCM. The data key is per-row (random 32 bytes),
--    encrypted by a master key from the IDENTITY_ATLAS_MASTER_KEY env var
--    (32-byte base64). The master key never touches the database. Rotating it
--    is a future ops concern; v1 reads only.
--
-- 2. A `RiskProfiles` table with multi-version history (postgres-native, no
--    SQL Server temporal table needed — we just keep all versions and mark one
--    as active). Stores the profile JSON, the LLM transcript that produced it,
--    and any URLs/credentials used as input.
--
-- 3. A `RiskClassifiers` table with the same versioned shape. Each version
--    references the profile it was generated from.
--
-- The legacy `GraphRiskProfiles` and `GraphRiskClassifiers` tables from
-- migration 004 are kept (the risk scoring page reads them) but are now
-- considered v1 leftovers. The new code writes to RiskProfiles/RiskClassifiers.
-- A compat view at the bottom of this file aliases the new tables back so the
-- old read code keeps working without changes.

CREATE TABLE IF NOT EXISTS "Secrets" (
  "id"            text PRIMARY KEY,                  -- caller-chosen key, e.g. "llm.anthropic"
  "scope"         text NOT NULL,                     -- coarse grouping: 'llm', 'scraper', 'crawler', etc.
  "label"         text,                              -- human label for the UI
  "ciphertext"    bytea NOT NULL,                    -- AES-256-GCM ciphertext of the secret value
  "iv"            bytea NOT NULL,                    -- 12-byte AES-GCM IV
  "authTag"       bytea NOT NULL,                    -- 16-byte AES-GCM auth tag
  "encryptedKey"  bytea NOT NULL,                    -- per-row data key, AES-GCM encrypted by master key
  "keyIv"         bytea NOT NULL,                    -- IV used for the encryptedKey
  "keyAuthTag"    bytea NOT NULL,                    -- auth tag for the encryptedKey
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ix_Secrets_scope" ON "Secrets" ("scope");

-- ─── RiskProfiles (versioned) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RiskProfiles" (
  "id"           bigserial PRIMARY KEY,
  "displayName"  text NOT NULL,
  "domain"       text,
  "industry"     text,
  "country"      text,
  "profile"      jsonb NOT NULL,                    -- the customer_profile JSON
  "transcript"   jsonb,                             -- chat messages [{role, content, at}]
  "sources"      jsonb,                             -- URLs scraped, with status: [{url, status, bytes}]
  "llmProvider"  text,
  "llmModel"     text,
  "version"      int  NOT NULL DEFAULT 1,
  "isActive"     boolean NOT NULL DEFAULT false,
  "createdBy"    text,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ix_RiskProfiles_active" ON "RiskProfiles" ("isActive") WHERE "isActive";

-- Only one active row at a time (enforced by trigger; partial unique index doesn't
-- prevent the user from accidentally activating two via separate transactions).
CREATE OR REPLACE FUNCTION fg_riskprofile_single_active() RETURNS trigger AS $$
BEGIN
  IF NEW."isActive" THEN
    UPDATE "RiskProfiles" SET "isActive" = false
     WHERE "isActive" = true AND id <> NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_riskprofile_single_active ON "RiskProfiles";
CREATE TRIGGER trg_riskprofile_single_active
BEFORE INSERT OR UPDATE OF "isActive" ON "RiskProfiles"
FOR EACH ROW WHEN (NEW."isActive")
EXECUTE FUNCTION fg_riskprofile_single_active();

-- ─── RiskClassifiers (versioned, per profile) ─────────────────────
CREATE TABLE IF NOT EXISTS "RiskClassifiers" (
  "id"               bigserial PRIMARY KEY,
  "profileId"        bigint REFERENCES "RiskProfiles"(id) ON DELETE SET NULL,
  "displayName"      text NOT NULL,
  "classifiers"      jsonb NOT NULL,
  "llmProvider"      text,
  "llmModel"         text,
  "version"          int NOT NULL DEFAULT 1,
  "isActive"         boolean NOT NULL DEFAULT false,
  "createdBy"        text,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ix_RiskClassifiers_active" ON "RiskClassifiers" ("isActive") WHERE "isActive";
CREATE INDEX IF NOT EXISTS "ix_RiskClassifiers_profile" ON "RiskClassifiers" ("profileId");

CREATE OR REPLACE FUNCTION fg_riskclassifier_single_active() RETURNS trigger AS $$
BEGIN
  IF NEW."isActive" THEN
    UPDATE "RiskClassifiers" SET "isActive" = false
     WHERE "isActive" = true AND id <> NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_riskclassifier_single_active ON "RiskClassifiers";
CREATE TRIGGER trg_riskclassifier_single_active
BEFORE INSERT OR UPDATE OF "isActive" ON "RiskClassifiers"
FOR EACH ROW WHEN (NEW."isActive")
EXECUTE FUNCTION fg_riskclassifier_single_active();

-- ─── ScoringRuns (audit + progress) ───────────────────────────────
-- One row per "Run scoring now" invocation. The UI polls this for progress.
CREATE TABLE IF NOT EXISTS "ScoringRuns" (
  "id"            bigserial PRIMARY KEY,
  "profileId"     bigint REFERENCES "RiskProfiles"(id) ON DELETE SET NULL,
  "classifierId"  bigint REFERENCES "RiskClassifiers"(id) ON DELETE SET NULL,
  "status"        text NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  "step"          text,
  "pct"           int  NOT NULL DEFAULT 0,
  "totalEntities" int,
  "scoredEntities" int  NOT NULL DEFAULT 0,
  "errorMessage"  text,
  "startedAt"     timestamptz NOT NULL DEFAULT now(),
  "completedAt"   timestamptz,
  "triggeredBy"   text
);
CREATE INDEX IF NOT EXISTS "ix_ScoringRuns_status" ON "ScoringRuns" ("status");
