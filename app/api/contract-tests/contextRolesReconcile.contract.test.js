// Contract test — a full role sync (POST /ingest/context-roles with syncMode
// 'full', routes/ingest/contextLinks.js syncRolesFull) against real PostgreSQL.
// What matters is what the DELETE selects: only the system's own 'sync' rows on
// its synced contexts of the one contextType, and only those the batch no longer
// states. Every assertion names the role, holder and marker that remain.
//
// Isolation on the shared contract DB: two private systems; everything this
// file creates is deleted in afterAll (the roles go with their contexts).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { syncRolesFull } = await import('../src/routes/ingest/contextLinks.js');

const TYPE = 'AccessPackageCatalog';
let pool;
let sys;
const P = {};
const C = {};

async function principal(name) {
  const r = await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "displayName") VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [sys[0], `rec-${name}`]);
  P[name] = r.rows[0].id;
}

async function context(name, { type = TYPE, category = 'Catalog', variant = 'synced', sysIdx = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId")
     VALUES (gen_random_uuid(), $1, 'Resource', $2, $3, $4, $5) RETURNING id`,
    [variant, type, `rec-${name}`, category, sys[sysIdx]]);
  C[name] = r.rows[0].id;
}

const role = (c, p, r, by) => pool.query(
  `INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, $3, $4)`, [C[c], P[p], r, by]);

// Every role on this file's contexts as "context:role:principal:addedBy".
async function roles() {
  const r = await pool.query(
    `SELECT c."displayName" AS c, p."displayName" AS p, r.role, r."addedBy"
       FROM "ContextRoles" r
       JOIN "Contexts" c ON c.id = r."contextId"
       JOIN "Principals" p ON p.id = r."principalId"
      WHERE c."scopeSystemId" = ANY($1::int[])`, [sys]);
  return r.rows.map(x => `${x.c.slice(4)}:${x.role}:${x.p.slice(4)}:${x.addedBy}`).sort();
}

const row = (c, r, p) => ({ contextId: C[c], role: r, holderCol: 'principalId', holderId: P[p] });

async function seed() {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = ANY($1::int[])`, [sys]);
  await context('ownerChanged');                       // sync Accountable a -> the source now names b
  await context('ownerGone');                          // sync Responsible a is gone; the analyst's x stays
  await context('kept');                               // sync Responsible x stated again: stays
  await context('sourceOwner');                        // the owner reconcile's row is never touched
  await context('app', { type: 'LogicalApplication', category: 'LogicalApplication' }); // other type
  await context('otherSystem', { sysIdx: 1 });          // other system's catalog
  await role('ownerChanged', 'a', 'Accountable', 'sync');
  await role('ownerGone', 'a', 'Responsible', 'sync');
  await role('ownerGone', 'x', 'Responsible', 'analyst');
  await role('kept', 'x', 'Responsible', 'sync');
  await role('sourceOwner', 'a', 'Accountable', 'sourceOwner');
  await role('app', 'a', 'Responsible', 'sync');
  await role('otherSystem', 'a', 'Responsible', 'sync');
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const s = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('RoleSyncTest', 'role-sync-1'), ('RoleSyncTest', 'role-sync-2') RETURNING id`);
  sys = s.rows.map(r => r.id);
  for (const n of ['a', 'b', 'x']) await principal(n);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = ANY($1::int[])`, [sys]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [sys]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [sys]);
  await pool.end();
});

describe('a full role sync', () => {
  beforeEach(seed);

  it('replaces and removes only its own rows, on its own contexts of that type', async () => {
    const counts = await syncRolesFull(sys[0], TYPE, [
      row('ownerChanged', 'Accountable', 'b'),
      row('kept', 'Responsible', 'x'),
      row('sourceOwner', 'Responsible', 'b'),
    ]);

    expect(counts).toEqual({ inserted: 2, skipped: 1, removed: 2 });
    expect(await roles()).toEqual([
      'app:Responsible:a:sync',                 // another contextType: not this sync's
      'kept:Responsible:x:sync',                // stated again: kept, not re-added
      'otherSystem:Responsible:a:sync',         // another system: not this sync's
      'ownerChanged:Accountable:b:sync',        // the old Accountable went first, so the new one fits
      'ownerGone:Responsible:x:analyst',        // an analyst's choice survives
      'sourceOwner:Accountable:a:sourceOwner',  // the owner reconcile's row survives
      'sourceOwner:Responsible:b:sync',
    ]);
  });

  it('an empty batch removes every sync role of that type on the system, and nothing else', async () => {
    const counts = await syncRolesFull(sys[0], TYPE, []);
    expect(counts).toEqual({ inserted: 0, skipped: 0, removed: 3 });
    expect(await roles()).toEqual([
      'app:Responsible:a:sync',
      'otherSystem:Responsible:a:sync',
      'ownerGone:Responsible:x:analyst',
      'sourceOwner:Accountable:a:sourceOwner',
    ]);
  });

  it('keeps an analyst\'s Accountable: the source\'s other owner does not replace it', async () => {
    await pool.query(`DELETE FROM "ContextRoles" WHERE "contextId" = $1`, [C.ownerChanged]);
    await role('ownerChanged', 'x', 'Accountable', 'analyst');
    const counts = await syncRolesFull(sys[0], TYPE, [row('ownerChanged', 'Accountable', 'b'), row('kept', 'Responsible', 'x')]);
    expect(counts.inserted).toBe(0);
    expect((await roles()).filter(r => r.startsWith('ownerChanged:'))).toEqual(['ownerChanged:Accountable:x:analyst']);
  });

  it('rolls the removal back when an insert fails', async () => {
    await expect(syncRolesFull(sys[0], TYPE, [{ ...row('kept', 'Responsible', 'x'), role: 'Owner' }])).rejects.toThrow();
    expect(await roles()).toContain('ownerChanged:Accountable:a:sync');
  });
});
