-- Identity Atlas — Context templates, roles and relationships (phase B)
--
-- The ontology (ontology/core.ttl 2.x) groups every contextType under one of
-- four templates: OrganizationalUnit, LogicalApplication, Tag, Segment. This
-- migration makes the template a column, gives an organizational unit and a
-- logical application the people who answer for them, lets two contexts be
-- linked as variants of one unit (its people, its accounts, its resources), and retires the six root
-- context types: a root is simply a context without a parent.
-- Design: docs/architecture/context-templates-phase-b.md.
--
-- Nothing here touches ResourceAssignments or assignmentType. A role on a
-- context is a context→person link, never access.

-- ─── 1. The template, as a column ────────────────────────────────────────────
-- Nullable on purpose: a synced value nobody has placed under a template yet is
-- still readable and shows under "Other". The plugin runner and the API always
-- set it for what they write.
ALTER TABLE "Contexts"
  ADD COLUMN "contextCategory" TEXT
    CHECK ("contextCategory" IN ('OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment'));

-- ─── 2. Root context types retire ────────────────────────────────────────────
-- The root of a plugin tree takes its children's type. Trees are recognised by
-- the plugin that made them (sourceAlgorithmId), not by a root type, so no
-- information is lost. The tags root keeps a marker instead of its own type:
-- the tags routes find it by that marker and the GraphTags view leaves it out.
UPDATE "Contexts" SET "contextType" = 'PrincipalType'      WHERE "contextType" = 'PrincipalTypeRoot';
UPDATE "Contexts" SET "contextType" = 'ResourceType'       WHERE "contextType" = 'ResourceTypeRoot';
UPDATE "Contexts" SET "contextType" = 'EntraGroupCategory' WHERE "contextType" = 'EntraGroupRoot';
UPDATE "Contexts" SET "contextType" = 'SystemMembership'   WHERE "contextType" = 'SystemMembershipRoot';
UPDATE "Contexts" SET "contextType" = 'Scope'              WHERE "contextType" = 'ScopeHierarchy';
UPDATE "Contexts"
   SET "contextType"        = 'Tag',
       "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb) || '{"tagRoot": true}'::jsonb
 WHERE "contextType" = 'TagGroup';

-- The scope-hierarchy plugin used to type each node after the resource it stands
-- for (an Azure subscription became contextType 'AzureSubscription'), which let
-- open resource-type values into the context vocabulary. The resource's type
-- moves to an attribute; the node is a Scope.
UPDATE "Contexts"
   SET "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb)
                              || jsonb_build_object('resourceType', "contextType"),
       "contextType"        = 'Scope'
 WHERE "sourceAlgorithmId" = (SELECT id FROM "ContextAlgorithms" WHERE name = 'scope-hierarchy')
   AND "contextType" <> 'Scope';

-- ─── 3. Backfill the template from the type ──────────────────────────────────
UPDATE "Contexts"
   SET "contextCategory" = CASE "contextType"
     WHEN 'ManagerHierarchy'    THEN 'OrganizationalUnit'
     WHEN 'OrganisationalUnit'  THEN 'OrganizationalUnit'
     WHEN 'Department'          THEN 'OrganizationalUnit'
     WHEN 'OrgUnit'             THEN 'OrganizationalUnit'
     WHEN 'Team'                THEN 'OrganizationalUnit'
     WHEN 'AdministrativeUnit'  THEN 'OrganizationalUnit'
     WHEN 'CostCenter'          THEN 'OrganizationalUnit'
     WHEN 'LogicalApplication'  THEN 'LogicalApplication'
     WHEN 'Tag'                 THEN 'Tag'
     WHEN 'PrincipalType'       THEN 'Segment'
     WHEN 'ResourceType'        THEN 'Segment'
     WHEN 'ResourcePlane'       THEN 'Segment'
     WHEN 'ResourceRole'        THEN 'Segment'
     WHEN 'Scope'               THEN 'Segment'
     WHEN 'EntraGroupCategory'  THEN 'Segment'
     WHEN 'SystemMembership'    THEN 'Segment'
     WHEN 'OrphanedAccounts'    THEN 'Segment'
     WHEN 'RiskyConsent'        THEN 'Segment'
     WHEN 'RiskyAppConsent'     THEN 'Segment'
     WHEN 'ResourceCluster'     THEN 'Segment'
     WHEN 'ContextRecipe'       THEN 'LogicalApplication'
     WHEN 'Location'            THEN 'Segment'
     ELSE NULL
   END
 WHERE "contextCategory" IS NULL;

