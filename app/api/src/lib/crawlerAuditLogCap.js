// Bound the growth of "CrawlerAuditLog" (SEC-2026-09 M-04).
//
// Every crawler authentication failure, rate-limit hit and ingest batch writes a
// row, and nothing ever removed them — a client repeatedly failing against a
// known key prefix could grow the table without limit. The periodic prune job
// (bootstrap.js) keeps only the newest N rows per crawler. The Admin → Crawlers
// audit view pages newest-first, so the rows that remain are the ones shown.
//
// CRAWLER_AUDIT_LOG_MAX_ROWS overrides the per-crawler cap; 0 disables it.
// db is injected so the SQL can be exercised against a real database.

export const DEFAULT_MAX_ROWS_PER_CRAWLER = 10_000;

export function resolveAuditLogCap(env = process.env) {
  const raw = env.CRAWLER_AUDIT_LOG_MAX_ROWS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_ROWS_PER_CRAWLER;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_ROWS_PER_CRAWLER;
}

// Delete all but the newest `maxRowsPerCrawler` rows of each crawler.
// Returns the number of rows removed. A non-positive / invalid cap is a no-op.
export async function capCrawlerAuditLog(db, maxRowsPerCrawler) {
  if (!Number.isInteger(maxRowsPerCrawler) || maxRowsPerCrawler <= 0) return 0;
  const res = await db.query(
    `DELETE FROM "CrawlerAuditLog" a
      USING (
        SELECT id FROM (
          SELECT id,
                 row_number() OVER (PARTITION BY "crawlerId" ORDER BY "timestamp" DESC, id DESC) AS rn
            FROM "CrawlerAuditLog"
        ) ranked
        WHERE ranked.rn > $1
      ) excess
      WHERE a.id = excess.id`,
    [maxRowsPerCrawler]
  );
  return res.rowCount || 0;
}
