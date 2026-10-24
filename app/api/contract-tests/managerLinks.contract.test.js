// Contract test — the manager relationship end to end against real PostgreSQL:
// a crawler sends `managerExternalId`, the ingest resolves it, and the row it
// points at is THE MANAGER — not merely a non-null uuid.
//
// That distinction is the whole test. Resolution is a hash of
// "<system>-principals:<externalId>", so it always produces a well-formed uuid,
// whether or not that person exists and whether or not the namespace was the
// right one. A test asserting `managerId IS NOT NULL` passes just as happily
// against a link into the Identities namespace, which points at nothing.
// So every assertion here joins through the link and names the row it lands on.
//
// Isolation on the shared contract DB: two private systems, and everything this
// file creates is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { normalizeRecords } = await import('../src/ingest/normalization.js');
const { ingest } = await import('../src/ingest/engine.js');
const { repairManagerLinks, batchHasManagerLink } = await import('../src/ingest/managerLinks.js');

let pool;
let sysA;
let sysB;

const PRINCIPAL_COLUMNS = [
  'id', 'systemId', 'displayName', 'principalType', 'externalId', 'managerId', 'accountEnabled',
  'department', 'jobTitle', 'email', 'extendedAttributes',
];

// What a crawler actually posts: an externalId per person, and the manager named
// by the manager's OWN externalId. No internal id anywhere.
function shape(records, systemPrefix) {
  return normalizeRecords(records, PRINCIPAL_COLUMNS, {
    idGeneration: 'deterministic',
    idPrefix: `${systemPrefix}-principals`,
    systemPrefix,
    systemId: systemPrefix === 'mgrA' ? sysA : sysB,
  });
}

const asRunner = () => ({ query: (sql, params) => pool.query(sql, params) });

async function load(records, systemPrefix = 'mgrA') {
  const systemId = systemPrefix === 'mgrA' ? sysA : sysB;
  const normalized = shape(records, systemPrefix);
  await ingest(null, 'Principals', ['id'], normalized, { syncMode: 'delta', systemId, scope: {} });
  return repairManagerLinks(asRunner(), 'Principals', systemId, batchHasManagerLink(normalized));
}

// The manager as the database resolves it: follow the link and report who it hit.
async function managerOf(externalId) {
  const r = await pool.query(
    `SELECT m."externalId" AS "managerExternalId", m."displayName" AS "managerName", p."managerId"
       FROM "Principals" p
       LEFT JOIN "Principals" m ON m.id = p."managerId"
      WHERE p."externalId" = $1 AND p."systemId" = ANY($2::int[])`,
    [externalId, [sysA, sysB]],
  );
  return r.rows[0];
}

const person = (externalId, displayName, managerExternalId) => ({
  externalId, displayName, principalType: 'User', accountEnabled: true,
  ...(managerExternalId === undefined ? {} : { managerExternalId }),
});

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysA = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-mgr-A') RETURNING id`)).rows[0].id;
  sysB = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-mgr-B') RETURNING id`)).rows[0].id;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [[sysA, sysB]]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [[sysA, sysB]]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [[sysA, sysB]]);
  await pool?.end();
});

