-- Migration 084: organisation truth.
--
-- Next to the system truth the crawlers sync several times a day (strictly
-- modelled, the IST), the organisation has a truth of its own: project lists,
-- asset registers, data-domain owners, later transcripts and mail. It is
-- uploaded once, describes a point in time, and its structure is only known
-- after looking at it. See docs/architecture/org-truth.md.
--
-- Four layers, each its own table family:
--
--   OrgSources          the original, kept unchanged, with the moment it describes
--   OrgEntities         claims about things: a free-form type, a name, attributes
--   OrgRelations        claims about links between two things: a free-form predicate
--   OrgLinks            an org entity matched to a system object, with a score
--   OrgImportProfiles   the reusable, versioned import recipe (model + link rules)
--   OrgImportRuns       one execution of a profile against a source
--
-- Every claim carries where it came from (source + locator), who produced it
-- (import, model, analyst), how sure it is, and its status: nothing a model
-- proposes is authoritative until an analyst accepts it. Claims are never
-- deleted by a run: a full run closes what disappeared (validTo), a delta run
-- closes nothing.

-- ─── 1. Sources ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrgSources" (
    "id"            UUID PRIMARY KEY,
    "kind"          TEXT NOT NULL CHECK ("kind" IN ('list','transcript','email','manual')),
    "displayName"   TEXT NOT NULL,
    "fileName"      TEXT,
    "mimeType"      TEXT,
    "byteSize"      INTEGER,
    "sha256"        TEXT,
    "content"       BYTEA,
    "textContent"   TEXT,
    "observedAt"    TIMESTAMPTZ NOT NULL,
    "uploadedBy"    TEXT,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS "ix_OrgSources_kind" ON "OrgSources"("kind");

-- ─── 2. Import profiles and runs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrgImportProfiles" (
    "id"            UUID PRIMARY KEY,
    "name"          TEXT NOT NULL,
    "version"       INTEGER NOT NULL DEFAULT 1,
    "sourceKind"    TEXT NOT NULL CHECK ("sourceKind" IN ('list','transcript','email','manual')),
    "recipe"        JSONB NOT NULL,
    "linkRules"     JSONB NOT NULL DEFAULT '[]'::jsonb,
    "createdBy"     TEXT,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    UNIQUE ("name", "version")
);

