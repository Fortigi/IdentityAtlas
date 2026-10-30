// Contract test — the owner a source names for a synced context becomes its
// Accountable (ingest/contextOwners.js), and migration 096 does the same once,
// insert-only. Against real PostgreSQL, because everything that matters here is
// what the SQL selects: which principal a tie resolves to, that an ambiguous
// employee number resolves to nobody, that an analyst's Accountable survives.
// Every assertion names the account the role landed on, not just a row count.
//
// Isolation on the shared contract DB: two private systems; everything this file
// creates is deleted in afterAll (the roles go with their contexts).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { reconcileBatchAccountables, reconcileSessionAccountables } = await import('../src/ingest/contextOwners.js');
const { OWNER_JOIN, OWNER_COLUMNS } = await import('../src/routes/contexts/read.js');

const MIGRATION_094 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '096_synced_context_accountables.sql'), 'utf8');

let pool;
let sys;
const P = {};
const C = {};
const runner = () => ({ query: (sql, params) => pool.query(sql, params) });

async function principal(name, sysIdx, externalId, employeeId, deleted = false) {
  const r = await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "externalId", "employeeId", "displayName", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
    [sys[sysIdx], externalId, employeeId, `own-${name}`, deleted ? new Date() : null]);
  P[name] = r.rows[0].id;
}

async function context(name, owner, { variant = 'synced', category = 'LogicalApplication', sysIdx = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", "ownerUserId")
     VALUES (gen_random_uuid(), $1, 'Resource', 'LogicalApplication', $2, $3, $4, $5) RETURNING id`,
    [variant, `own-${name}`, category, sys[sysIdx], owner]);
  C[name] = r.rows[0].id;
}

const role = (c, p, r, by) => pool.query(
  `INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, $3, $4)`, [C[c], P[p], r, by]);

// Every role on this file's contexts as "context:role:principal:addedBy".
async function roles(db = pool) {
  const r = await db.query(
    `SELECT c."displayName" AS c, p."displayName" AS p, r.role, r."addedBy"
       FROM "ContextRoles" r
       JOIN "Contexts" c ON c.id = r."contextId"
       JOIN "Principals" p ON p.id = r."principalId"
      WHERE c."scopeSystemId" = ANY($1::int[])`, [sys]);
  return r.rows.map(x => `${x.c.slice(4)}:${x.role}:${x.p.slice(4)}:${x.addedBy}`).sort();
}

async function dropContexts() {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = ANY($1::int[])`, [sys]);
}

// One context per case. Scope system 0 unless stated.
async function seed() {
  await dropContexts();
  await context('extId', 'E-A');            // externalId, two systems: own scope wins
  await context('otherScope', 'E-A', { sysIdx: 1 });
  await context('liveOverDeleted', 'E-D');  // deleted in own scope, live elsewhere: live wins
  await context('onlyDeleted', 'E-OD');     // the only match is soft-deleted: still that one
  await context('empId', '1001');           // no externalId match, one employeeId match
  await context('empAmbiguous', '2002');    // two live principals: nobody
  await context('empOneLive', '3003');      // one live, one deleted: the live one
  await context('manual', 'E-A', { variant: 'manual' });
  await context('segment', 'E-A', { category: 'Segment' });
  await context('analyst', 'E-A');
  await context('ownerReplaced', '1001');
  await context('ownerGone', '');
  await context('ownerUnresolvable', 'nobody');
  await context('crawlerNoOwner', '');      // POST /ingest/context-roles on a context without ownerUserId
  await context('crawlerOwnerDiffers', 'E-A');
  await context('responsibleOnly', 'E-A');
  await role('analyst', 'x', 'Accountable', 'analyst');
  await role('ownerReplaced', 'a', 'Accountable', 'sourceOwner');
  await role('ownerGone', 'a', 'Accountable', 'sourceOwner');
  await role('ownerUnresolvable', 'a', 'Accountable', 'sourceOwner');
  await role('crawlerNoOwner', 'x', 'Accountable', 'sync');
  await role('crawlerOwnerDiffers', 'x', 'Accountable', 'sync');
  await role('responsibleOnly', 'a', 'Responsible', 'analyst');
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const s = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('OwnerTest', 'owner-roles-1'), ('OwnerTest', 'owner-roles-2') RETURNING id`);
  sys = s.rows.map(r => r.id);
  await principal('a', 0, 'E-A', null);
  await principal('a2', 1, 'E-A', null);
  await principal('dead', 0, 'E-D', null, true);
  await principal('alive', 1, 'E-D', null);
  await principal('onlyDead', 0, 'E-OD', null, true);
  await principal('emp', 0, 'k1', '1001');
  await principal('amb1', 0, 'k2', '2002');
  await principal('amb2', 1, 'k3', '2002');
  await principal('empLive', 0, 'k4', '3003');
  await principal('empDead', 1, 'k5', '3003', true);
  await principal('x', 0, 'k6', null);
});

afterAll(async () => {
  await dropContexts();
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [sys]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [sys]);
  await pool.end();
});

// A crawler's own 'sync' Accountable stays put either way: with no owner on the
// context (crawlerNoOwner — the bug this marker fixed) and with an owner that
// names someone else (crawlerOwnerDiffers — an existing Accountable is never
// overwritten). Only the reconcile's own 'sourceOwner' rows move or go.
const AFTER_INGEST = [
  'analyst:Accountable:x:analyst',
  'crawlerNoOwner:Accountable:x:sync',
  'crawlerOwnerDiffers:Accountable:x:sync',
  'empId:Accountable:emp:sourceOwner',
  'empOneLive:Accountable:empLive:sourceOwner',
  'extId:Accountable:a:sourceOwner',
  'liveOverDeleted:Accountable:alive:sourceOwner',
  'onlyDeleted:Accountable:onlyDead:sourceOwner',
  'otherScope:Accountable:a2:sourceOwner',
  'ownerReplaced:Accountable:emp:sourceOwner',
  'responsibleOnly:Accountable:a:sourceOwner',
  'responsibleOnly:Responsible:a:analyst',
];

describe('synced owner → Accountable at ingest', () => {
  beforeEach(seed);

  it('resolves, replaces, removes and leaves alone exactly as specified', async () => {
    const counts = await reconcileBatchAccountables(runner(), 'Contexts', Object.values(C).map(id => ({ id })));
    expect(counts).toEqual({ set: 7, replaced: 1, removed: 2, unresolved: 2 });
    expect(await roles()).toEqual(AFTER_INGEST);
  });

  it('is idempotent: a second run changes nothing and still counts the unresolved', async () => {
    const batch = Object.values(C).map(id => ({ id }));
    await reconcileBatchAccountables(runner(), 'Contexts', batch);
    expect(await reconcileBatchAccountables(runner(), 'Contexts', batch)).toEqual({ set: 0, replaced: 0, removed: 0, unresolved: 2 });
    expect(await roles()).toEqual(AFTER_INGEST);
  });

  it('touches only the contexts of the batch', async () => {
    const counts = await reconcileBatchAccountables(runner(), 'Contexts', [{ id: C.extId }, { id: C.ownerGone }]);
    expect(counts).toEqual({ set: 1, replaced: 0, removed: 1, unresolved: 0 });
    expect(await roles()).toEqual([
      'analyst:Accountable:x:analyst', 'crawlerNoOwner:Accountable:x:sync',
      'crawlerOwnerDiffers:Accountable:x:sync', 'extId:Accountable:a:sourceOwner',
      'ownerReplaced:Accountable:a:sourceOwner', 'ownerUnresolvable:Accountable:a:sourceOwner',
      'responsibleOnly:Responsible:a:analyst',
    ]);
  });

  it('reads a session\'s contexts from its temp table', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE "_tmp_owner_test" (id uuid) ON COMMIT DROP`);
      await client.query(`INSERT INTO "_tmp_owner_test" VALUES ($1), ($2)`, [C.empId, C.ownerReplaced]);
      const counts = await reconcileSessionAccountables(client, 'Contexts', '_tmp_owner_test');
      await client.query('COMMIT');
      expect(counts).toEqual({ set: 1, replaced: 1, removed: 0, unresolved: 0 });
    } finally {
      client.release();
    }
  });

  it('shows the same owner on the read endpoints for an externalId match', async () => {
    const r = await pool.query(
      `SELECT c."displayName", ${OWNER_COLUMNS} FROM "Contexts" c ${OWNER_JOIN} WHERE c.id = ANY($1::uuid[]) ORDER BY 1`,
      [[C.liveOverDeleted, C.otherScope]]);
    expect(r.rows.map(x => x.ownerDisplayName)).toEqual(['own-alive', 'own-a2']);
  });
});