describe('manager relationship — resolved link', () => {
  it('points at the manager, by name, not merely at something', async () => {
    const repair = await load([
      person('boss', 'Bea Boss'),
      person('alice', 'Alice A', 'boss'),
      person('bob', 'Bob B', 'boss'),
      person('carol', 'Carol C', 'alice'),
    ]);
    expect(repair).toBeNull();

    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'boss', managerName: 'Bea Boss' });
    expect(await managerOf('bob')).toMatchObject({ managerExternalId: 'boss', managerName: 'Bea Boss' });
    // Two levels: Carol's manager is Alice, who has a manager of her own.
    expect(await managerOf('carol')).toMatchObject({ managerExternalId: 'alice', managerName: 'Alice A' });
    expect((await managerOf('boss')).managerId).toBeNull();
  });

  it('links a manager that arrives AFTER the report in the same load', async () => {
    await load([person('alice', 'Alice A', 'boss'), person('boss', 'Bea Boss')]);
    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'boss' });
  });

  it('links a manager already in the table from an earlier load', async () => {
    await load([person('boss', 'Bea Boss')]);
    const repair = await load([person('alice', 'Alice A', 'boss')]);
    expect(repair).toBeNull();
    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'boss' });
  });

  it('feeds the direct-reports query the org chart actually uses', async () => {
    await load([person('boss', 'Bea Boss'), person('alice', 'Alice A', 'boss'), person('bob', 'Bob B', 'boss')]);
    const boss = await pool.query(`SELECT id FROM "Principals" WHERE "externalId" = 'boss' AND "systemId" = $1`, [sysA]);
    const reports = await pool.query(
      `SELECT "displayName" FROM "Principals" WHERE "managerId" = $1 ORDER BY "displayName"`, [boss.rows[0].id]);
    expect(reports.rows.map(r => r.displayName)).toEqual(['Alice A', 'Bob B']);
  });

  it('keeps each system in its own namespace — the same key is a different person', async () => {
    await load([person('boss', 'A Boss'), person('alice', 'A Alice', 'boss')], 'mgrA');
    await load([person('boss', 'B Boss'), person('alice', 'B Alice', 'boss')], 'mgrB');
    const rows = await pool.query(
      `SELECT p."systemId", m."displayName" AS "managerName"
         FROM "Principals" p JOIN "Principals" m ON m.id = p."managerId"
        WHERE p."externalId" = 'alice' AND p."systemId" = ANY($1::int[]) ORDER BY p."systemId"`,
      [[sysA, sysB]]);
    expect(rows.rows.map(r => r.managerName).sort()).toEqual(['A Boss', 'B Boss']);
  });
});

describe('manager relationship — a manager nobody loaded', () => {
  it('leaves the column null and counts it, rather than storing an id that goes nowhere', async () => {
    const repair = await load([person('alice', 'Alice A', 'ghost'), person('bob', 'Bob B')]);
    expect(repair).toEqual({ unresolved: 1, selfReferences: 0 });

    const alice = await managerOf('alice');
    expect(alice.managerId).toBeNull();
    // Not "the join found nobody" — the column itself must be empty, because
    // `hasManager` asks only whether it is set.
    const stillSet = await pool.query(
      `SELECT count(*)::int AS n FROM "Principals" WHERE "systemId" = $1 AND "managerId" IS NOT NULL`, [sysA]);
    expect(stillSet.rows[0].n).toBe(0);
  });

  it('clears a principal that names itself as manager', async () => {
    const repair = await load([person('alice', 'Alice A', 'alice')]);
    expect(repair).toEqual({ unresolved: 0, selfReferences: 1 });
    expect((await managerOf('alice')).managerId).toBeNull();
  });

  it('counts both kinds separately in one load', async () => {
    const repair = await load([
      person('boss', 'Bea Boss', 'boss'),
      person('alice', 'Alice A', 'ghost'),
      person('bob', 'Bob B', 'ghost2'),
      person('carol', 'Carol C', 'boss'),
    ]);
    expect(repair).toEqual({ unresolved: 2, selfReferences: 1 });
    // The one good link is untouched.
    expect(await managerOf('carol')).toMatchObject({ managerExternalId: 'boss' });
  });

  it('does not touch another system\'s links', async () => {
    await load([person('boss', 'B Boss'), person('alice', 'B Alice', 'boss')], 'mgrB');
    const repair = await load([person('dave', 'Dave D', 'ghost')], 'mgrA');
    expect(repair).toEqual({ unresolved: 1, selfReferences: 0 });
    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'boss' });
  });

  it('re-links on the next load once the manager exists — the clear is not permanent', async () => {
    expect(await load([person('alice', 'Alice A', 'late')])).toEqual({ unresolved: 1, selfReferences: 0 });
    expect((await managerOf('alice')).managerId).toBeNull();

    // The same full sync, run again after the manager appeared.
    const repair = await load([person('late', 'Late Manager'), person('alice', 'Alice A', 'late')]);
    expect(repair).toBeNull();
    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'late' });
  });

  it('keeps a link whose manager was soft-deleted (the row, and the person, still exist)', async () => {
    await load([person('boss', 'Bea Boss'), person('alice', 'Alice A', 'boss')]);
    await pool.query(`UPDATE "Principals" SET "deletedAt" = now() WHERE "externalId" = 'boss' AND "systemId" = $1`, [sysA]);
    const repair = await repairManagerLinks(asRunner(), 'Principals', sysA, true);
    expect(repair).toBeNull();
    expect(await managerOf('alice')).toMatchObject({ managerExternalId: 'boss' });
  });
});
