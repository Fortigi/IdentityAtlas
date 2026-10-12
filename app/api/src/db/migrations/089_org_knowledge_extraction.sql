-- Migration 089: knowledge extraction from transcripts (experimental).
--
-- An interview transcript is one more organisation source (OrgSources kind
-- 'transcript', already allowed by 084). What a local model reads in it lands in
-- the SAME claim tables as an imported list, never in a store of its own:
--
--   mention of a person/team/customer  → OrgEntities   origin 'model', status 'proposed'
--   statement about them               → OrgRelations  origin 'model', status 'proposed'
--   which existing object a mention is → OrgLinks      'proposed' (an analyst confirms)
--
-- Four additions carry what a list import never needed:
--
--   OrgSources.metadata     speaker, language, format, privacy classification
--   OrgSourcePassages       the canonical text cut into numbered passages with
--                           character offsets (and cue times / speaker when known)
--   OrgClaimEvidence        the exact quote that supports a statement, by offset into
--                           the source's textContent, and whether a verifier agreed
--   OrgKnowledgeFindings    contradictions, unresolved names and follow-up questions
--
-- An extraction run is an OrgImportRuns row with mode 'extract', so the runId on
-- every claim keeps pointing at the run that produced it; its pipeline state
-- (phase progress, model, prompt version, per-stage outputs) is the new
-- "details" column. A run can now also end 'cancelled'.
-- See docs/architecture/org-knowledge-extraction.md.

ALTER TABLE "OrgSources" ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS "ix_OrgSources_sha256" ON "OrgSources"("kind", "sha256");

ALTER TABLE "OrgImportRuns" DROP CONSTRAINT IF EXISTS "OrgImportRuns_mode_check";
ALTER TABLE "OrgImportRuns" DROP CONSTRAINT IF EXISTS "ck_OrgImportRuns_mode";
ALTER TABLE "OrgImportRuns" ADD CONSTRAINT "ck_OrgImportRuns_mode"
    CHECK ("mode" IN ('full','delta','extract'));
ALTER TABLE "OrgImportRuns" DROP CONSTRAINT IF EXISTS "OrgImportRuns_status_check";
ALTER TABLE "OrgImportRuns" DROP CONSTRAINT IF EXISTS "ck_OrgImportRuns_status";
ALTER TABLE "OrgImportRuns" ADD CONSTRAINT "ck_OrgImportRuns_status"
    CHECK ("status" IN ('queued','running','completed','failed','cancelled'));
ALTER TABLE "OrgImportRuns" ADD COLUMN IF NOT EXISTS "details" JSONB;
ALTER TABLE "OrgImportRuns" ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false;

-- Passages are derived deterministically from textContent; re-segmenting the same
-- text gives the same rows, so (sourceId, seq) is the passage's stable name.
CREATE TABLE IF NOT EXISTS "OrgSourcePassages" (
    "id"          UUID PRIMARY KEY,
    "sourceId"    UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "seq"         INTEGER NOT NULL CHECK ("seq" >= 1),
    "startChar"   INTEGER NOT NULL CHECK ("startChar" >= 0),
    "endChar"     INTEGER NOT NULL,
    "text"        TEXT NOT NULL,
    "speaker"     TEXT,
    "startMs"     INTEGER,
    "endMs"       INTEGER,
    CHECK ("endChar" > "startChar"),
    UNIQUE ("sourceId", "seq")
);

-- One row per exact quote supporting a statement. The quote is a substring of the
-- source's textContent at [startChar, endChar); a statement without one is never stored.
CREATE TABLE IF NOT EXISTS "OrgClaimEvidence" (
    "id"          UUID PRIMARY KEY,
    "relationId"  UUID NOT NULL REFERENCES "OrgRelations"("id") ON DELETE CASCADE,
    "sourceId"    UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "passageId"   UUID REFERENCES "OrgSourcePassages"("id") ON DELETE SET NULL,
    "startChar"   INTEGER NOT NULL CHECK ("startChar" >= 0),
    "endChar"     INTEGER NOT NULL,
    "quote"       TEXT NOT NULL,
    "support"     TEXT NOT NULL DEFAULT 'unchecked' CHECK ("support" IN ('supported','unsupported','unclear','unchecked')),
    "verifier"    TEXT,
    "runId"       UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CHECK ("endChar" > "startChar"),
    UNIQUE ("relationId", "startChar", "endChar")
);
CREATE INDEX IF NOT EXISTS "ix_OrgClaimEvidence_source" ON "OrgClaimEvidence"("sourceId");

CREATE TABLE IF NOT EXISTS "OrgKnowledgeFindings" (
    "id"          UUID PRIMARY KEY,
    "sourceId"    UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
    "runId"       UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
    "kind"        TEXT NOT NULL CHECK ("kind" IN ('issue','question')),
    "category"    TEXT NOT NULL,
    "text"        TEXT NOT NULL,
    "findingKey"  TEXT NOT NULL,
    "related"     JSONB NOT NULL DEFAULT '{}'::jsonb,
    "origin"      TEXT NOT NULL CHECK ("origin" IN ('rule','model')),
    "status"      TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','dismissed','resolved')),
    "decidedBy"   TEXT,
    "decidedAt"   TIMESTAMPTZ,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    UNIQUE ("sourceId", "findingKey")
);

-- Re-running extraction on the same transcript updates its mentions and statements
-- instead of adding them again (and never touches an analyst's decision on them).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_OrgEntities_source_mention"
    ON "OrgEntities"("sourceId", "entityType", "canonicalKey")
    WHERE "profileId" IS NULL AND "origin" = 'model' AND "canonicalKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ux_OrgRelations_source_claim"
    ON "OrgRelations"("sourceId", ("attributes"->>'claimKey'))
    WHERE "attributes" ? 'claimKey';

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['OrgClaimEvidence','OrgKnowledgeFindings'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_ins_del ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_ins_del AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fg_record_history()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_history_upd ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_history_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION fg_record_history()', t);
    END LOOP;
END $$;
