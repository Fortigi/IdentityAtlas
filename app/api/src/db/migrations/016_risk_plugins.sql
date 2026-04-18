-- Risk scoring plugin architecture.
--
-- Adds support for external risk scoring tools (BloodHound CE, custom HTTP APIs,
-- etc.) that contribute scores to the existing 4-layer engine as a 5th weighted
-- component. Plugins are registered, configured, and toggled from the Admin UI.
--
-- Plugin API keys are stored in the Secrets vault (envelope-encrypted), not in
-- this table. The secretId column is a convention-based reference.

-- ─── Plugin registration ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RiskPlugins" (
  "id"              bigserial PRIMARY KEY,
  "pluginType"      text NOT NULL,                -- 'bloodhound-ce' | 'http-api'
  "displayName"     text NOT NULL,
  "description"     text,
  "endpointUrl"     text,                         -- base URL for the plugin API
  "secretId"        text,                         -- vault reference (scope 'plugin')
  "config"          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- plugin-specific settings
  "defaultWeight"   numeric(3,2) NOT NULL DEFAULT 0.15,  -- contribution to final score
  "enabled"         boolean NOT NULL DEFAULT false,
  "healthStatus"    text NOT NULL DEFAULT 'unknown',     -- 'healthy' | 'unhealthy' | 'unknown'
  "lastHealthCheck" timestamptz,
  "lastSyncAt"      timestamptz,                  -- last data export / score fetch
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now()
);

-- ─── Raw scores from each plugin per entity ──────────────────────────
-- Kept separate from RiskScores so we can attribute which plugin contributed
-- what, and so the engine can aggregate across multiple plugins.
CREATE TABLE IF NOT EXISTS "RiskPluginScores" (
  "pluginId"    bigint NOT NULL REFERENCES "RiskPlugins"(id) ON DELETE CASCADE,
  "entityId"    uuid NOT NULL,
  "entityType"  text NOT NULL,                    -- 'Principal' | 'Resource'
  "score"       integer NOT NULL,                 -- 0-100 normalised
  "rawScore"    numeric,                          -- original score from the plugin
  "explanation" jsonb,                            -- plugin-specific detail
  "scoredAt"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("pluginId", "entityId", "entityType")
);

CREATE INDEX IF NOT EXISTS "ix_RiskPluginScores_entity"
  ON "RiskPluginScores" ("entityId", "entityType");

-- ─── Extend RiskScores with external component ───────────────────────
ALTER TABLE "RiskScores"
  ADD COLUMN IF NOT EXISTS "riskExternalScore" integer DEFAULT 0;
