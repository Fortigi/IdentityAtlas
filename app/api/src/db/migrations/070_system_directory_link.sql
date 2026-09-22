-- A system declares where its principals come from: "Systems"."directorySystemId".
--
-- WHY (issue #1247). `Principals` is keyed on the account's objectId, so the Entra ID
-- crawler and the Azure RM crawler write the SAME row for the same user — and each
-- ingest stamps its own systemId on it (ingest/normalization.js). They overwrote each
-- other on every run. That flip was not cosmetic:
--
--   * `_history` recorded a "changed" event per run, so a user's Timeline filled with
--     changes nobody made;
--   * `ingest/crawlerPresence.js` resolves "is this principal in the directory?" by
--     joining Principals.systemId to an EntraID system — so once Azure RM had stamped
--     the row, the NEXT Azure RM run read the user as an orphan and (with the default
--     onlyEntraPrincipals=true) dropped his Azure role assignments;
--   * `scopedDelete` filters on systemId, so a user deleted in Entra whose row happened
--     to sit on the Azure RM system was never tombstoned.
--
-- The root cause is that systemId carried two meanings at once: "which system is this
-- account sourced from" and "which system wrote this row last". They coincide only
-- while a single crawler writes a given objectId. Azure RM is the first crawler that
-- sees the SAME accounts and groups as the directory rather than accounts of its own —
-- and SharePoint / DevOps / any other Azure-plane crawler will be the same.
--
-- This migration gives the model a way to say it: a system may point at the system its
-- principals actually live in. A system with a directorySystemId is a DEPENDENT system —
-- it references the directory's principals, it does not own them. The ingest enforces
-- that (app/api/src/ingest/engine.js buildUpdateSet + routes/ingest/helpers.js
-- resolvePreservedColumns): a dependent system can fill a NULL systemId but never
-- replace one. A directory system (directorySystemId IS NULL) can always claim, which
-- is what makes an Azure-RM-first tenant recover once the Entra crawler runs.

-- ─── 1. The column ────────────────────────────────────────────────────────────
ALTER TABLE "Systems"
  ADD COLUMN IF NOT EXISTS "directorySystemId" INTEGER REFERENCES "Systems"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "ix_Systems_directorySystemId"
  ON "Systems"("directorySystemId");

-- A system cannot be its own directory. (ADD CONSTRAINT has no IF NOT EXISTS.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_Systems_directory_not_self'
  ) THEN
    ALTER TABLE "Systems"
      ADD CONSTRAINT "ck_Systems_directory_not_self"
      CHECK ("directorySystemId" IS NULL OR "directorySystemId" <> "id");
  END IF;
END $$;

-- ─── 2. Backfill the link ─────────────────────────────────────────────────────
-- Same rule crawlerPresence.js hardcodes today (tenantId + systemType='EntraID'),
-- moved out of one query and into the model where it is visible and queryable. The
-- API re-applies it after every ingest/systems batch (linkDirectorySystems), so new
-- installs and either registration order get linked without a migration.
--
-- Guarded against an ambiguous directory: if a tenant somehow has two EntraID systems
-- we link to none of them rather than picking one arbitrarily.
UPDATE "Systems" d
   SET "directorySystemId" = s.id
  FROM "Systems" s
 WHERE s."systemType" = 'EntraID'
   AND d."systemType" <> 'EntraID'
   AND d."tenantId" IS NOT NULL
   AND d."tenantId" = s."tenantId"
   AND d."directorySystemId" IS NULL
   AND (SELECT count(*) FROM "Systems" e
         WHERE e."systemType" = 'EntraID' AND e."tenantId" = d."tenantId") = 1;

-- ─── 3. Repair the rows the flip already moved ────────────────────────────────
-- Re-home principals a dependent system stamped, back to its directory — so existing
-- installs are correct without a re-crawl.
--
-- Scoped by `_history` on purpose. "Every principal owned by a dependent system" would
-- be wrong: a genuinely Azure-owned stub exists whenever the Azure RM crawler ran
-- before any Entra data was loaded (crawlerDataAvailable=false), and re-homing that to
-- Entra would assert the directory knows an account it has never seen. A row that
-- PREVIOUSLY sat on the directory system is exactly the flip we caused, and nothing
-- else. Orphan-flagged stubs are excluded as well — those are known-not-in-directory
-- by construction.
--
-- Honest limitation: `_history` has no enforced retention but can be purged, and a
-- fresh install has none. Where history is gone, a mis-homed row stays where it is
-- until its directory crawler writes it again (which it will on its next full sync,
-- since the directory may always claim). Nothing new can flip after this migration —
-- that is the ingest guard's job, not this UPDATE's.
UPDATE "Principals" p
   SET "systemId" = d."directorySystemId"
  FROM "Systems" d
 WHERE d.id = p."systemId"
   AND d."directorySystemId" IS NOT NULL
   AND COALESCE(p."extendedAttributes"->>'directoryStatus', '') <> 'orphaned'
   AND EXISTS (
     SELECT 1
       FROM "_history" h
      WHERE h."tableName" = 'Principals'
        AND h."rowId" = p."id"::text
        AND (h."rowData"->>'systemId') = d."directorySystemId"::text
   );
