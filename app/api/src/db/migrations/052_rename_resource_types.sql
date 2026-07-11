-- Resource-type naming cleanup: de-prefix the universal "group" type and make the
-- directory-role type accurate.
--
-- The universal data model records WHICH system a resource came from in
-- Resources.systemId, so resourceType should describe the KIND of resource, not
-- restate the system. Every other shared/generic type (Application, AppRole,
-- DelegatedPermission, BusinessRole) is unprefixed and reused across crawlers
-- (Entra, Omada, midPoint), so 'EntraGroup' — which only baked the system into
-- the type — becomes 'Group'.
--
-- 'EntraRole' is renamed to the more accurate 'EntraDirectoryRole': it is
-- specifically an Entra *directory* role, a genuinely Entra-specific construct,
-- so it keeps the qualifier. The UI's resource-type colour map already expects
-- the 'EntraDirectoryRole' key.
--
-- resourceType is denormalised onto ResourceAssignments (migration 044), so both
-- tables are updated. The matrix matview keys on assignmentType (not
-- resourceType) and does not carry resourceType in its output, so no matview
-- rebuild or refresh is required.

UPDATE "Resources"           SET "resourceType" = 'Group'              WHERE "resourceType" = 'EntraGroup';
UPDATE "Resources"           SET "resourceType" = 'EntraDirectoryRole' WHERE "resourceType" = 'EntraRole';
UPDATE "ResourceAssignments" SET "resourceType" = 'Group'              WHERE "resourceType" = 'EntraGroup';
UPDATE "ResourceAssignments" SET "resourceType" = 'EntraDirectoryRole' WHERE "resourceType" = 'EntraRole';
