-- Identity Atlas — record which crawler wrote a sync-log row (SEC-2026-09 M-05).
--
-- POST /api/ingest/sync-log lets a crawler add its end-of-run summary to the Sync
-- Log page. The row said nothing about who wrote it, so any crawler key could
-- add entries indistinguishable from another crawler's. The API now stamps the
-- authenticated crawler, and the system when the caller names one it may access.
-- Both are nullable: rows written before this migration, and the per-batch rows
-- the ingest engine writes itself, carry neither.

ALTER TABLE "GraphSyncLog" ADD COLUMN IF NOT EXISTS "crawlerId" INTEGER;
ALTER TABLE "GraphSyncLog" ADD COLUMN IF NOT EXISTS "systemId"  INTEGER;
