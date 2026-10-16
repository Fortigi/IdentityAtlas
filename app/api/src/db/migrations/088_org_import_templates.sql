-- Migration 088: four import templates — collection, enrichment, activity, relation.
--
-- Until now every imported list became entities. That fits a customer or project
-- list (a COLLECTION people and resources belong to), but not a staff list that
-- adds attributes to people who already exist (an ENRICHMENT), nor a timesheet
-- (ACTIVITY: who did how much on what, when), nor a list of pairs (a RELATION).
-- The analyst picks one template per import; the profile records it.
--
-- Collections, enrichments and relations keep using OrgEntities / OrgRelations /
-- OrgLinks; their template is read through OrgEntities.profileId. Activities get
-- their own two tables: one row per distinct value an activity refers to
-- (OrgActivityKeys, resolved and reviewed once per value) and one row per fact
-- (OrgActivities). A full activity run replaces the profile name's facts; keys
-- (and the analyst's decisions on them) survive re-imports.

ALTER TABLE "OrgImportProfiles"
  ADD COLUMN IF NOT EXISTS "template" TEXT NOT NULL DEFAULT 'collection';
DO $$ BEGIN
  ALTER TABLE "OrgImportProfiles" ADD CONSTRAINT "ck_OrgImportProfiles_template"
    CHECK ("template" IN ('collection','enrichment','activity','relation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per distinct raw value an activity refers to (actor "Ann Example", subject "Contoso"),
-- resolved ONCE and reviewed per value (select-distinct review), not per activity row.
CREATE TABLE IF NOT EXISTS "OrgActivityKeys" (
  "id"              UUID PRIMARY KEY,
  "profileName"     TEXT NOT NULL,            -- profiles are versioned; keys live per profile NAME
  "role"            TEXT NOT NULL CHECK ("role" IN ('actor','subject')),
  "rawValue"        TEXT NOT NULL,
  "targetType"      TEXT CHECK ("targetType" IN ('Principal','Identity','Resource','OrgEntity')),
  "targetId"        UUID,
  "confidence"      SMALLINT CHECK ("confidence" BETWEEN 0 AND 100),
  "signals"         TEXT,
  "status"          TEXT NOT NULL DEFAULT 'unmatched' CHECK ("status" IN ('proposed','accepted','rejected','unmatched')),
  "analystOverride" BOOLEAN NOT NULL DEFAULT false,
  "decidedBy"       TEXT,
  "decidedAt"       TIMESTAMPTZ,
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE ("profileName", "role", "rawValue")
);
CREATE INDEX IF NOT EXISTS "ix_OrgActivityKeys_target" ON "OrgActivityKeys" ("targetType", "targetId") WHERE "status" = 'accepted';

CREATE TABLE IF NOT EXISTS "OrgActivities" (
  "id"            UUID PRIMARY KEY,
  "profileName"   TEXT NOT NULL,
  "activityType"  TEXT NOT NULL,              -- display name, e.g. 'Uren'
  "profileId"     UUID REFERENCES "OrgImportProfiles"("id") ON DELETE SET NULL,
  "runId"         UUID REFERENCES "OrgImportRuns"("id") ON DELETE SET NULL,
  "sourceId"      UUID NOT NULL REFERENCES "OrgSources"("id") ON DELETE CASCADE,
  "sourceLocator" TEXT,
  "actorKeyId"    UUID REFERENCES "OrgActivityKeys"("id") ON DELETE SET NULL,
  "subjectKeyId"  UUID REFERENCES "OrgActivityKeys"("id") ON DELETE SET NULL,
  "occurredOn"    DATE NOT NULL,              -- a period's first day for month data
  "periodEnd"     DATE,                       -- last day of the period, NULL for a point in time
  "measure"       NUMERIC,
  "unit"          TEXT,
  "attributes"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "recordedAt"    TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS "ix_OrgActivities_subject" ON "OrgActivities" ("subjectKeyId", "occurredOn");
CREATE INDEX IF NOT EXISTS "ix_OrgActivities_actor"   ON "OrgActivities" ("actorKeyId", "occurredOn");
CREATE INDEX IF NOT EXISTS "ix_OrgActivities_profile" ON "OrgActivities" ("profileName");
