-- Migration 074 — a system without a tenant is identified by its type and name.
--
-- WHY
-- Systems are upserted on UNIQUE ("systemType", "tenantId") (migration 006).
-- PostgreSQL treats NULLs as distinct in a unique constraint, so for a system
-- registered without a tenantId — every CSV system, the CSV crawler's fallback
-- system — the conflict never fires and every registration inserts a new row.
-- Each re-run of an unchanged crawler configuration therefore created a second
-- copy of each of its systems, re-homed every principal, resource and assignment
-- onto the new ids (a real column change, so one history row with two JSON
-- snapshots per row), and orphaned the old ones. On the scale rig, two runs over
-- identical files left 84 systems instead of 42 and grew "_history" from 4.1 GB
-- to 10 GB.
--
-- WHAT
-- For a tenant-less system the display name is already the identity everything
-- else uses: every CSV file's SystemName column names a system by it, and the
-- ingest's systemIds lookup falls back to it. This makes it the key:
--
--   UNIQUE ("systemType", "displayName") WHERE "tenantId" IS NULL
--
-- and the ingest targets that index for records that carry no tenantId. Systems
-- with a tenant keep their (systemType, tenantId) key unchanged. NULLS NOT
-- DISTINCT on the old constraint was rejected: it would fold every tenant-less
-- system of one type — all the rows of one Systems.csv — into a single row.
--
-- EXISTING DUPLICATES
-- The index cannot be built while duplicates exist, and any installation that
-- re-ran a CSV crawler has them. Each group of duplicates is merged onto its
-- newest row (MAX(id)): that is the one the last run wrote its rows to and the
-- one the systemIds lookup has been returning. Rows still pointing at an older
-- copy are moved onto it. Where a unique key includes the system column
-- (SystemOwners, DeltaTokens, generated Contexts), a row of the older copy that
-- the newest one already has is dropped first — the newest one's version is the
-- current one. Then the older copies are deleted. A key this migration does not
-- know about raises instead of letting the delete cascade over its rows.

CREATE TEMP TABLE "_systems_merge" ON COMMIT DROP AS
SELECT id AS loser, keep
  FROM (SELECT id, MAX(id) OVER (PARTITION BY "systemType", "displayName") AS keep
          FROM "Systems"
         WHERE "tenantId" IS NULL) s
 WHERE id <> keep;

-- Rows the surviving system already holds under a system-scoped unique key.
DELETE FROM "SystemOwners" o USING "_systems_merge" m
 WHERE o."systemId" = m.loser
   AND EXISTS (SELECT 1 FROM "SystemOwners" k WHERE k."systemId" = m.keep AND k."userId" = o."userId");

DELETE FROM "DeltaTokens" d USING "_systems_merge" m
 WHERE d."systemId" = m.loser
   AND EXISTS (SELECT 1 FROM "DeltaTokens" k WHERE k."systemId" = m.keep AND k."endpoint" = d."endpoint");

DELETE FROM "Contexts" c USING "_systems_merge" m
 WHERE c."scopeSystemId" = m.loser
   AND c."sourceAlgorithmId" IS NOT NULL AND c."externalId" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "Contexts" k
                WHERE k."scopeSystemId" = m.keep
                  AND k."sourceAlgorithmId" = c."sourceAlgorithmId"
                  AND COALESCE(k."sourceInstanceKey", '') = COALESCE(c."sourceInstanceKey", '')
                  AND k."externalId" = c."externalId");

-- Move everything else: every single-column foreign key onto Systems(id),
-- discovered from the catalog so a table added later is not missed.
DO $$
DECLARE
  fk record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_systems_merge") THEN
    RETURN;
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = '"Systems"'::regclass
       AND array_length(c.conkey, 1) = 1
  LOOP
    BEGIN
      EXECUTE format('UPDATE %s t SET %I = m.keep FROM "_systems_merge" m WHERE t.%I = m.loser',
                     fk.tbl, fk.col, fk.col);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Merging duplicate systems: %.% has a unique key this migration does not reconcile (%)',
                      fk.tbl, fk.col, SQLERRM;
    END;
  END LOOP;
END $$;

-- The sync log names a system without a foreign key.
UPDATE "GraphSyncLog" g SET "systemId" = m.keep
  FROM "_systems_merge" m
 WHERE g."systemId" = m.loser;

DELETE FROM "Systems" s USING "_systems_merge" m WHERE s.id = m.loser;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_Systems_systemType_displayName_noTenant"
  ON "Systems" ("systemType", "displayName")
  WHERE "tenantId" IS NULL;
