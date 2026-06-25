-- Assignment-model redesign — Phase 2: collapse the Entra "source" assignment
-- types into the three universal kinds. See docs/architecture/assignment-model-redesign.md.
--
-- "What kind of access" already lives on resourceType (AppRole / DelegatedPermission
-- / EntraRole — all synthetic resources). The distinct source assignmentTypes were
-- only ever (a) the membership "how" and (b) the reconcile-delete partition key.
-- Now that resourceType is denormalised onto ResourceAssignments (migration 044)
-- and every Entra Direct/Indirect/Eligible phase scopes its reconcile by
-- resourceType, the source types collapse to the "how":
--
--   OAuth2Grant, AppRole, DirectoryRole  -> Direct
--   AppRoleViaGroup                       -> Indirect
--   DirectoryRoleEligible                 -> Eligible
--
-- This is collision-free: each source type lives on its own resourceType, so no
-- two convert to the same (resourceId, principalId|identityId, assignmentType)
-- key (verified on the largest real dataset: 0 collisions over all rows incl.
-- soft-deleted). The matrix matview already collapses these same types to the
-- same membershipType via its CASE, so the rendered matrix is unchanged — this
-- migration just makes the stored value match what the crawler now writes.
--
-- Governed and Owner are deliberately NOT touched here (separate phases).

UPDATE "ResourceAssignments"
   SET "assignmentType" = CASE
     WHEN "assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
     WHEN "assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
     WHEN "assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
   END
 WHERE "assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole', 'AppRoleViaGroup', 'DirectoryRoleEligible');
