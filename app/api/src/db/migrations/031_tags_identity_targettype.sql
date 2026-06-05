-- Identity tags were invisible. Tags are manual Contexts surfaced through the
-- GraphTags compat view (migration 020), but that view only exposed
-- targetType IN ('Principal','Resource'). A tag created for an identity is
-- stored (Contexts.targetType='Identity') and assigned (ContextMembers), but
-- every read goes through GraphTags and finds nothing — so identity tags never
-- showed up and couldn't be (re)assigned.
--
-- Recreate the view to also surface targetType='Identity' as entityType
-- 'identity'. Column list/order is unchanged, so CREATE OR REPLACE is valid.
-- GraphTagAssignments needs no change (it never filtered on targetType).

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
  AND c."targetType" IN ('Principal', 'Resource', 'Identity');
