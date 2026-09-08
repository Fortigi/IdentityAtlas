// Contract test — matrix share links against the real migration-061 schema.
//
// The unit tests for routes/matrix/shares.js mock the DB, so they prove nothing
// about the SQL. This drives the actual statements the router emits — the
// insert, the token-hash lookup, the usage upsert, the idempotent revoke and
// the list query's LATERAL usage aggregate — against real PostgreSQL.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateShareToken, hashToken } from '../src/auth/shareTokens.js';

let pool;
const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };

async function insertShare({ name, token, displayMode = null, managed = null, createdBy = 'analyst@example.com' }) {
  const r = await pool.query(
    `INSERT INTO "MatrixShares" (id, "shareType", "name", "filter", "displayMode", "managed", "tokenHash", "createdBy")
     VALUES ($1, 'matrix', $2, $3, $4, $5, $6, $7)
     RETURNING id, "shareType", "name", "filter", "displayMode", "managed", "createdAt", "revokedAt"`,
    [randomUUID(), name, FILTER, displayMode, managed, hashToken(token), createdBy],
  );
  return r.rows[0];
}

async function stampUsage(shareId, userKey) {
  await pool.query(
    `INSERT INTO "MatrixShareAccesses" ("shareId", "userKey", "accessCount")
     VALUES ($1, $2, 1)
     ON CONFLICT ("shareId", "userKey") DO UPDATE
       SET "lastAccessAt" = now(),
           "accessCount"  = "MatrixShareAccesses"."accessCount" + 1`,
    [shareId, userKey],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "MatrixShares"`);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "MatrixShares"`);
});

describe('MatrixShares storage', () => {
  it('round-trips the snapshot and stores only the token hash', async () => {
    const token = generateShareToken();
    const row = await insertShare({ name: 'Sales team', token, displayMode: 'rotated', managed: 'gaps' });

    expect(row.filter).toEqual(FILTER);         // jsonb round-trip
    expect(row.displayMode).toBe('rotated');
    expect(row.managed).toBe('gaps');
    expect(row.shareType).toBe('matrix');       // column default
    expect(row.revokedAt).toBeNull();

    // No column anywhere holds the plaintext.
    const stored = (await pool.query(`SELECT * FROM "MatrixShares"`)).rows[0];
    expect(Object.values(stored)).not.toContain(token);
    expect(stored.tokenHash).toBe(hashToken(token));
  });

  it('resolves a share by token hash and refuses a duplicate hash', async () => {
    const token = generateShareToken();
    const created = await insertShare({ name: 'Sales team', token });

    const found = await pool.query(
      `SELECT id, "name" FROM "MatrixShares" WHERE "tokenHash" = $1`, [hashToken(token)],
    );
    expect(found.rows[0].id).toBe(created.id);

    // A different token must not resolve the same row.
    const miss = await pool.query(
      `SELECT id FROM "MatrixShares" WHERE "tokenHash" = $1`, [hashToken(generateShareToken())],
    );
    expect(miss.rowCount).toBe(0);

    await expect(insertShare({ name: 'Clone', token })).rejects.toMatchObject({ code: '23505' });
  });

  it('revokes softly and idempotently, keeping the first actor and timestamp', async () => {
    const created = await insertShare({ name: 'Old view', token: generateShareToken() });
    const revokeSql = `UPDATE "MatrixShares" s
                          SET "revokedAt" = COALESCE(s."revokedAt", now()),
                              "revokedBy" = COALESCE(s."revokedBy", $2)
                        WHERE s.id = $1
                        RETURNING s."revokedAt", s."revokedBy"`;

    const first = (await pool.query(revokeSql, [created.id, 'first@example.com'])).rows[0];
    expect(first.revokedBy).toBe('first@example.com');
    expect(first.revokedAt).not.toBeNull();

    const second = (await pool.query(revokeSql, [created.id, 'second@example.com'])).rows[0];
    expect(second.revokedBy).toBe('first@example.com');
    expect(second.revokedAt.getTime()).toBe(first.revokedAt.getTime());
  });
});

