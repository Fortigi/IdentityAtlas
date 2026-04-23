-- Identity Atlas v6 — Context redesign
--
-- Replaces the v5 Contexts table (a thin department overlay) with a unified
-- model supporting three variants (synced / generated / manual) and four
-- target types (Identity / Resource / Principal / System). Introduces an
-- explicit ContextMembers table and a plugin framework (ContextAlgorithms,
-- ContextAlgorithmRuns).
--
-- Greenfield v6 cut — no migration path from v5. Existing contexts are
-- dropped; deployments re-sync to populate the new model.
--
-- See:
--   docs/architecture/context-redesign.md      — design + rationale
--   docs/architecture/context-redesign-plan.md — phased rollout

-- ─── 1. Drop legacy shape ─────────────────────────────────────────────────
DROP TABLE IF EXISTS "Contexts" CASCADE;
ALTER TABLE "Identities" DROP COLUMN IF EXISTS "contextId";
ALTER TABLE "Principals" DROP COLUMN IF EXISTS "contextId";
ALTER TABLE "Resources"  DROP COLUMN IF EXISTS "contextId";

-- ─── 2. Plugin registry (created first so Contexts can FK it) ────────────
CREATE TABLE "ContextAlgorithms" (
    "id"                UUID PRIMARY KEY,
    "name"              TEXT NOT NULL UNIQUE,
    "displayName"       TEXT NOT NULL,
    "description"       TEXT,
    "targetType"        TEXT NOT NULL CHECK ("targetType" IN ('Identity','Resource','Principal','System')),
    "parametersSchema"  JSONB,
    "enabled"           BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

-- ─── 3. Run history ───────────────────────────────────────────────────────
CREATE TABLE "ContextAlgorithmRuns" (
    "id"                UUID PRIMARY KEY,
    "algorithmId"       UUID NOT NULL REFERENCES "ContextAlgorithms"("id") ON DELETE CASCADE,
    "parameters"        JSONB,
    "scopeSystemId"     INTEGER REFERENCES "Systems"("id") ON DELETE SET NULL,
    "startedAt"         TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "finishedAt"        TIMESTAMPTZ,
    "status"            TEXT NOT NULL CHECK ("status" IN ('queued','running','succeeded','failed','cancelled')),
    "contextsCreated"   INTEGER,
    "contextsUpdated"   INTEGER,
    "contextsRemoved"   INTEGER,
    "membersAdded"      INTEGER,
    "membersRemoved"    INTEGER,
    "errorMessage"      TEXT,
    "triggeredBy"       TEXT
);
CREATE INDEX "ix_CAR_algorithm" ON "ContextAlgorithmRuns"("algorithmId");
CREATE INDEX "ix_CAR_status"    ON "ContextAlgorithmRuns"("status");
CREATE INDEX "ix_CAR_startedAt" ON "ContextAlgorithmRuns"("startedAt" DESC);

-- ─── 4. Contexts (new shape) ──────────────────────────────────────────────
CREATE TABLE "Contexts" (
    "id"                 UUID PRIMARY KEY,
    "variant"            TEXT NOT NULL CHECK ("variant" IN ('synced','generated','manual')),
    "targetType"         TEXT NOT NULL CHECK ("targetType" IN ('Identity','Resource','Principal','System')),
    "contextType"        TEXT NOT NULL,
    "displayName"        TEXT NOT NULL,
    "description"        TEXT,
    "parentContextId"    UUID REFERENCES "Contexts"("id") ON DELETE CASCADE,

    -- Provenance
    "scopeSystemId"      INTEGER REFERENCES "Systems"("id") ON DELETE SET NULL,
    "sourceAlgorithmId"  UUID REFERENCES "ContextAlgorithms"("id") ON DELETE SET NULL,
    "sourceRunId"        UUID REFERENCES "ContextAlgorithmRuns"("id") ON DELETE SET NULL,
    "createdByUser"      TEXT,
    "ownerUserId"        TEXT,
    "externalId"         TEXT,

    -- Calculated
    "directMemberCount"  INTEGER NOT NULL DEFAULT 0,
    "totalMemberCount"   INTEGER NOT NULL DEFAULT 0,
    "lastCalculatedAt"   TIMESTAMPTZ,

    -- Metadata
    "extendedAttributes" JSONB,
    "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE UNIQUE INDEX "ix_Contexts_externalId" ON "Contexts"("scopeSystemId", "externalId")
    WHERE "scopeSystemId" IS NOT NULL AND "externalId" IS NOT NULL;
CREATE INDEX "ix_Contexts_parent"      ON "Contexts"("parentContextId");
CREATE INDEX "ix_Contexts_targetType"  ON "Contexts"("targetType");
CREATE INDEX "ix_Contexts_variant"     ON "Contexts"("variant");
CREATE INDEX "ix_Contexts_scopeSystem" ON "Contexts"("scopeSystemId");
CREATE INDEX "ix_Contexts_contextType" ON "Contexts"("contextType");

-- ─── 5. Explicit membership table ─────────────────────────────────────────
CREATE TABLE "ContextMembers" (
    "contextId"  UUID NOT NULL REFERENCES "Contexts"("id") ON DELETE CASCADE,
    "memberType" TEXT NOT NULL CHECK ("memberType" IN ('Identity','Resource','Principal','System')),
    "memberId"   UUID NOT NULL,
    "addedBy"    TEXT NOT NULL CHECK ("addedBy" IN ('sync','algorithm','analyst')),
    "addedAt"    TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY ("contextId", "memberId")
);
CREATE INDEX "ix_ContextMembers_member" ON "ContextMembers"("memberType", "memberId");
CREATE INDEX "ix_ContextMembers_context" ON "ContextMembers"("contextId");

-- ─── 6. History triggers ──────────────────────────────────────────────────
-- The audit trigger function fg_record_history() is defined in 009_history.sql
-- and works generically for any table with an id column. Attach it to
-- Contexts (ContextMembers is ephemeral-ish, tracked via its parent context).
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_history_ins_del ON "Contexts";
    CREATE TRIGGER trg_history_ins_del
        AFTER INSERT OR DELETE ON "Contexts"
        FOR EACH ROW EXECUTE FUNCTION fg_record_history();

    DROP TRIGGER IF EXISTS trg_history_upd ON "Contexts";
    CREATE TRIGGER trg_history_upd
        AFTER UPDATE ON "Contexts"
        FOR EACH ROW
        WHEN (OLD IS DISTINCT FROM NEW)
        EXECUTE FUNCTION fg_record_history();
END $$;

-- ─── 7. Touch updatedAt on UPDATE ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION fg_contexts_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW."updatedAt" := now() AT TIME ZONE 'utc';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contexts_touch_updated_at ON "Contexts";
CREATE TRIGGER trg_contexts_touch_updated_at
    BEFORE UPDATE ON "Contexts"
    FOR EACH ROW EXECUTE FUNCTION fg_contexts_touch_updated_at();
