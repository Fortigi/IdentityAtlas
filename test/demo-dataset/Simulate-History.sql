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
     AND ("rowData"->>'assignmentType') = 'Governed'
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
