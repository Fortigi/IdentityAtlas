-- Migration 118: how a person's manager was set.
--
-- "Identities"."managerIdentityId" (the manager as a PERSON) used to be written
-- only when the source itself sent it. The manager of an ACCOUNT
-- ("Principals"."managerId") is stored for every source, so the ingest now also
-- derives the person-level manager through the account links
-- (ingest/identityManagers.js). The two writers must not fight: a manager the
-- source sent always wins, and a derived one is refreshed (or cleared) when the
-- accounts change. This column records which of the two wrote the value:
--
--   Source   the source sent it (normalization stamps this on ingest)
--   Derived  the ingest derived it from the person's linked accounts
--   NULL     no manager
--
-- Every manager that exists today was sent by a source, so existing values are
-- marked Source. Identities is a person-sized table (one row per person), so the
-- backfill and a validated CHECK are cheap.

ALTER TABLE "Identities" ADD COLUMN IF NOT EXISTS "managerIdentitySource" TEXT;

ALTER TABLE "Identities" DROP CONSTRAINT IF EXISTS "ck_Identities_managerIdentitySource";
ALTER TABLE "Identities" ADD CONSTRAINT "ck_Identities_managerIdentitySource"
    CHECK ("managerIdentitySource" IN ('Source', 'Derived'));

UPDATE "Identities" SET "managerIdentitySource" = 'Source'
 WHERE "managerIdentityId" IS NOT NULL AND "managerIdentitySource" IS NULL;
