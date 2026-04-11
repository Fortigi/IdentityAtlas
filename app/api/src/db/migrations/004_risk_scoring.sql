-- Identity Atlas v5 — Risk scoring schema (camelCase identifiers)

CREATE TABLE "GraphRiskProfiles" (
    "id"            SERIAL PRIMARY KEY,
    "profileJson"   JSONB NOT NULL,
    "generatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "generatedBy"   TEXT,
    "llmProvider"   TEXT,
    "llmModel"      TEXT,
    "version"       TEXT
);

CREATE TABLE "GraphRiskClassifiers" (
    "id"               SERIAL PRIMARY KEY,
    "classifiersJson"  JSONB NOT NULL,
    "generatedAt"      TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "generatedBy"      TEXT,
    "llmProvider"      TEXT,
    "llmModel"         TEXT,
    "version"          TEXT
);

CREATE TABLE "RiskScores" (
    "entityId"               UUID NOT NULL,
    "entityType"             TEXT NOT NULL,
    "riskScore"              INTEGER NOT NULL,
    "riskTier"               TEXT NOT NULL,
    "riskDirectScore"        INTEGER,
    "riskMembershipScore"    INTEGER,
    "riskStructuralScore"    INTEGER,
    "riskPropagatedScore"    INTEGER,
    "riskExplanation"        JSONB,
    "riskClassifierMatches"  JSONB,
    "riskOverride"           INTEGER,
    "riskOverrideReason"     TEXT,
    "riskScoredAt"           TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY ("entityId", "entityType")
);
CREATE INDEX "ix_RiskScores_riskTier"  ON "RiskScores"("riskTier");
CREATE INDEX "ix_RiskScores_riskScore" ON "RiskScores"("riskScore" DESC);

CREATE TABLE "GraphResourceClusters" (
    "id"                    UUID PRIMARY KEY,
    "clusterType"           TEXT NOT NULL,
    "name"                  TEXT NOT NULL,
    "description"           TEXT,
    "memberCount"           INTEGER NOT NULL DEFAULT 0,
    "avgRiskScore"          INTEGER,
    "maxRiskScore"          INTEGER,
    "ownerIdentityId"       UUID,
    "ownerAssignedBy"       TEXT,
    "ownerAssignedAt"       TIMESTAMPTZ,
    "metadata"              JSONB,
    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX "ix_Clusters_type"  ON "GraphResourceClusters"("clusterType");
CREATE INDEX "ix_Clusters_owner" ON "GraphResourceClusters"("ownerIdentityId");

CREATE TABLE "GraphResourceClusterMembers" (
    "clusterId"            UUID NOT NULL REFERENCES "GraphResourceClusters"("id") ON DELETE CASCADE,
    "resourceId"           UUID NOT NULL,
    "resourceDisplayName"  TEXT,
    "resourceRiskScore"    INTEGER,
    PRIMARY KEY ("clusterId", "resourceId")
);
CREATE INDEX "ix_ClusterMembers_resourceId" ON "GraphResourceClusterMembers"("resourceId");

CREATE TABLE "GraphCorrelationRulesets" (
    "id"           TEXT PRIMARY KEY,
    "rulesetJson"  JSONB NOT NULL,
    "version"      TEXT,
    "generatedAt"  TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
