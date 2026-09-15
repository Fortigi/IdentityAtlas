// Contract test — CrawlerAuditLog per-crawler cap (SEC-2026-09 M-04).
//
// The window-function DELETE only means something against the real schema: it
// must keep the newest N rows of EACH crawler (by timestamp, id as tiebreak) and
// leave a crawler already under the cap untouched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { capCrawlerAuditLog } from '../src/lib/crawlerAuditLogCap.js';

const MARK = 'contract-audit-cap';
let pool;

async function insertCrawler(name) {
  const r = await pool.query(
    `INSERT INTO "Crawlers" ("displayName","apiKeyHash","apiKeySalt","apiKeyPrefix","createdBy")
     VALUES ($1, '\\x00'::bytea, '\\x00'::bytea, 'fgc_test', $2) RETURNING id`,
    [name, MARK]
  );
  return r.rows[0].id;
}

async function insertAudit(crawlerId, action, minutesAgo) {
  await pool.query(
    `INSERT INTO "CrawlerAuditLog" ("crawlerId","action","timestamp")
     VALUES ($1, $2, now() - ($3::int * interval '1 minute'))`,
    [crawlerId, action, minutesAgo]
  );
}

async function actionsOf(crawlerId) {
  const r = await pool.query(
    `SELECT action FROM "CrawlerAuditLog" WHERE "crawlerId" = $1 ORDER BY action`,
    [crawlerId]
  );
  return r.rows.map(x => x.action);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  // CrawlerAuditLog rows cascade with their crawler.
  await pool?.query(`DELETE FROM "Crawlers" WHERE "createdBy" = $1`, [MARK]);
  await pool?.end();
});

describe('capCrawlerAuditLog', () => {
  it('keeps only the newest N rows per crawler and leaves small crawlers alone', async () => {
    const noisy = await insertCrawler('audit-cap-noisy');
    const quiet = await insertCrawler('audit-cap-quiet');
    // Inserted out of chronological order so id order != timestamp order.
    await insertAudit(noisy, 'n-oldest', 50);
    await insertAudit(noisy, 'n-newest', 1);
    await insertAudit(noisy, 'n-middle', 20);
    await insertAudit(noisy, 'n-second', 5);
    await insertAudit(quiet, 'q-only', 100);

    const removed = await capCrawlerAuditLog(pool, 2);

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await actionsOf(noisy)).toEqual(['n-newest', 'n-second']);
    expect(await actionsOf(quiet)).toEqual(['q-only']);
  });
});
