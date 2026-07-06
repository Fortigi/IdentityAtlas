-- Identity Atlas — idempotent cleanup of resource-orphaned rows in the fact
-- tables (ResourceAssignments, ResourceRelationships), and documentation of why
-- these tables intentionally carry NO database-level foreign keys.
--
-- ── Why no FK (and why the matview NOT EXISTS guards stay) ───────────────────
-- The fact tables are ingested by crawlers in SEPARATE, chunked HTTP batches
-- (ingest/resources, ingest/resource-assignments, ingest/resource-relationships),
-- each its own transaction — so an assignment can be committed before the batch
-- carrying its Resource/Principal has run. Assignments can also LEGITIMATELY
-- reference principals that are not in "Principals": external / guest / service-
-- principal group members that the Users phase never returns, and cross-system
-- references resolved from *ExternalId. A hard FK with immediate enforcement
-- would REJECT those real ingest rows, not merely backstop bugs — which is why
-- there is no FK. The matrix matview already hides orphans at read time via
-- NOT EXISTS sub-selects (migration 049); this migration reconciles the STORED
-- state to match, for the one class of orphan that is never legitimate.
--
-- ── What this cleans ────────────────────────────────────────────────────────
-- Only rows whose RESOURCE is entirely gone. Resources are always same-system
-- and crawled, so a missing "Resources" row is an unambiguous orphan (a tombstone
-- purge that outran its assignments, or a partial-sync bug) — never a valid
-- cross-system reference. We deliberately do NOT delete rows on a missing
-- principalId / identityId, which can be a valid external member.
--
-- A soft-deleted Resource still EXISTS as a row (stamped deletedAt), so its
-- assignments are NOT treated as orphans here — only a hard-absent "Resources"
-- row triggers cleanup.
--
-- Idempotent and side-effect-free (DELETEs only, no DDL): after this runs, and
-- on fresh installs, there are no resource-orphans, so re-running is a precise
-- no-op. The fact-table integrity contract test re-executes this file verbatim
-- against a seeded scenario, which is why it must stay DELETE-only.

DELETE FROM "ResourceAssignments" ra
 WHERE NOT EXISTS (SELECT 1 FROM "Resources" r WHERE r.id = ra."resourceId");

DELETE FROM "ResourceRelationships" rr
 WHERE NOT EXISTS (SELECT 1 FROM "Resources" r WHERE r.id = rr."parentResourceId")
    OR NOT EXISTS (SELECT 1 FROM "Resources" r WHERE r.id = rr."childResourceId");