describe('migration 096 — catch-up, insert-only', () => {
  beforeEach(seed);

  // The migration is not scoped to this file's systems, so it runs in a
  // transaction that is rolled back: other files' contexts stay as they were.
  it('adds the resolvable owners and never replaces or removes an existing Accountable', async () => {
    const client = await pool.connect();
    let after;
    try {
      await client.query('BEGIN');
      await client.query(MIGRATION_094);
      after = await roles(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(after).toEqual([
      'analyst:Accountable:x:analyst',
      'crawlerNoOwner:Accountable:x:sync',
      'crawlerOwnerDiffers:Accountable:x:sync',
      'empId:Accountable:emp:sync',
      'empOneLive:Accountable:empLive:sync',
      'extId:Accountable:a:sync',
      'liveOverDeleted:Accountable:alive:sync',
      'onlyDeleted:Accountable:onlyDead:sync',
      'otherScope:Accountable:a2:sync',
      'ownerGone:Accountable:a:sourceOwner',
      'ownerReplaced:Accountable:a:sourceOwner',
      'ownerUnresolvable:Accountable:a:sourceOwner',
      'responsibleOnly:Accountable:a:sync',
      'responsibleOnly:Responsible:a:analyst',
    ]);
  });
});

// The crawler door (POST /ingest/context-roles) and the owner reconcile both
// speak for the source. The door's Accountable is addedBy 'sync'; the reconcile
// replaces or removes only its own 'sourceOwner' rows, so a role the door wrote
// on a context that names no owner survives the next contexts sync — the bug
// that once deleted every demo application's Accountable.
describe('an Accountable a crawler posted survives the owner sync', () => {
  beforeEach(seed);

  it('keeps the door\'s Accountable on a context with no owner, and still drops a stale owner row', async () => {
    const { roleInsertSql } = await import('../src/routes/ingest/contextLinks.js');
    await context('posted', '');
    const ins = await pool.query(roleInsertSql('principalId'),
      [C.posted, P.x, 'Accountable', sys[0], ['OrganizationalUnit', 'LogicalApplication']]);
    expect(ins.rowCount).toBe(1);

    const counts = await reconcileBatchAccountables(runner(), 'Contexts', [{ id: C.posted }, { id: C.ownerGone }]);

    expect(counts).toEqual({ set: 0, replaced: 0, removed: 1, unresolved: 0 });
    const after = await roles();
    expect(after).toContain('posted:Accountable:x:sync');
    expect(after.some(r => r.startsWith('ownerGone:'))).toBe(false);
  });
});
