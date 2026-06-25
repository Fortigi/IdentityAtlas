// Contract test — scopedDelete against a real PostgreSQL schema.
//
// Verifies the SQL emitted by scopedDelete actually does what the unit tests
// cannot: confirm the DELETE / UPDATE runs against a real schema and that
// the scope-filtering WHERE clause produces the correct row selection.
//
// Spike: one test covering the soft-delete path (Principals) and one covering
// the hard-delete path. If both pass reliably in CI we expand to matrix.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { scopedDelete, SOFT_DELETE_TABLES } from './engine.js';

const { Pool } = pg;

let pool;
let systemId;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });

  // Insert a System row so foreign key constraints on Principals are satisfied.
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-test') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Clean state between tests — delete test data but leave schema intact.
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function insertPrincipal(externalId) {
  const r = await pool.query(
    `INSERT INTO "Principals" ("systemId", "externalId", "principalType")
     VALUES ($1, $2, 'User') RETURNING "id"`,
    [systemId, externalId],
  );
  return r.rows[0].id;
}

async function makeTempTable(client, name, ids) {
  await client.query(`CREATE TEMP TABLE IF NOT EXISTS "${name}" ("externalId" TEXT) ON COMMIT DROP`);
  for (const id of ids) {
    await client.query(`INSERT INTO "${name}" ("externalId") VALUES ($1)`, [id]);
  }
}

async function getDeletedAt(id) {
  const r = await pool.query(`SELECT "deletedAt" FROM "Principals" WHERE "id" = $1`, [id]);
  return r.rows[0]?.deletedAt ?? null;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('scopedDelete — soft-delete path (Principals)', () => {
  it('stamps deletedAt on rows absent from the temp table, leaves present rows untouched', async () => {
    expect(SOFT_DELETE_TABLES.has('Principals')).toBe(true);

    const keepId  = await insertPrincipal('keep-me');
    const wipeId  = await insertPrincipal('wipe-me');
    const wipe2Id = await insertPrincipal('wipe-me-too');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tempName = 'tmp_principals_spike';
      // Temp table contains only the "keep-me" row — the other two should be soft-deleted.
      await makeTempTable(client, tempName, ['keep-me']);

      const tableColumnNames = new Set(['systemId', 'externalId', 'deletedAt']);
      const deleted = await scopedDelete(
        client,
        'Principals',
        ['externalId'],
        tempName,
        systemId,
        {},
        'systemId',
        tableColumnNames,
      );
      await client.query('COMMIT');

      expect(deleted).toBe(2);
      expect(await getDeletedAt(keepId)).toBeNull();
      expect(await getDeletedAt(wipeId)).not.toBeNull();
      expect(await getDeletedAt(wipe2Id)).not.toBeNull();
    } finally {
      client.release();
    }
  });

  it('does not re-stamp deletedAt on an already-deleted row', async () => {
    const id = await insertPrincipal('already-gone');
    // Pre-stamp the row as deleted.
    const stamp = new Date('2020-01-01T00:00:00Z');
    await pool.query(`UPDATE "Principals" SET "deletedAt" = $1 WHERE "id" = $2`, [stamp, id]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tempName = 'tmp_principals_restamp';
      await makeTempTable(client, tempName, []); // empty — everything should be considered absent

      const tableColumnNames = new Set(['systemId', 'externalId', 'deletedAt']);
      const deleted = await scopedDelete(
        client, 'Principals', ['externalId'], tempName,
        systemId, {}, 'systemId', tableColumnNames,
      );
      await client.query('COMMIT');

      // The WHERE includes `deletedAt IS NULL`, so already-deleted rows are excluded.
      expect(deleted).toBe(0);
      const ts = await getDeletedAt(id);
      expect(ts?.toISOString()).toBe(stamp.toISOString());
    } finally {
      client.release();
    }
  });
});
