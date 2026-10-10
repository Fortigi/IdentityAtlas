-- Identity Atlas — Analytics Profiles (Feature 2, Phase 1).
--
-- An Analytics Profile records which reporting dimensions an installation
-- reports on and which dimension combinations (datasets) the analytics API
-- serves. Installation-scoped: one database is one tenant, so there is no
-- tenant column. See docs/architecture/analytics-profiles.md.
--
-- Two tables:
--   * "AnalyticsProfiles"        — the current definition, one row per profile.
--   * "AnalyticsProfileVersions" — every saved definition, append-only and never
--                                  pruned, so a number produced under version N
--                                  can always be traced back to what N said.
--                                  (_history would also capture the rows, but it
--                                  is pruned after HISTORY_RETENTION_DAYS.)
--
-- Nothing else reads or writes these tables; existing screens are unaffected.

CREATE TABLE IF NOT EXISTS "AnalyticsProfiles" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "status"      TEXT NOT NULL DEFAULT 'active',
    "version"     INTEGER NOT NULL DEFAULT 1,
    "definition"  JSONB NOT NULL,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy"   TEXT,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_AnalyticsProfiles_status" CHECK ("status" IN ('active', 'retired')),
    CONSTRAINT "ck_AnalyticsProfiles_version" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_AnalyticsProfiles_name"
    ON "AnalyticsProfiles" (lower("name"));

CREATE TABLE IF NOT EXISTS "AnalyticsProfileVersions" (
    "profileId"  UUID NOT NULL REFERENCES "AnalyticsProfiles"("id") ON DELETE CASCADE,
    "version"    INTEGER NOT NULL,
    "name"       TEXT NOT NULL,
    "status"     TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "changedBy"  TEXT,
    "changedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("profileId", "version")
);
