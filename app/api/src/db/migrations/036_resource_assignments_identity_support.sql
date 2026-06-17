-- Identity Atlas — add identity-level assignment support to ResourceAssignments.
--
-- Allows IGA crawlers to assign any access to a person rather than a specific
-- account (Principal). Both assignment targets remain valid simultaneously.
--
-- Changes:
--   1. Drop the composite PK (includes principalId which becomes nullable)
--   2. Make principalId nullable
--   3. Add identityId — bare UUID, no FK (symmetric with principalId)
--   4. XOR CHECK: exactly one of principalId / identityId must be non-null
--   5. Two partial unique indexes replace the composite PK
--   6. Supporting index for identity-side lookups
--
-- No data migration needed: existing rows have principalId set and identityId
-- NULL, which satisfies the XOR CHECK (principalId IS NOT NULL ∧ identityId IS
-- NULL → sum = 1). Brief exclusive lock on startup before API traffic arrives.

-- 1. Drop the existing PK (it includes principalId which will become nullable)
ALTER TABLE "ResourceAssignments"
    DROP CONSTRAINT "ResourceAssignments_pkey";

-- 2. Make principalId nullable
ALTER TABLE "ResourceAssignments"
    ALTER COLUMN "principalId" DROP NOT NULL;

-- 3. Add identityId column — bare UUID, no FK (symmetric with principalId).
--    Both columns rely on the crawler ordering contract for data integrity.
--    A FK + CASCADE can be added in a later migration once principalId also
--    gets a FK, making the two columns consistent.
ALTER TABLE "ResourceAssignments"
    ADD COLUMN "identityId" UUID;

-- 4. Enforce: exactly one of principalId / identityId must be non-null
ALTER TABLE "ResourceAssignments"
    ADD CONSTRAINT "ck_RA_principal_or_identity"
    CHECK (
        ("principalId" IS NOT NULL)::int + ("identityId" IS NOT NULL)::int = 1
    );

-- 5. Recreate uniqueness as two partial unique indexes (replaces the PK)
CREATE UNIQUE INDEX "uq_RA_principal"
    ON "ResourceAssignments"("resourceId", "principalId", "assignmentType")
    WHERE "principalId" IS NOT NULL;

CREATE UNIQUE INDEX "uq_RA_identity"
    ON "ResourceAssignments"("resourceId", "identityId", "assignmentType")
    WHERE "identityId" IS NOT NULL;

-- 6. Supporting index for identity-side lookups
CREATE INDEX "ix_RA_identityId"
    ON "ResourceAssignments"("identityId")
    WHERE "identityId" IS NOT NULL;
