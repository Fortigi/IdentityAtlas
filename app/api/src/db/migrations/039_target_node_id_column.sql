-- Identity Atlas — targetNodeId generated column on Resources (effective-access engine, P2).
--
-- A capability-resource ("<capability> @ <target node>") stores the node it applies to in
-- extendedAttributes.targetNodeId. The P2 containment traversal reads it in the gather inner
-- loop ("capability-resources targeting any node in the ancestor window"), so it must be
-- indexable. Same reasoning as the capabilityId generated column in migration 038 (spec §15.9).
--
-- '->>' on jsonb is immutable, which a STORED generated column requires. Additive and
-- non-destructive; applied automatically at boot by the migration runner.

ALTER TABLE "Resources"
    ADD COLUMN "targetNodeId" TEXT
    GENERATED ALWAYS AS (("extendedAttributes" ->> 'targetNodeId')) STORED;

CREATE INDEX "ix_Resources_targetNodeId"
    ON "Resources"("targetNodeId")
    WHERE "targetNodeId" IS NOT NULL;
