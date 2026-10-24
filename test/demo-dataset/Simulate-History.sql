-- Simulate ~6 months of governance history for the demo dataset by back-dating
-- the audit-log (_history) events created during ingest. FOR DEV / TEST ONLY —
-- it rewrites _history.changedAt so the matrix scope timeline has a meaningful
-- trend to render and to assert against.
--
-- Story it creates:
--   * Everything exists from 180 days ago (baseline).
--   * Governed assignments come online progressively (role-mining progress),
--     so the governed % rises across the window.
--   * A wave of principals "joins" 60 days ago, so headcount steps up.
--
-- Run:  psql ... -f Simulate-History.sql   (then refresh nothing — reconstruction
--       reads _history + live tables directly).

BEGIN;

-- 0. Give every live row an insert event to back-date. A system's initial load
--    no longer writes one per row (migration 073) — only one anchor event per
--    table and system — so the demo's rows arrive without any. Synthesised with
--    the same rowId shape the audit trigger uses (migration 022), and only where
--    the row has no insert event yet, so running this twice adds nothing.
INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
SELECT 'Principals', p.id::text, 'I', to_jsonb(p) - 'photo', NULL
  FROM "Principals" p
 WHERE NOT EXISTS (SELECT 1 FROM "_history" h
                    WHERE h."tableName" = 'Principals' AND h."rowId" = p.id::text AND h."operation" = 'I');

INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
SELECT 'Resources', r.id::text, 'I', to_jsonb(r), NULL
  FROM "Resources" r
 WHERE NOT EXISTS (SELECT 1 FROM "_history" h
                    WHERE h."tableName" = 'Resources' AND h."rowId" = r.id::text AND h."operation" = 'I');

INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
SELECT 'ResourceAssignments', k.key, 'I', to_jsonb(ra), NULL
  FROM "ResourceAssignments" ra
 CROSS JOIN LATERAL (SELECT COALESCE(ra."resourceId"::text, '') || '|' || COALESCE(ra."principalId"::text, '') || '|' || COALESCE(ra."assignmentType", '') AS key) k
 WHERE NOT EXISTS (SELECT 1 FROM "_history" h
                    WHERE h."tableName" = 'ResourceAssignments' AND h."rowId" = k.key AND h."operation" = 'I');

-- 1. Baseline: every initial insert happened 180 days ago.
UPDATE "_history" SET "changedAt" = now() - INTERVAL '180 days';

-- 2. Stagger governed assignments forward to simulate progressive governance.
WITH g AS (
  SELECT id,
         row_number() OVER (ORDER BY "rowId") AS rn,
         count(*)     OVER ()                 AS total
    FROM "_history"
   WHERE "tableName" = 'ResourceAssignments'
     AND "operation" = 'I'
     AND ("rowData"->>'governed') = 'true'
)
UPDATE "_history" h
   SET "changedAt" = now() - (CASE
         WHEN g.rn <= g.total * 0.50 THEN INTERVAL '180 days'  -- governed from day one
         WHEN g.rn <= g.total * 0.70 THEN INTERVAL '120 days'
         WHEN g.rn <= g.total * 0.85 THEN INTERVAL '75 days'
         ELSE                              INTERVAL '20 days'   -- only recently governed
       END)
  FROM g
 WHERE g.id = h.id;

-- 3. A wave of principals joined 60 days ago (headcount growth).
WITH pr AS (
  SELECT id,
         row_number() OVER (ORDER BY "rowId") AS rn,
         count(*)     OVER ()                 AS total
    FROM "_history"
   WHERE "tableName" = 'Principals'
     AND "operation" = 'I'
)
UPDATE "_history" h
   SET "changedAt" = now() - INTERVAL '60 days'
  FROM pr
 WHERE pr.id = h.id
   AND pr.rn > pr.total * 0.80;

COMMIT;
