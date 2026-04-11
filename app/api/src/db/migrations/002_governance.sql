-- Identity Atlas v5 — Governance schema (camelCase double-quoted identifiers)

CREATE TABLE "GovernanceCatalogs" (
    "id"                    UUID PRIMARY KEY,
    "systemId"              INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "displayName"           TEXT,
    "description"           TEXT,
    "catalogType"           TEXT,
    "enabled"               BOOLEAN,
    "isExternallyVisible"   BOOLEAN,
    "externalId"            TEXT,
    "createdDateTime"       TIMESTAMPTZ,
    "modifiedDateTime"      TIMESTAMPTZ,
    "extendedAttributes"    JSONB
);
CREATE INDEX "ix_GovernanceCatalogs_systemId" ON "GovernanceCatalogs"("systemId");

CREATE TABLE "AssignmentPolicies" (
    "id"                          UUID PRIMARY KEY,
    "systemId"                    INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "resourceId"                  UUID,
    "displayName"                 TEXT,
    "description"                 TEXT,
    "allowedTargetScope"          TEXT,
    "hasAutoAddRule"              BOOLEAN,
    "hasAutoRemoveRule"           BOOLEAN,
    "hasAccessReview"             BOOLEAN,
    "automaticRequestSettings"    JSONB,
    "reviewSettings"              JSONB,
    "policyConditions"            JSONB,
    "createdDateTime"             TIMESTAMPTZ,
    "modifiedDateTime"            TIMESTAMPTZ,
    "extendedAttributes"          JSONB
);
CREATE INDEX "ix_AP_systemId"   ON "AssignmentPolicies"("systemId");
CREATE INDEX "ix_AP_resourceId" ON "AssignmentPolicies"("resourceId");

CREATE TABLE "AssignmentRequests" (
    "id"                   UUID PRIMARY KEY,
    "systemId"             INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "resourceId"           UUID,
    "requestorId"          UUID,
    "requestor"            JSONB,
    "requestType"          TEXT,
    "requestState"         TEXT,
    "requestStatus"        TEXT,
    "isValidationOnly"     BOOLEAN,
    "justification"        TEXT,
    "schedule"             JSONB,
    "accessPackage"        JSONB,
    "syncBatchId"          UUID,
    "createdDateTime"      TIMESTAMPTZ,
    "completedDateTime"    TIMESTAMPTZ,
    "extendedAttributes"   JSONB
);
CREATE INDEX "ix_AR_resourceId"   ON "AssignmentRequests"("resourceId");
CREATE INDEX "ix_AR_requestorId"  ON "AssignmentRequests"("requestorId");
CREATE INDEX "ix_AR_state"        ON "AssignmentRequests"("requestState");

CREATE TABLE "CertificationDecisions" (
    "id"                              UUID PRIMARY KEY,
    "systemId"                        INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "resourceId"                      UUID,
    "principalId"                     UUID,
    "principalDisplayName"            TEXT,
    "reviewedResourceId"              UUID,
    "reviewedResourceDisplayName"     TEXT,
    "decision"                        TEXT,
    "recommendation"                  TEXT,
    "justification"                   TEXT,
    "reviewedBy"                      UUID,
    "reviewedByDisplayName"           TEXT,
    "reviewedDateTime"                TIMESTAMPTZ,
    "reviewDefinitionId"              UUID,
    "reviewInstanceId"                UUID,
    "reviewInstanceStatus"            TEXT,
    "reviewInstanceStartDateTime"     TIMESTAMPTZ,
    "reviewInstanceEndDateTime"       TIMESTAMPTZ,
    "extendedAttributes"              JSONB
);
CREATE INDEX "ix_CD_resourceId"  ON "CertificationDecisions"("resourceId");
CREATE INDEX "ix_CD_principalId" ON "CertificationDecisions"("principalId");

-- Tags + categories. The v4 names were 'GraphTags', 'GraphTagAssignments',
-- 'GovernanceCategories', 'GovernanceCategoryAssignments'. Kept verbatim
-- for v5 to minimise route changes.
CREATE TABLE "GraphTags" (
    "id"          SERIAL PRIMARY KEY,
    "name"        TEXT NOT NULL,
    "color"       TEXT NOT NULL,
    "entityType"  TEXT NOT NULL,
    "createdAt"   TIMESTAMPTZ DEFAULT (now() AT TIME ZONE 'utc'),
    UNIQUE ("name", "entityType")
);

CREATE TABLE "GraphTagAssignments" (
    "tagId"     INTEGER NOT NULL REFERENCES "GraphTags"("id") ON DELETE CASCADE,
    "entityId"  TEXT NOT NULL,
    PRIMARY KEY ("tagId", "entityId")
);
CREATE INDEX "ix_TagAssignments_entityId" ON "GraphTagAssignments"("entityId");

CREATE TABLE "GovernanceCategories" (
    "id"         SERIAL PRIMARY KEY,
    "name"       TEXT NOT NULL UNIQUE,
    "color"      TEXT NOT NULL,
    "createdAt"  TIMESTAMPTZ DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE "GovernanceCategoryAssignments" (
    "categoryId"  INTEGER NOT NULL REFERENCES "GovernanceCategories"("id") ON DELETE CASCADE,
    "resourceId"  TEXT NOT NULL,
    PRIMARY KEY ("categoryId", "resourceId")
);
CREATE INDEX "ix_CategoryAssignments_resourceId" ON "GovernanceCategoryAssignments"("resourceId");
