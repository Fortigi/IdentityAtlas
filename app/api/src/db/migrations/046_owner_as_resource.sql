-- Assignment-model redesign — Phase 4: group ownership becomes its own resource.
-- See docs/architecture/assignment-model-redesign.md.
--
-- 'Owner' was a membership "how" stamped on the group's OWN resource, which kept
-- the matrix from being uniform (Direct/Indirect/Eligible only) and made
-- ownership a second-class concept. Ownership now becomes a Direct assignment to
-- a synthetic "Owner @ <group>" resource (resourceType='GroupOwnership'), linked
-- to the group by a HasOwnership relationship — mirroring how an AppRole hangs
-- off its Application. The matrix then shows ownership as its own column.
--
-- The ownership resource id is deterministic over the group id, matching the
-- crawler's New-OwnershipResourceId (md5('entraid-ownership:'||groupId) formatted
-- as a uuid), so a re-sync upserts the same rows rather than duplicating them.
--
-- Collision-free: the rewritten owner rows live on the new GroupOwnership
-- resource (a fresh resourceId), so (resourceId, principalId, 'Direct') can't
-- clash with the group's own Direct members.

WITH owned AS MATERIALIZED (
    SELECT DISTINCT
        g."id"          AS group_id,
        g."systemId"    AS system_id,
        g."displayName" AS group_name,
        (substring(md5('entraid-ownership:' || g."id"::text),  1, 8) || '-' ||
         substring(md5('entraid-ownership:' || g."id"::text),  9, 4) || '-' ||
         substring(md5('entraid-ownership:' || g."id"::text), 13, 4) || '-' ||
         substring(md5('entraid-ownership:' || g."id"::text), 17, 4) || '-' ||
         substring(md5('entraid-ownership:' || g."id"::text), 21,12))::uuid AS ownership_id
    FROM "Resources" g
    WHERE EXISTS (
        SELECT 1 FROM "ResourceAssignments" ra
         WHERE ra."resourceId" = g."id" AND ra."assignmentType" = 'Owner'
    )
),
new_resources AS (
    INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "externalId", "extendedAttributes")
    SELECT ownership_id, system_id, 'Owner @ ' || COALESCE(group_name, '(group)'),
           'GroupOwnership', 'entraid-ownership:' || group_id::text,
           jsonb_build_object('ownedResourceId', group_id::text)
      FROM owned
    ON CONFLICT ("id") DO NOTHING
    RETURNING 1
),
new_rels AS (
    INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
    SELECT group_id, ownership_id, 'HasOwnership', system_id
      FROM owned
    ON CONFLICT ("parentResourceId", "childResourceId", "relationshipType") DO NOTHING
    RETURNING 1
)
UPDATE "ResourceAssignments" ra
   SET "resourceId"     = o.ownership_id,
       "assignmentType" = 'Direct',
       "resourceType"   = 'GroupOwnership'
  FROM owned o
 WHERE ra."resourceId" = o.group_id
   AND ra."assignmentType" = 'Owner';
