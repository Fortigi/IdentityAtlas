// Contract test — migration 074 against real PostgreSQL.
//
// Two halves, both invisible without real NULL semantics:
//   * the new partial unique index makes a second tenant-less system with the
//     same (systemType, displayName) impossible, while tenant systems and
//     tenant-less systems of another name are unaffected;
//   * the migration can be applied to an installation that already has the
//     duplicates re-runs created: it merges each group onto its newest row,
//     moves the rows still pointing at older copies, drops only the rows the
//     newest copy already holds under a system-scoped unique key, and then
//     builds the index.
//
// The merge case runs the migration file itself inside a transaction that is
// rolled back, so the shared contract database is left as it was.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(__dirname, '..', 'src', 'db', 'migrations', '074_systems_tenantless_key.sql'), 'utf8');
const INDEX = 'uq_Systems_systemType_displayName_noTenant';

let pool;
const run = crypto.randomBytes(4).toString('hex');
const TYPE = `TenantlessKey-${run}`;

beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL }); });
afterAll(async () => {
  await pool?.query(`DELETE FROM "Systems" WHERE "systemType" = $1`, [TYPE]);
  await pool?.end();
});

describe('migration 074 — the index', () => {
  it('rejects a second tenant-less system with the same type and name', async () => {
    await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Once')`, [TYPE]);
    await expect(pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Once')`, [TYPE]))
      .rejects.toMatchObject({ code: '23505', constraint: INDEX });
  });

  it('still allows the same name with a tenant, or under another type', async () => {
    await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Shared')`, [TYPE]);
    await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ($1, 'Shared', 't1'), ($1, 'Shared', 't2')`, [TYPE]);
    await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Shared')`, [`${TYPE}-other`]);
    await pool.query(`DELETE FROM "Systems" WHERE "systemType" = $1`, [`${TYPE}-other`]);
  });
});

describe('migration 074 — merging the duplicates re-runs left behind', () => {
  let result;

  beforeAll(async () => {
    const c = await pool.connect();
    const one = async (sql, params) => (await c.query(sql, params)).rows[0];
    try {
      await c.query('BEGIN');
      await c.query(`DROP INDEX "${INDEX}"`);
      const older = (await one(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Dup') RETURNING id`, [TYPE])).id;
      const newer = (await one(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Dup') RETURNING id`, [TYPE])).id;
      const solo = (await one(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, 'Solo') RETURNING id`, [TYPE])).id;
      const dependent = (await one(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId", "directorySystemId") VALUES ($1, 'Reader', 't-r', $2) RETURNING id`, [TYPE, older])).id;

      // A row the last run no longer re-homed (dropped from the source since).
      const stale = crypto.randomUUID();
      const current = crypto.randomUUID();
      await c.query(`INSERT INTO "Principals" (id, "systemId", "displayName", "principalType") VALUES ($1, $2, 'stale', 'User'), ($3, $4, 'current', 'User')`,
        [stale, older, current, newer]);

      const u1 = crypto.randomUUID();
      const u2 = crypto.randomUUID();
      await c.query(`INSERT INTO "SystemOwners" ("systemId", "userId") VALUES ($1, $3), ($1, $4), ($2, $3)`, [older, newer, u1, u2]);
      await c.query(`INSERT INTO "DeltaTokens" ("systemId", "endpoint", "token") VALUES ($1, 'users', 'old'), ($1, 'groups', 'g-old'), ($2, 'users', 'new')`, [older, newer]);

      const algo = crypto.randomUUID();
      await c.query(`INSERT INTO "ContextAlgorithms" (id, name, "displayName", "targetType") VALUES ($1, $2, 'x', 'Identity')`, [algo, `tk-${run}`]);
      const ctx = (id, sys, ext) => c.query(
        `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "scopeSystemId", "sourceAlgorithmId", "externalId")
         VALUES ($1, 'generated', 'Identity', 'Tag', $4, $2, $3, $4)`, [id, sys, algo, ext]);
      const ctxDupOld = crypto.randomUUID();
      const ctxDupNew = crypto.randomUUID();
      const ctxOnlyOld = crypto.randomUUID();
      await ctx(ctxDupOld, older, 'same');
      await ctx(ctxDupNew, newer, 'same');
      await ctx(ctxOnlyOld, older, 'only-old');

      await c.query(MIGRATION);

      const ids = (await c.query(`SELECT id FROM "Systems" WHERE "systemType" = $1 AND "displayName" IN ('Dup', 'Solo', 'Reader') ORDER BY id`, [TYPE])).rows;
      result = {
        older, newer, solo, dependent, ids,
        stale: (await one(`SELECT "systemId" FROM "Principals" WHERE id = $1`, [stale])).systemId,
        current: (await one(`SELECT "systemId" FROM "Principals" WHERE id = $1`, [current])).systemId,
        owners: (await c.query(`SELECT "userId" FROM "SystemOwners" WHERE "systemId" = $1 ORDER BY "userId"`, [newer])).rows.map(r => r.userId),
        expectedOwners: [u1, u2].sort(),
        tokens: (await c.query(`SELECT "endpoint", "token" FROM "DeltaTokens" WHERE "systemId" = $1 ORDER BY "endpoint"`, [newer])).rows,
        contexts: (await c.query(`SELECT id, "scopeSystemId" FROM "Contexts" WHERE "sourceAlgorithmId" = $1 ORDER BY "externalId"`, [algo])).rows,
        ctxDupNew, ctxOnlyOld,
        directory: (await one(`SELECT "directorySystemId" FROM "Systems" WHERE id = $1`, [dependent])).directorySystemId,
        index: (await one(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDEX]))?.indexdef,
      };
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('keeps the newest copy of each group and removes the older one', () => {
    expect(result.ids.map(s => s.id)).toEqual([result.newer, result.solo, result.dependent].sort((a, b) => a - b));
  });

  it('moves a row still pointing at the older copy onto the kept one', () => {
    expect(result.stale).toBe(result.newer);
    expect(result.current).toBe(result.newer);
  });

  it('moves a reference from another system, not only data rows', () => {
    expect(result.directory).toBe(result.newer);
  });

  it('keeps the kept copy\'s version where both held the same system-scoped key, and moves the rest', () => {
    expect(result.owners).toEqual(result.expectedOwners);
    expect(result.tokens).toEqual([{ endpoint: 'groups', token: 'g-old' }, { endpoint: 'users', token: 'new' }]);
    expect(result.contexts).toEqual([
      { id: result.ctxOnlyOld, scopeSystemId: result.newer },
      { id: result.ctxDupNew, scopeSystemId: result.newer },
    ]);
  });

  it('builds the partial unique index afterwards', () => {
    expect(result.index).toContain('("systemType", "displayName")');
    expect(result.index).toContain('"tenantId" IS NULL');
  });
});
