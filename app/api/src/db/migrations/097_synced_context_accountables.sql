-- Identity Atlas — the owner a source names becomes the synced context's Accountable
--
-- Since migration 092 the context page shows who answers for a context from
-- "ContextRoles". A synced context (a logical application from the SQL
-- crawler's IdentityIQ preset, an org unit from a CSV) carries the owner its
-- source names only in "Contexts"."ownerUserId", so every one of them showed
-- "Nobody is accountable yet". The contexts ingest now states that owner as
-- the Accountable on every load (app/api/src/ingest/contextOwners.js); this
-- does it once for what is already in the database, so nobody has to wait for
-- the next crawl.
--
-- Insert-only: a context that already has an Accountable (an analyst's, a
-- plugin's) keeps it. Manual contexts are left out on purpose — there
-- ownerUserId is the analyst who created the context, not its owner.
--
-- Resolution is the ingest's, statement for statement: the principal whose
-- externalId is the owner (a live row over a soft-deleted one, the context's
-- scope system over any other, then the id), else the one LIVE principal whose
-- employeeId is the owner — two or more is ambiguous and resolves to nobody.
-- Both are index joins (ix_Principals_externalId, migration 076;
-- ix_Principals_employeeId, migration 001); no index is added.
--
-- No deferred-trigger concern (see 092): nothing here writes "Contexts", so
-- the deferred cycle check queues nothing, and no DDL follows the INSERT.

WITH scoped AS (
  SELECT c.id, c."scopeSystemId", NULLIF(c."ownerUserId", '') AS owner
    FROM "Contexts" c
   WHERE c.variant = 'synced'
     AND c."contextCategory" IN ('OrganizationalUnit', 'LogicalApplication')
     AND NULLIF(c."ownerUserId", '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "ContextRoles" r WHERE r."contextId" = c.id AND r.role = 'Accountable')
),
by_external_id AS (
  SELECT DISTINCT ON (c.id) c.id AS "contextId", p.id AS "principalId"
    FROM scoped c
    JOIN "Principals" p ON p."externalId" = c.owner
   ORDER BY c.id, (p."deletedAt" IS NULL) DESC,
                  (p."systemId" IS NOT DISTINCT FROM c."scopeSystemId") DESC,
                  p.id
),
by_employee_id AS (
  SELECT c.id AS "contextId", (array_agg(p.id))[1] AS "principalId"
    FROM scoped c
    JOIN "Principals" p ON p."employeeId" = c.owner AND p."deletedAt" IS NULL
   WHERE NOT EXISTS (SELECT 1 FROM by_external_id x WHERE x."contextId" = c.id)
   GROUP BY c.id
  HAVING count(*) = 1
)
INSERT INTO "ContextRoles" ("contextId", "principalId", "role", "addedBy")
SELECT "contextId", "principalId", 'Accountable', 'sync' FROM by_external_id
UNION ALL
SELECT "contextId", "principalId", 'Accountable', 'sync' FROM by_employee_id
ON CONFLICT DO NOTHING;
