-- Identity Atlas v5 — Core schema (Universal Resource Model)
--
-- Postgres replacement for the v4 SQL Server schema. We keep camelCase
-- identifiers (using double quotes) so the existing SQL queries in route
-- handlers continue to work with minimal changes. This is uglier than
-- snake_case in postgres but dramatically reduces v4→v5 migration risk.
--
-- No temporal tables. The v4 history tables were dropped — postgres has no
-- native equivalent and the feature was unused in practice.
--
-- All UUIDs use postgres native `uuid` type. Timestamps use `timestamptz`.

-- ─── Systems ──────────────────────────────────────────────────────────────
CREATE TABLE "Systems" (
    "id"                  SERIAL PRIMARY KEY,
    "systemType"          TEXT NOT NULL,
    "displayName"         TEXT NOT NULL,
    "description"         TEXT,
    "enabled"             BOOLEAN NOT NULL DEFAULT TRUE,
    "syncEnabled"         BOOLEAN NOT NULL DEFAULT TRUE,
    "tenantId"            TEXT,
    "lastSyncDateTime"    TIMESTAMPTZ,
    "resourceTypes"       JSONB,
    "assignmentTypes"     JSONB,
    "extendedAttributes"  JSONB
);
CREATE INDEX "ix_Systems_systemType" ON "Systems"("systemType");

-- ─── SystemOwners ────────────────────────────────────────────────────────
CREATE TABLE "SystemOwners" (
    "systemId"  INTEGER NOT NULL REFERENCES "Systems"("id") ON DELETE CASCADE,
    "userId"    UUID NOT NULL,
    PRIMARY KEY ("systemId", "userId")
);

