-- The externalId uniqueness constraint was scoped by (scopeSystemId,
-- externalId), which turned out to be wrong: every generator plugin that
-- produces a synthetic root node emits externalId='root', and on the
-- second run with the same scopeSystemId the second plugin hits a
-- duplicate-key violation against the first plugin's root.
--
-- The real invariant is: an externalId is unique *per generator*, i.e.
-- per (sourceAlgorithmId, scopeSystemId). This matches how the runner
-- preloads existing rows for reconciliation. Manual rows (NULL
-- sourceAlgorithmId) retain today's semantics because the partial
-- predicate excludes them.

DROP INDEX IF EXISTS "ix_Contexts_externalId";

CREATE UNIQUE INDEX "ix_Contexts_externalId"
  ON "Contexts" ("sourceAlgorithmId", "scopeSystemId", "externalId")
  WHERE "sourceAlgorithmId" IS NOT NULL
    AND "scopeSystemId"     IS NOT NULL
    AND "externalId"        IS NOT NULL;
