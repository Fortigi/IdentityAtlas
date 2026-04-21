-- Phase 8 of the context redesign: tags become manual flat contexts.
-- The UI contract is unchanged (GET /api/tags returns id/name/color/
-- entityType), but the backing tables GraphTags + GraphTagAssignments
-- are dropped and replaced with views over Contexts / ContextMembers.
--
-- Why views instead of just touching the tag route: several queries
-- around the codebase (permissions filtering, resource filtering,
-- detail page chips) still JOIN GraphTags directly. Keeping the view
-- names means those queries work unchanged while new code writes to
-- the unified tables.

-- Drop any dependents first (safe on fresh DB — re-created below).
DROP TABLE IF EXISTS "GraphTagAssignments" CASCADE;
DROP TABLE IF EXISTS "GraphTags"           CASCADE;

-- View: tag rows are manual Contexts with contextType='Tag'.
-- entityType maps: Principal→user, Resource→resource. Contexts whose
-- targetType is something else are not surfaced here.
CREATE VIEW "GraphTags" AS
SELECT
  c.id,
  c."displayName"           AS "name",
  COALESCE(c."extendedAttributes"->>'tagColor', '#3b82f6') AS "color",
  CASE c."targetType"
    WHEN 'Principal' THEN 'user'
    WHEN 'Resource'  THEN 'resource'
    ELSE NULL
  END                       AS "entityType",
  c."createdAt",
  c."updatedAt"
FROM "Contexts" c
WHERE c."contextType" = 'Tag'
  AND c."variant"     = 'manual'
  AND c."targetType" IN ('Principal', 'Resource');

-- View: assignments are ContextMembers of tag contexts. Downstream
-- queries compare entityId against UPPER(uuid::text), so we keep the
-- same normalisation here.
CREATE VIEW "GraphTagAssignments" AS
SELECT
  cm."contextId"                 AS "tagId",
  UPPER(cm."memberId"::text)     AS "entityId",
  cm."addedAt"                   AS "assignedAt"
FROM "ContextMembers" cm
JOIN "Contexts" c ON c.id = cm."contextId"
WHERE c."contextType" = 'Tag'
  AND c."variant"     = 'manual';
