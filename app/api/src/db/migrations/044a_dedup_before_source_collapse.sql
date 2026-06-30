-- Assignment-model redesign — Phase 2 (pre-step): dedup duplicate effective
-- assignments BEFORE migration 045 collapses the Entra "source" assignment types.
--
-- Why this file exists (named 044a so it sorts AFTER 044_ and BEFORE 045_, i.e.
-- it always runs immediately before the collapse):
--
-- Migration 045 collapses the source types to the three universal kinds:
--   OAuth2Grant, AppRole, DirectoryRole  -> Direct
--   AppRoleViaGroup                       -> Indirect
--   DirectoryRoleEligible                 -> Eligible
-- via a blind UPDATE, on the assumption that no two source rows ever collapse to
-- the same key. That does NOT hold on every real dataset: a single
-- (resourceId, principalId|identityId) can carry two DISTINCT source rows that
-- collapse to the SAME universal kind (e.g. an 'AppRole' and an 'OAuth2Grant'
-- both -> 'Direct'), or a source row alongside a literal pre-existing 'Direct'.
-- uq_RA_principal / uq_RA_identity are (resourceId, principal|identity,
-- assignmentType) and do NOT exclude soft-deleted rows, so 045's UPDATE then
-- failed with "duplicate key value violates unique constraint uq_RA_principal".
-- Because migrations run before the web port binds, that aborted boot and the
-- container crash-looped (Azure showed "Application Error").
--
-- These duplicates were always present in storage; the matrix matview just
-- GROUP BY'd them away at read time (see migration 026, which fixed the
-- identical collision in the view). Collapsing the STORED value forces the same
-- dedup here: keep one survivor per (resource, subject, collapsed-type) and drop
-- the rest. They are duplicate EFFECTIVE access (same resource, same subject,
-- same kind), so the rendered matrix is unchanged.
--
-- Survivor preference: a live row over a soft-deleted one, then a row already at
-- the target type (so 045 needn't rewrite it), then a deterministic tie-break.
--
-- Scope guard — only dedupe a group that actually contains a SOURCE-typed row
-- (one of the five 045 will collapse). 045 only rewrites source rows, so only a
-- group containing one can develop a post-collapse collision. A group made up
-- entirely of already-universal rows is left strictly alone. This matters for
-- upgrade-safety, not just tidiness:
--
--   * Idempotent / re-runnable: once 045 has run there are no source rows, so
--     this file becomes a precise no-op (fresh installs and installs where 045
--     already succeeded).
--   * It never touches the `governed` model. Migration 047 makes `governed`
--     part of the assignment key, so a governed membership is legitimately TWO
--     'Direct' rows (actual governed=false + intent governed=true) on the same
--     (resource, principal). Those share our (resource, subject, collapsed-type)
--     partition. Deduping by that partition WITHOUT `governed` would wrongly
--     delete one of the pair. We don't need to special-case `governed` (which
--     doesn't exist on the normal pre-045 path anyway): a governed pair is two
--     universal 'Direct' rows with NO source row, so the source-row guard
--     already excludes it. Source rows and governed-intent rows never coexist in
--     time — 045 (collapse) runs strictly before 047 (governed), so by the time
--     intent rows exist the source rows are long gone.

WITH collapsed AS (
    SELECT "resourceId", "principalId", "identityId", "assignmentType", "deletedAt",
           ("assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole',
                                  'AppRoleViaGroup', 'DirectoryRoleEligible')) AS is_source,
           CASE
             WHEN "assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
             WHEN "assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
             WHEN "assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
             ELSE "assignmentType"
           END AS new_type
      FROM "ResourceAssignments"
),
ranked AS (
    SELECT "resourceId", "principalId", "identityId", "assignmentType",
           row_number() OVER w  AS rn,
           bool_or("is_source") OVER w AS group_has_source
      FROM collapsed
    WINDOW w AS (
             PARTITION BY "resourceId",
                          ("principalId" IS NOT NULL),          -- keep principal/identity arms separate
                          COALESCE("principalId", "identityId"),
                          new_type
             ORDER BY ("deletedAt" IS NULL) DESC,               -- keep a live row
                      ("assignmentType" = new_type) DESC,        -- keep an already-collapsed row
                      "assignmentType"                           -- deterministic tie-break
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
           )
)
DELETE FROM "ResourceAssignments" ra
 USING ranked r
 WHERE r.rn > 1
   AND r.group_has_source                                       -- only collapse-affected groups
   AND ra."resourceId"     =                    r."resourceId"
   AND ra."assignmentType" =                    r."assignmentType"
   AND ra."principalId"    IS NOT DISTINCT FROM r."principalId"
   AND ra."identityId"     IS NOT DISTINCT FROM r."identityId";