-- The UPDATEs above queue the deferred cycle check on Contexts (migration 059,
-- DEFERRABLE INITIALLY DEFERRED, so it would run at COMMIT). PostgreSQL refuses
-- DDL on a table with pending trigger events ("cannot CREATE INDEX ... because
-- it has pending trigger events") — the index below and the foreign keys to
-- Contexts further down. Run the queued checks now. An empty Contexts table
-- (a fresh install, CI) queues nothing, which is why only upgrades hit this.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE INDEX "ix_Contexts_contextCategory" ON "Contexts" ("contextCategory");

-- ─── 4. Who answers for a context ────────────────────────────────────────────
-- Accountable: at most one per context. Responsible: any number. The holder is
-- an account or a person, exactly one, as ResourceAssignments does. addedBy
-- says who put the row there, so a plugin re-run replaces only its own rows and
-- an analyst's or a sync's survive — the ContextMembers rule.
CREATE TABLE "ContextRoles" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"   UUID NOT NULL REFERENCES "Contexts"("id")   ON DELETE CASCADE,
    "principalId" UUID          REFERENCES "Principals"("id") ON DELETE CASCADE,
    "identityId"  UUID          REFERENCES "Identities"("id") ON DELETE CASCADE,
    "role"        TEXT NOT NULL CHECK ("role" IN ('Accountable', 'Responsible')),
    "addedBy"     TEXT NOT NULL CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst')),
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ContextRoles_one_holder" CHECK (("principalId" IS NULL) <> ("identityId" IS NULL))
);
CREATE UNIQUE INDEX "ux_ContextRoles_principal" ON "ContextRoles" ("contextId", "principalId", "role") WHERE "principalId" IS NOT NULL;
CREATE UNIQUE INDEX "ux_ContextRoles_identity"  ON "ContextRoles" ("contextId", "identityId",  "role") WHERE "identityId"  IS NOT NULL;
CREATE UNIQUE INDEX "ux_ContextRoles_accountable" ON "ContextRoles" ("contextId") WHERE "role" = 'Accountable';
CREATE INDEX "ix_ContextRoles_principal" ON "ContextRoles" ("principalId");
CREATE INDEX "ix_ContextRoles_identity"  ON "ContextRoles" ("identityId");

-- The manager-hierarchy plugin has always recorded a node's manager only in its
-- externalId (the manager's Principal id). State it as a role; the plugin writes
-- the same row on its next run.
INSERT INTO "ContextRoles" ("contextId", "principalId", "role", "addedBy")
SELECT c.id, p.id, 'Accountable', 'algorithm'
  FROM "Contexts" c
  JOIN "Principals" p ON p.id::text = c."externalId"
 WHERE c."sourceAlgorithmId" = (SELECT id FROM "ContextAlgorithms" WHERE name = 'manager-hierarchy');

-- ─── 5. Context to context ───────────────────────────────────────────────────
-- SameUnitAs: two contexts are one unit seen through a different kind of
-- member — "Contoso" as its people, its accounts and its resources is three
-- contexts, linked pairwise. Symmetric, so a pair is stored once whichever way
-- round it was posted (the pair index below); the API refuses two variants that
-- hold the same kind of member.
CREATE TABLE "ContextRelationships" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"        UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    "relatedContextId" UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    "relationshipType" TEXT NOT NULL CHECK ("relationshipType" IN ('SameUnitAs')),
    "addedBy"          TEXT NOT NULL CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst')),
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ContextRelationships_not_self" CHECK ("contextId" <> "relatedContextId")
);
CREATE UNIQUE INDEX "ux_ContextRelationships_pair" ON "ContextRelationships"
  (LEAST("contextId", "relatedContextId"), GREATEST("contextId", "relatedContextId"), "relationshipType");
CREATE INDEX "ix_ContextRelationships_related" ON "ContextRelationships" ("relatedContextId");

-- ─── 6. The tags compatibility view leaves the root out ──────────────────────
-- GraphTagAssignments needs no change: the root has no members.
CREATE OR REPLACE VIEW "GraphTags" AS
SELECT
  c.id,
  c."displayName"           AS "name",
  COALESCE(c."extendedAttributes"->>'tagColor', '#3b82f6') AS "color",
  CASE c."targetType"
    WHEN 'Principal' THEN 'user'
    WHEN 'Resource'  THEN 'resource'
    WHEN 'Identity'  THEN 'identity'
    ELSE NULL
  END                       AS "entityType",
  c."createdAt",
  c."updatedAt"
FROM "Contexts" c
WHERE c."contextType" = 'Tag'
  AND c."variant"     = 'manual'
  AND c."targetType" IN ('Principal', 'Resource', 'Identity')
  AND COALESCE(c."extendedAttributes"->>'tagRoot', 'false') <> 'true';

-- ─── 7. History ──────────────────────────────────────────────────────────────
-- Who answers for a unit, and which units belong together, are governed facts:
-- record every change in _history like the other governed tables (009). A
-- plugin re-run keeps the rows it still produces, so history shows real changes.
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextRoles";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextRoles"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "ContextRoles";
    CREATE TRIGGER trg_history_upd
    AFTER UPDATE ON "ContextRoles"
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_ins_del ON "ContextRelationships";
    CREATE TRIGGER trg_history_ins_del
    AFTER INSERT OR DELETE ON "ContextRelationships"
    FOR EACH ROW EXECUTE FUNCTION fg_record_history();
END $$;
