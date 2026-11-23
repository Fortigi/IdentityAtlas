-- 114: who answers for a business role
--
-- Accountable: at most one per role. Responsible: any number. The holder is an
-- account or a person, exactly one, as on "ContextRoles" (migration 095).
--
-- A table of its own rather than an edge in the core graph: being accountable
-- for a role is not holding it. Access runs through "ResourceAssignments" only,
-- so nothing here can ever read as access.
--
-- addedBy says who put the row there:
--   sync     a crawler stated it; replaces only an earlier sync row
--   import   an uploaded list; replaces a sync or import row, never an analyst's
--   analyst  a person chose it; nothing automatic replaces it

CREATE TABLE "BusinessRoleOwners" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "resourceId"  UUID NOT NULL REFERENCES "Resources"("id")  ON DELETE CASCADE,
    "principalId" UUID          REFERENCES "Principals"("id") ON DELETE CASCADE,
    "identityId"  UUID          REFERENCES "Identities"("id") ON DELETE CASCADE,
    "role"        TEXT NOT NULL CHECK ("role" IN ('Accountable', 'Responsible')),
    "addedBy"     TEXT NOT NULL CHECK ("addedBy" IN ('sync', 'import', 'analyst')),
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_BusinessRoleOwners_one_holder" CHECK (("principalId" IS NULL) <> ("identityId" IS NULL))
);
CREATE UNIQUE INDEX "ux_BusinessRoleOwners_principal" ON "BusinessRoleOwners" ("resourceId", "principalId", "role") WHERE "principalId" IS NOT NULL;
CREATE UNIQUE INDEX "ux_BusinessRoleOwners_identity"  ON "BusinessRoleOwners" ("resourceId", "identityId",  "role") WHERE "identityId"  IS NOT NULL;
CREATE UNIQUE INDEX "ux_BusinessRoleOwners_accountable" ON "BusinessRoleOwners" ("resourceId") WHERE "role" = 'Accountable';
CREATE INDEX "ix_BusinessRoleOwners_principal" ON "BusinessRoleOwners" ("principalId");
CREATE INDEX "ix_BusinessRoleOwners_identity"  ON "BusinessRoleOwners" ("identityId");

-- A suggestion someone turned down is not offered again for that role.
CREATE TABLE "BusinessRoleOwnerRejections" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "resourceId"  UUID NOT NULL REFERENCES "Resources"("id")  ON DELETE CASCADE,
    "principalId" UUID NOT NULL REFERENCES "Principals"("id") ON DELETE CASCADE,
    "role"        TEXT NOT NULL CHECK ("role" IN ('Accountable', 'Responsible')),
    "rejectedBy"  TEXT,
    "rejectedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("resourceId", "principalId", "role")
);
CREATE INDEX "ix_BusinessRoleOwnerRejections_principal" ON "BusinessRoleOwnerRejections" ("principalId");
