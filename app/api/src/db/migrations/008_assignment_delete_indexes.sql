-- Identity Atlas v5 — indexes added during smoke testing on a large tenant.
--
-- The scoped delete in the ingest engine looks like:
--   DELETE FROM "ResourceAssignments" t
--    WHERE t."systemId" = $1 AND t."assignmentType" = $2
--      AND NOT EXISTS (SELECT 1 FROM <temp> src WHERE
--          t."resourceId" = src."resourceId"
--      AND t."principalId" = src."principalId"
--      AND t."assignmentType" = src."assignmentType")
--
-- On a 250k-row table this took >12 minutes without supporting indexes
-- because postgres had to scan every row of ResourceAssignments looking
-- for the (systemId, assignmentType) match. Adding a composite index lets
-- the planner do an index range scan in seconds.
--
-- Same applies to ResourceRelationships scoped deletes (smaller table but
-- the principle is identical) and Resources / Principals where the ingest
-- delete uses (systemId, resourceType) and (systemId, principalType).

CREATE INDEX IF NOT EXISTS "ix_RA_systemId_assignmentType"
  ON "ResourceAssignments" ("systemId", "assignmentType");

CREATE INDEX IF NOT EXISTS "ix_RR_systemId_relationshipType"
  ON "ResourceRelationships" ("systemId", "relationshipType");

CREATE INDEX IF NOT EXISTS "ix_Resources_systemId_resourceType"
  ON "Resources" ("systemId", "resourceType");

CREATE INDEX IF NOT EXISTS "ix_Principals_systemId_principalType"
  ON "Principals" ("systemId", "principalType");

CREATE INDEX IF NOT EXISTS "ix_Contexts_systemId_contextType"
  ON "Contexts" ("systemId", "contextType");
