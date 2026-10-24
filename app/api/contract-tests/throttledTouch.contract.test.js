// Contract test — a lastUsedAt stamp never waits behind another one (real PG16).
//
// One stamp per request, each waiting on the same row lock and holding a pool
// connection while it waited, exhausted the API's 10-connection pool during the
// staged full load at 41M rows (docs/architecture/scale-rehearsal.md, step 7).
// With FOR UPDATE SKIP LOCKED a stamp that finds the row locked does nothing and
// returns at once; this proves it against PostgreSQL, where lock waits are real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { skipLockedStampSql } from '../src/lib/throttledTouch.js';

let pool;
let id;
const SQL = skipLockedStampSql('Crawlers', 'lastUsedAt', `(now() AT TIME ZONE 'utc')`);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  id = (await pool.query(
    `INSERT INTO "Crawlers" ("displayName", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "permissions")
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    ["throttled-touch", Buffer.alloc(64), Buffer.alloc(32), "fgc_tt", "[]"])).rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Crawlers" WHERE id = $1`, [id]);
  await pool?.end();
});

describe('skip-locked lastUsedAt stamp', () => {
  it('stamps the row when nobody holds it', async () => {
    const r = await pool.query(SQL, [id]);
    expect(r.rowCount).toBe(1);
  });

  it('returns at once, having done nothing, while another transaction holds the row', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE "Crawlers" SET "lastUsedAt" = now() WHERE id = $1`, [id]);
      const c = await pool.connect();
      try {
        await c.query(`SET statement_timeout = '2s'`);   // a waiting stamp would fail here
        const t0 = Date.now();
        const r = await c.query(SQL, [id]);
        expect(r.rowCount).toBe(0);
        expect(Date.now() - t0).toBeLessThan(1000);
      } finally {
        c.release();
      }
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