CREATE TABLE IF NOT EXISTS "OrgImportRuns" (
    "id"              UUID PRIMARY KEY,
    "profileId"       UUID REFERENCES "OrgImportProfiles"("id") ON DELETE SET NULL,
    "profileVersion"  INTEGER,
    "sourceId"        UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "mode"            TEXT NOT NULL CHECK ("mode" IN ('full','delta')),
    "status"          TEXT NOT NULL CHECK ("status" IN ('queued','running','completed','failed')),
    "step"            TEXT,
    "pct"             INTEGER,
    "stats"           JSONB,
    "error"           TEXT,
    "triggeredBy"     TEXT,
    "startedAt"       TIMESTAMPTZ,
    "finishedAt"      TIMESTAMPTZ,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS "ix_OrgImportRuns_profile" ON "OrgImportRuns"("profileId");
CREATE INDEX IF NOT EXISTS "ix_OrgImportRuns_source"  ON "OrgImportRuns"("sourceId");

-- ─── 3. Claims ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrgEntities" (
    "id"             UUID PRIMARY KEY,
    "entityType"     TEXT NOT NULL,
    "displayName"    TEXT NOT NULL,
    "canonicalKey"   TEXT,
    "profileId"      UUID REFERENCES "OrgImportProfiles"("id") ON DELETE SET NULL,
    "attributes"     JSONB NOT NULL DEFAULT '{}'::jsonb,
    "sourceId"       UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "sourceLocator"  TEXT,
    "runId"          UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
    "origin"         TEXT NOT NULL CHECK ("origin" IN ('import','model','analyst')),
    "status"         TEXT NOT NULL DEFAULT 'accepted' CHECK ("status" IN ('proposed','accepted','rejected')),
    "confidence"     SMALLINT CHECK ("confidence" BETWEEN 0 AND 100),
    "observedAt"     TIMESTAMPTZ NOT NULL,
    "recordedAt"     TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "validFrom"      TIMESTAMPTZ,
    "validTo"        TIMESTAMPTZ,
    "createdBy"      TEXT
);
CREATE INDEX IF NOT EXISTS "ix_OrgEntities_type"   ON "OrgEntities"("entityType");
CREATE INDEX IF NOT EXISTS "ix_OrgEntities_source" ON "OrgEntities"("sourceId");
CREATE INDEX IF NOT EXISTS "ix_OrgEntities_status" ON "OrgEntities"("status");
CREATE INDEX IF NOT EXISTS "ix_OrgEntities_name"   ON "OrgEntities"(lower("displayName"));
-- One current (open) entity per profile, type and key: that is what a delta
-- run updates and a full run closes.
CREATE UNIQUE INDEX IF NOT EXISTS "ix_OrgEntities_current_key"
    ON "OrgEntities"("profileId", "entityType", "canonicalKey")
    WHERE "validTo" IS NULL AND "canonicalKey" IS NOT NULL AND "profileId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "OrgRelations" (
    "id"             UUID PRIMARY KEY,
    "fromEntityId"   UUID NOT NULL REFERENCES "OrgEntities"("id") ON DELETE CASCADE,
    "toEntityId"     UUID NOT NULL REFERENCES "OrgEntities"("id") ON DELETE CASCADE,
    "predicate"      TEXT NOT NULL,
    "attributes"     JSONB NOT NULL DEFAULT '{}'::jsonb,
    "sourceId"       UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "sourceLocator"  TEXT,
    "runId"          UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
    "origin"         TEXT NOT NULL CHECK ("origin" IN ('import','model','analyst')),
    "status"         TEXT NOT NULL DEFAULT 'accepted' CHECK ("status" IN ('proposed','accepted','rejected')),
    "confidence"     SMALLINT CHECK ("confidence" BETWEEN 0 AND 100),
    "observedAt"     TIMESTAMPTZ NOT NULL,
    "recordedAt"     TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "validFrom"      TIMESTAMPTZ,
    "validTo"        TIMESTAMPTZ,
    "createdBy"      TEXT
);
CREATE INDEX IF NOT EXISTS "ix_OrgRelations_from"      ON "OrgRelations"("fromEntityId");
CREATE INDEX IF NOT EXISTS "ix_OrgRelations_to"        ON "OrgRelations"("toEntityId");
CREATE INDEX IF NOT EXISTS "ix_OrgRelations_predicate" ON "OrgRelations"("predicate");
CREATE INDEX IF NOT EXISTS "ix_OrgRelations_source"    ON "OrgRelations"("sourceId");

-- ─── 4. Links to the system truth ────────────────────────────────────────
-- targetId is a UUID for every target type this migration allows; Systems
-- (integer ids) are deliberately not a target yet.
CREATE TABLE IF NOT EXISTS "OrgLinks" (
    "id"              UUID PRIMARY KEY,
    "orgEntityId"     UUID NOT NULL REFERENCES "OrgEntities"("id") ON DELETE CASCADE,
    "targetType"      TEXT NOT NULL CHECK ("targetType" IN ('Identity','Principal','Resource','Context')),
    "targetId"        UUID NOT NULL,
    "confidence"      SMALLINT NOT NULL CHECK ("confidence" BETWEEN 0 AND 100),
    "signals"         TEXT,
    "matchedField"    TEXT,
    "matchedValue"    TEXT,
    "origin"          TEXT NOT NULL CHECK ("origin" IN ('import','model','analyst')),
    "status"          TEXT NOT NULL DEFAULT 'proposed' CHECK ("status" IN ('proposed','accepted','rejected')),
    "analystOverride" TEXT CHECK ("analystOverride" IN ('confirmed','rejected','moved')),
    "overriddenBy"    TEXT,
    "overriddenAt"    TIMESTAMPTZ,
    "runId"           UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    UNIQUE ("orgEntityId", "targetType", "targetId")
);
CREATE INDEX IF NOT EXISTS "ix_OrgLinks_target" ON "OrgLinks"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "ix_OrgLinks_status" ON "OrgLinks"("status");

-- ─── 5. History triggers ─────────────────────────────────────────────────
-- fg_record_history() (009_history.sql) works for any table with an id column.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['OrgEntities','OrgRelations','OrgLinks','OrgImportProfiles'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_ins_del ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_ins_del AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fg_record_history()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_upd ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION fg_record_history()', t);
    END LOOP;
END $$;