describe('MatrixShareAccesses usage tracking', () => {
  it('counts per user and preserves firstAccessAt across repeat visits', async () => {
    const share = await insertShare({ name: 'Sales team', token: generateShareToken() });

    await stampUsage(share.id, 'manager@example.com');
    const afterFirst = (await pool.query(
      `SELECT "firstAccessAt", "accessCount" FROM "MatrixShareAccesses" WHERE "userKey" = 'manager@example.com'`,
    )).rows[0];

    await stampUsage(share.id, 'manager@example.com');
    await stampUsage(share.id, 'owner@example.com');

    const rows = (await pool.query(
      `SELECT "userKey", "accessCount", "firstAccessAt" FROM "MatrixShareAccesses"
        WHERE "shareId" = $1 ORDER BY "userKey"`, [share.id],
    )).rows;

    expect(rows.map(r => [r.userKey, r.accessCount])).toEqual([
      ['manager@example.com', 2],
      ['owner@example.com', 1],
    ]);
    // The upsert must not reset when the same person returns.
    expect(rows[0].firstAccessAt.getTime()).toBe(afterFirst.firstAccessAt.getTime());
  });

  it('survives revocation but not deletion of its share', async () => {
    const share = await insertShare({ name: 'Sales team', token: generateShareToken() });
    await stampUsage(share.id, 'manager@example.com');

    await pool.query(`UPDATE "MatrixShares" SET "revokedAt" = now() WHERE id = $1`, [share.id]);
    expect((await pool.query(`SELECT 1 FROM "MatrixShareAccesses" WHERE "shareId" = $1`, [share.id])).rowCount).toBe(1);

    await pool.query(`DELETE FROM "MatrixShares" WHERE id = $1`, [share.id]);
    expect((await pool.query(`SELECT 1 FROM "MatrixShareAccesses" WHERE "shareId" = $1`, [share.id])).rowCount).toBe(0);
  });
});

describe('the shares list query', () => {
  const LIST_SQL = `
    SELECT s.id, s."name", s."revokedAt",
           COALESCE(u."accessCount", 0)::int AS "accessCount",
           COALESCE(u."userCount", 0)::int   AS "userCount",
           u."lastAccessAt",
           COALESCE(u."usage", '[]'::json)   AS "usage"
      FROM "MatrixShares" s
      LEFT JOIN LATERAL (
        SELECT SUM(a."accessCount")   AS "accessCount",
               COUNT(*)               AS "userCount",
               MAX(a."lastAccessAt")  AS "lastAccessAt",
               json_agg(json_build_object(
                 'userKey',       a."userKey",
                 'firstAccessAt', a."firstAccessAt",
                 'lastAccessAt',  a."lastAccessAt",
                 'accessCount',   a."accessCount"
               ) ORDER BY a."lastAccessAt" DESC) AS "usage"
          FROM "MatrixShareAccesses" a
         WHERE a."shareId" = s.id
      ) u ON TRUE
     ORDER BY s."createdAt" DESC`;

  it('reports zero usage for a never-opened share and aggregates the rest', async () => {
    const used = await insertShare({ name: 'Used', token: generateShareToken() });
    await pool.query(`SELECT pg_sleep(0.01)`);   // distinct createdAt ordering
    const unused = await insertShare({ name: 'Never opened', token: generateShareToken() });

    await stampUsage(used.id, 'manager@example.com');
    await stampUsage(used.id, 'manager@example.com');
    await stampUsage(used.id, 'owner@example.com');

    const byName = Object.fromEntries((await pool.query(LIST_SQL)).rows.map(r => [r.name, r]));

    // "Shared but never used" must be visible at a glance — zeros, not nulls.
    expect(byName['Never opened'].accessCount).toBe(0);
    expect(byName['Never opened'].userCount).toBe(0);
    expect(byName['Never opened'].usage).toEqual([]);
    expect(byName['Never opened'].lastAccessAt).toBeNull();

    expect(byName['Used'].accessCount).toBe(3);   // 2 + 1 across two people
    expect(byName['Used'].userCount).toBe(2);
    expect(byName['Used'].usage.map(u => u.userKey).sort())
      .toEqual(['manager@example.com', 'owner@example.com']);
    expect(byName['Used'].lastAccessAt).not.toBeNull();

    // Newest share first.
    const names = (await pool.query(LIST_SQL)).rows.map(r => r.name);
    expect(names).toEqual(['Never opened', 'Used']);
    expect(unused.id).toBeTruthy();
  });
});
