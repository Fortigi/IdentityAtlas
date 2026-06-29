// Contract test — read-token idle auto-revoke (revokeIdleTokens).
//
// Verifies, against the real ReadApiKeys schema, that a token unused for longer
// than the threshold is revoked, fresh tokens are left alone, never-used tokens
// age out on createdAt, already-revoked rows aren't re-touched, and that a
// non-positive threshold disables the sweep entirely. The interval math runs in
// postgres, so a unit test with a mocked DB couldn't catch a regression here.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { revokeIdleTokens } from '../src/auth/readTokens.js';

let pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ReadApiKeys"`);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ReadApiKeys"`);
});

describe('revokeIdleTokens', () => {
  it('revokes tokens idle past the threshold, keeps fresh ones', async () => {
    await pool.query(`
      INSERT INTO "ReadApiKeys" ("name","tokenHash","tokenPrefix","createdAt","lastUsedAt") VALUES
        ('idle-used',  'h1','fgr_aaaaaaaa', now() - interval '200 days', now() - interval '100 days'),
        ('fresh-used', 'h2','fgr_bbbbbbbb', now() - interval '200 days', now() - interval '2 days'),
        ('idle-never', 'h3','fgr_cccccccc', now() - interval '100 days', NULL),
        ('new-never',  'h4','fgr_dddddddd', now() - interval '2 days',   NULL)
    `);

    const revoked = await revokeIdleTokens(90, pool);
    expect(revoked.map(r => r.name).sort()).toEqual(['idle-never', 'idle-used']);

    const rows = (await pool.query(`SELECT name, revoked FROM "ReadApiKeys" ORDER BY name`)).rows;
    const byName = Object.fromEntries(rows.map(r => [r.name, r.revoked]));
    expect(byName['idle-used']).toBe(true);   // lastUsedAt 100d ago
    expect(byName['idle-never']).toBe(true);  // never used, createdAt 100d ago
    expect(byName['fresh-used']).toBe(false); // used 2d ago
    expect(byName['new-never']).toBe(false);  // created 2d ago, never used
  });

  it('does not re-touch already-revoked rows and no-ops when disabled', async () => {
    await pool.query(`
      INSERT INTO "ReadApiKeys" ("name","tokenHash","tokenPrefix","createdAt","lastUsedAt","revoked")
      VALUES ('already', 'h9','fgr_eeeeeeee', now() - interval '200 days', now() - interval '200 days', TRUE)
    `);

    expect(await revokeIdleTokens(0, pool)).toEqual([]);   // 0 = disabled
    expect(await revokeIdleTokens(-5, pool)).toEqual([]);  // negative = disabled
    expect(await revokeIdleTokens(90, pool)).toEqual([]);  // the one row is already revoked
  });
});