-- ─── WorkerConfig — generic key/value for runtime settings ───────────────
CREATE TABLE "WorkerConfig" (
    "configKey"   TEXT PRIMARY KEY,
    "configValue" TEXT NOT NULL,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

-- ─── Resources ───────────────────────────────────────────────────────────
-- Anything that grants access. resourceType distinguishes groups, directory
-- roles, app roles, business roles (governance), SharePoint sites, etc.
CREATE TABLE "Resources" (
    "id"                  UUID PRIMARY KEY,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "displayName"         TEXT,
    "description"         TEXT,
    "resourceType"        TEXT,
    "mail"                TEXT,
    "visibility"          TEXT,
    "enabled"             BOOLEAN,
    "externalId"          TEXT,
    "contextId"           UUID,
    "catalogId"           UUID,
    "isHidden"            BOOLEAN DEFAULT FALSE,
    "createdDateTime"     TIMESTAMPTZ,
    "modifiedDateTime"    TIMESTAMPTZ,
    "extendedAttributes"  JSONB,
    "riskScore"           INTEGER,
    "riskTier"            TEXT
);
CREATE INDEX "ix_Resources_systemId"    ON "Resources"("systemId");
CREATE INDEX "ix_Resources_resourceType" ON "Resources"("resourceType");
CREATE INDEX "ix_Resources_catalogId"   ON "Resources"("catalogId");
CREATE INDEX "ix_Resources_contextId"   ON "Resources"("contextId");
CREATE INDEX "ix_Resources_externalId"  ON "Resources"("systemId", "externalId");

-- ─── Principals ──────────────────────────────────────────────────────────
CREATE TABLE "Principals" (
    "id"                  UUID PRIMARY KEY,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "displayName"         TEXT,
    "email"               TEXT,
    "principalType"       TEXT,
    "accountEnabled"      BOOLEAN,
    "givenName"           TEXT,
    "surname"             TEXT,
    "department"          TEXT,
    "jobTitle"            TEXT,
    "companyName"         TEXT,
    "employeeId"          TEXT,
    "managerId"           UUID,
    "contextId"           UUID,
    "externalId"          TEXT,
    "createdDateTime"     TIMESTAMPTZ,
    "extendedAttributes"  JSONB,
    "riskScore"           INTEGER,
    "riskTier"            TEXT
);
CREATE INDEX "ix_Principals_systemId"      ON "Principals"("systemId");
CREATE INDEX "ix_Principals_principalType" ON "Principals"("principalType");
CREATE INDEX "ix_Principals_email"         ON "Principals"("email");
CREATE INDEX "ix_Principals_employeeId"    ON "Principals"("employeeId");
CREATE INDEX "ix_Principals_contextId"     ON "Principals"("contextId");

-- ─── ResourceAssignments ─────────────────────────────────────────────────
CREATE TABLE "ResourceAssignments" (
    "resourceId"          UUID NOT NULL,
    "principalId"         UUID NOT NULL,
    "assignmentType"      TEXT NOT NULL,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "principalType"       TEXT,
    "complianceState"     TEXT,
    "policyId"            UUID,
    "state"               TEXT,
    "assignmentStatus"    TEXT,
    "expirationDateTime"  TIMESTAMPTZ,
    "extendedAttributes"  JSONB,
    PRIMARY KEY ("resourceId", "principalId", "assignmentType")
);
CREATE INDEX "ix_RA_resourceId"     ON "ResourceAssignments"("resourceId");
CREATE INDEX "ix_RA_principalId"    ON "ResourceAssignments"("principalId");
CREATE INDEX "ix_RA_systemId"       ON "ResourceAssignments"("systemId");
CREATE INDEX "ix_RA_assignmentType" ON "ResourceAssignments"("assignmentType");

-- ─── ResourceRelationships ───────────────────────────────────────────────
CREATE TABLE "ResourceRelationships" (
    "parentResourceId"    UUID NOT NULL,
    "childResourceId"     UUID NOT NULL,
    "relationshipType"    TEXT NOT NULL,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "roleName"            TEXT,
    "roleOriginSystem"    TEXT,
    "extendedAttributes"  JSONB,
    PRIMARY KEY ("parentResourceId", "childResourceId", "relationshipType")
);
CREATE INDEX "ix_RR_parent" ON "ResourceRelationships"("parentResourceId");
CREATE INDEX "ix_RR_child"  ON "ResourceRelationships"("childResourceId");
CREATE INDEX "ix_RR_system" ON "ResourceRelationships"("systemId");

-- ─── Contexts ─────────────────────────────────────────────────────────────
CREATE TABLE "Contexts" (
    "id"                  UUID PRIMARY KEY,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "contextType"         TEXT,
    "displayName"         TEXT,
    "department"          TEXT,
    "costCenter"          TEXT,
    "division"            TEXT,
    "officeLocation"      TEXT,
    "parentContextId"     UUID,
    "managerId"           UUID,
    "managerIdentityId"   UUID,
    "sourceType"          TEXT,
    "memberCount"         INTEGER,
    "totalMemberCount"    INTEGER,
    "lastCalculatedAt"    TIMESTAMPTZ,
    "extendedAttributes"  JSONB
);
CREATE INDEX "ix_Contexts_systemId"    ON "Contexts"("systemId");
CREATE INDEX "ix_Contexts_contextType" ON "Contexts"("contextType");
CREATE INDEX "ix_Contexts_parent"      ON "Contexts"("parentContextId");

-- ─── Identities ──────────────────────────────────────────────────────────
CREATE TABLE "Identities" (
    "id"                       UUID PRIMARY KEY,
    "displayName"              TEXT,
    "email"                    TEXT,
    "givenName"                TEXT,
    "surname"                  TEXT,
    "employeeId"               TEXT,
    "department"               TEXT,
    "jobTitle"                 TEXT,
    "companyName"              TEXT,
    "city"                     TEXT,
    "country"                  TEXT,
    "officeLocation"           TEXT,
    "primaryPrincipalId"       UUID,
    "managerIdentityId"        UUID,
    "contextId"                UUID,
    "isHrAnchored"             BOOLEAN,
    "hrAccountId"              TEXT,
    "accountCount"             INTEGER,
    "accountTypes"             JSONB,
    "correlationSignals"       JSONB,
    "correlationConfidence"    INTEGER,
    "correlatedAt"             TIMESTAMPTZ,
    "orphanStatus"             TEXT,
    "analystVerified"          BOOLEAN,
    "analystNotes"             TEXT
);
CREATE INDEX "ix_Identities_employeeId" ON "Identities"("employeeId");
CREATE INDEX "ix_Identities_email"      ON "Identities"("email");
CREATE INDEX "ix_Identities_contextId"  ON "Identities"("contextId");

-- ─── IdentityMembers ─────────────────────────────────────────────────────
CREATE TABLE "IdentityMembers" (
    "identityId"           UUID NOT NULL REFERENCES "Identities"("id") ON DELETE CASCADE,
    "principalId"          UUID NOT NULL,
    "isPrimary"            BOOLEAN,
    "isHrAuthoritative"    BOOLEAN,
    "accountType"          TEXT,
    "accountTypePattern"   TEXT,
    "accountEnabled"       BOOLEAN,
    "displayName"          TEXT,
    "correlationSignals"   JSONB,
    "signalConfidence"     INTEGER,
    "hrScore"              INTEGER,
    "hrIndicators"         JSONB,
    "analystOverride"      TEXT,
    PRIMARY KEY ("identityId", "principalId")
);
CREATE INDEX "ix_IM_principalId" ON "IdentityMembers"("principalId");
