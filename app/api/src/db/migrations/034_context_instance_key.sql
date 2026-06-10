-- Multiple trees from the same plugin.
--
-- Reconciliation matched contexts on (sourceAlgorithmId, scopeSystemId,
-- externalId), so running the same plugin on the same system twice updated the
-- first tree in place instead of producing a second one — every run emits the
-- same externalIds ('root', managerId, …). To let one plugin produce several
-- independent trees on the same system, we add a per-tree instance key. Each
-- run gets its own key (so each run is a new tree); refreshing an existing tree
-- reuses its key (so the runner reconciles onto it and keeps analyst edits).
--
-- The uniqueness invariant becomes (sourceAlgorithmId, scopeSystemId,
-- sourceInstanceKey, externalId). Existing generated trees have a NULL key;
-- COALESCE(…, '') keeps their old (algorithm, scope, externalId) uniqueness so
-- nothing has to be back-filled.

ALTER TABLE "Contexts"
  ADD COLUMN IF NOT EXISTS "sourceInstanceKey" TEXT;

DROP INDEX IF EXISTS "ix_Contexts_externalId";

CREATE UNIQUE INDEX "ix_Contexts_externalId"
  ON "Contexts" ("sourceAlgorithmId", "scopeSystemId", COALESCE("sourceInstanceKey", ''), "externalId")
  WHERE "sourceAlgorithmId" IS NOT NULL
    AND "scopeSystemId"     IS NOT NULL
    AND "externalId"        IS NOT NULL;
