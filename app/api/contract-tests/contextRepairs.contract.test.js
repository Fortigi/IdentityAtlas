// Contract test — migration 105 against real PostgreSQL. Every case runs in a
// transaction that is rolled back: the migration is not scoped to this file's
// rows, and one case puts ContextRelationships back into the shape the first
// 092 left (DedicatedTo, ordered triple key, no _history triggers), which other
// files must never see. DDL is transactional in PostgreSQL, so ROLLBACK undoes it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const MIGRATION_105 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '105_context_repairs.sql'), 'utf8');

let pool;
beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL }); });
afterAll(async () => { await pool.end(); });

async function inRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function seed(client) {
  const sys = (await client.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('RepairTest', 'repair-105') RETURNING id`)).rows[0].id;
  const principal = async (name) => (await client.query(
    `INSERT INTO "Principals" (id, "systemId", "externalId", "displayName") VALUES (gen_random_uuid(), $1, $2, $2) RETURNING id`,
    [sys, `rep-${name}`])).rows[0].id;
  const context = async (name, { variant = 'synced', owner = null, targetType = 'Principal' } = {}) => (await client.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", "ownerUserId")
     VALUES (gen_random_uuid(), $1, $2, 'Team', $3, 'OrganizationalUnit', $4, $5) RETURNING id`,
    [variant, targetType, `rep-${name}`, sys, owner])).rows[0].id;
  return { sys, principal, context };
}

const roleOf = async (client, contextId) => (await client.query(
  `SELECT "addedBy" FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [contextId])).rows.map(r => r.addedBy);

describe('migration 105 — the owner marker', () => {
  it('relabels a sync Accountable on a synced context with an owner, and nothing else', async () => {
    const got = await inRollback(async (client) => {
      const { principal, context } = await seed(client);
      const p = await principal('p');
      const ctx = {
        owned: await context('owned', { owner: 'rep-p' }),
        noOwner: await context('noOwner', { owner: '' }),
        manual: await context('manual', { variant: 'manual', owner: 'rep-p' }),
        analyst: await context('analyst', { owner: 'rep-p' }),
      };
      const add = (c, by) => client.query(
        `INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', $3)`, [c, p, by]);
      await add(ctx.owned, 'sync');
      await add(ctx.noOwner, 'sync');
      await add(ctx.manual, 'sync');
      await add(ctx.analyst, 'analyst');
      await client.query(MIGRATION_105);
      await client.query(MIGRATION_105); // re-runnable
      const out = {};
      for (const [k, id] of Object.entries(ctx)) out[k] = await roleOf(client, id);
      return out;
    });
    expect(got).toEqual({
      owned: ['sourceOwner'],   // the reconcile's row: it keeps it in step from now on
      noOwner: ['sync'],        // a crawler's: the reconcile leaves it alone
      manual: ['sync'],
      analyst: ['analyst'],
    });
  });

  it('lets ContextRoles take sourceOwner and still refuses an unknown addedBy', async () => {
    await inRollback(async (client) => {
      const { principal, context } = await seed(client);
      const p = await principal('p');
      const c = await context('c');
      await client.query(MIGRATION_105);
      await client.query(
        `INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Responsible', 'sourceOwner')`, [c, p]);
      await client.query('SAVEPOINT bad');
      await expect(client.query(
        `INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'crawler')`, [c, p]))
        .rejects.toThrow(/ContextRoles_addedBy_check/);
      await client.query('ROLLBACK TO SAVEPOINT bad');
    });
  });
});

describe('migration 105 — a database that ran the first 092', () => {
  it('converts DedicatedTo to one SameUnitAs per pair and restores the index and triggers', async () => {
    const got = await inRollback(async (client) => {
      const { context } = await seed(client);
      const people = await context('people');
      const resources = await context('resources', { targetType: 'Resource' });
      // The shape the first 092 left behind.
      await client.query(`DROP INDEX "ux_ContextRelationships_pair"`);
      await client.query(`ALTER TABLE "ContextRelationships" DROP CONSTRAINT "ContextRelationships_relationshipType_check"`);
      await client.query(`ALTER TABLE "ContextRelationships" ADD CONSTRAINT "ContextRelationships_relationshipType_check" CHECK ("relationshipType" IN ('DedicatedTo'))`);
      await client.query(`ALTER TABLE "ContextRelationships" ADD CONSTRAINT "ux_ContextRelationships_triple" UNIQUE ("contextId", "relatedContextId", "relationshipType")`);
      for (const t of ['ContextRoles', 'ContextRelationships']) {
        await client.query(`DROP TRIGGER IF EXISTS trg_history_ins_del ON "${t}"`);
      }
      await client.query(`DROP TRIGGER IF EXISTS trg_history_upd ON "ContextRoles"`);
      await client.query(
        `INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy", "createdAt")
         VALUES ($1, $2, 'DedicatedTo', 'analyst', now() - interval '1 day'), ($2, $1, 'DedicatedTo', 'analyst', now())`,
        [resources, people]);

      await client.query(MIGRATION_105);

      const rels = (await client.query(
        `SELECT "contextId", "relationshipType" FROM "ContextRelationships" WHERE $1 IN ("contextId", "relatedContextId")`, [people])).rows;
      const triggers = (await client.query(
        `SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger
          WHERE tgrelid IN ('"ContextRoles"'::regclass, '"ContextRelationships"'::regclass) AND tgname LIKE 'trg_history%'
          ORDER BY 1, 2`)).rows.map(r => `${r.t}:${r.tgname}`);
      const indexes = (await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ContextRelationships' AND indexname LIKE 'ux_%'`)).rows.map(r => r.indexname);
      // The pair index refuses the mirror image now.
      await client.query('SAVEPOINT mirror');
      let mirror = null;
      try {
        await client.query(
          `INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy") VALUES ($1, $2, 'SameUnitAs', 'analyst')`,
          [people, resources]);
      } catch (err) { mirror = err.message; }
      await client.query('ROLLBACK TO SAVEPOINT mirror');
      return { rels, triggers, indexes, mirror };
    });
    // The older of the two rows survives — the one stored resources → people.
    expect(got.rels).toHaveLength(1);
    expect(got.rels[0].relationshipType).toBe('SameUnitAs');
    expect(got.triggers).toEqual([
      '"ContextRelationships":trg_history_ins_del',
      '"ContextRoles":trg_history_ins_del',
      '"ContextRoles":trg_history_upd',
    ]);
    expect(got.indexes).toEqual(['ux_ContextRelationships_pair']);
    expect(got.mirror).toMatch(/ux_ContextRelationships_pair/);
  });

  it('leaves a correct database as it was', async () => {
    const got = await inRollback(async (client) => {
      const { context } = await seed(client);
      const a = await context('a');
      const b = await context('b', { targetType: 'Resource' });
      await client.query(
        `INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy") VALUES ($1, $2, 'SameUnitAs', 'analyst')`, [a, b]);
      const before = (await client.query(`SELECT id FROM "ContextRelationships" WHERE "contextId" = $1`, [a])).rows;
      await client.query(MIGRATION_105);
      const after = (await client.query(`SELECT id, "relationshipType" FROM "ContextRelationships" WHERE "contextId" = $1`, [a])).rows;
      return { before, after };
    });
    expect(got.after).toEqual([{ id: got.before[0].id, relationshipType: 'SameUnitAs' }]);
  });
});
