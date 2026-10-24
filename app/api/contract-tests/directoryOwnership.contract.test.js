// Contract test — a dependent system may reference the directory's principals,
// but never take them over (#1247).
//
// This is the behavioural proof the unit tests cannot give. They assert the SQL
// the builder emits; this runs that SQL against the real schema (with migration
// 070 applied) and reads the row back, which is the only way to show that the
// Entra and Azure RM crawlers stop overwriting each other.
//
// The flip it pins down: both crawlers write the SAME "Principals" row, because
// the row is keyed on the directory objectId. Every ingest stamps its own systemId,
// so before this change each run moved the row to the crawler that ran last — which
// showed up as a Timeline event per run, made the next presence lookup read the user
// as an orphan (and drop his Azure grants), and let a user deleted in Entra escape
// the directory's own full-sync reconcile.
//
// Note the second half: the directory can still CLAIM a row the dependent system
// created. Without that asymmetry this would be "first writer wins", and an
// Azure-RM-first tenant would keep every account on the Azure system forever.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

// engine.js / systemBoundary.js use the module-level db pool, which is built lazily
// from DATABASE_URL on first query — so point it at the container BEFORE importing.
process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { ingest } = await import('../src/ingest/engine.js');
const { preservedOwnerColumns, linkDirectorySystems } = await import('../src/ingest/systemBoundary.js');

const TENANT = 'contract-tenant-1247';
const WILLIAM = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const AZURE_ONLY_SP = 'dddddddd-dddd-dddd-dddd-dddddddddd02';

let pool;
let directoryId;
let dependentId;

const readPrincipal = async (id) => (await pool.query(
  `SELECT "systemId", "accountEnabled", "displayName" FROM "Principals" WHERE "id" = $1`, [id],
)).rows[0];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const dir = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName", "tenantId")
     VALUES ('EntraID', 'contract-directory-1247', $1) RETURNING "id"`, [TENANT]);
  directoryId = dir.rows[0].id;
  const dep = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName", "tenantId")
     VALUES ('AzureRM', 'contract-dependent-1247', $1) RETURNING "id"`, [TENANT]);
  dependentId = dep.rows[0].id;
});

afterAll(async () => {
  for (const s of [dependentId, directoryId]) {
    if (s) await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [s]);
  }
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [[directoryId, dependentId]]);
});

describe('Systems.directorySystemId', () => {
  it('links a dependent system to the directory that shares its tenant', async () => {
    await pool.query(`UPDATE "Systems" SET "directorySystemId" = NULL WHERE "id" = $1`, [dependentId]);
    await linkDirectorySystems();

    const rows = await pool.query(
      `SELECT "id", "directorySystemId" FROM "Systems" WHERE "id" = ANY($1::int[])`,
      [[directoryId, dependentId]]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.directorySystemId]));
    expect(byId[dependentId]).toBe(directoryId);
    // The directory itself stays unlinked — that is what makes it the directory.
    expect(byId[directoryId]).toBeNull();
  });

  it('refuses to make a system its own directory', async () => {
    await expect(pool.query(
      `UPDATE "Systems" SET "directorySystemId" = "id" WHERE "id" = $1`, [dependentId],
    )).rejects.toThrow(/ck_Systems_directory_not_self/);
  });
});

describe('a dependent system ingesting the directory\'s principal', () => {
  beforeEach(async () => {
    await linkDirectorySystems();
    // The directory's own row: William, disabled in Entra.
    await ingest(null, 'Principals', ['id'], [{
      id: WILLIAM, systemId: directoryId, displayName: 'William', accountEnabled: false, principalType: 'User',
    }], { syncMode: 'full', systemId: directoryId });
  });

  it('leaves the row on the directory, and leaves accountEnabled alone', async () => {
    const preserveColumns = await preservedOwnerColumns('Principals', dependentId);
    expect(preserveColumns).toEqual(['systemId']);

    // What the Azure RM crawler's stub upsert looks like after this change: the
    // objectId and nothing else it does not know.
    await ingest(null, 'Principals', ['id'], [{ id: WILLIAM, systemId: dependentId, principalType: 'User' }],
      { syncMode: 'delta', systemId: dependentId, preserveColumns });

    const row = await readPrincipal(WILLIAM);
    expect(row.systemId).toBe(directoryId);
    expect(row.accountEnabled).toBe(false);
    expect(row.displayName).toBe('William');
  });

  it('would move the row without the rule — so the assertion above is a real one', async () => {
    // The same upsert with the rule switched off. If this did NOT move the row,
    // the test above would be passing for the wrong reason.
    await ingest(null, 'Principals', ['id'], [{ id: WILLIAM, systemId: dependentId, principalType: 'User' }],
      { syncMode: 'delta', systemId: dependentId });

    expect((await readPrincipal(WILLIAM)).systemId).toBe(dependentId);
  });
});

describe('the directory claiming a row the dependent system created', () => {
  it('takes ownership, so an Azure-RM-first tenant converges once Entra runs', async () => {
    await linkDirectorySystems();
    const preserveColumns = await preservedOwnerColumns('Principals', dependentId);

    // Azure RM first: nothing in the directory yet, so the crawler writes the stub
    // and rightfully owns it.
    await ingest(null, 'Principals', ['id'], [{ id: AZURE_ONLY_SP, systemId: dependentId }],
      { syncMode: 'delta', systemId: dependentId, preserveColumns });
    expect((await readPrincipal(AZURE_ONLY_SP)).systemId).toBe(dependentId);

    // The directory then loads the same object. It has no preserved columns, so it
    // claims the row — the asymmetry that keeps this from being "first writer wins".
    expect(await preservedOwnerColumns('Principals', directoryId)).toBeNull();
    await ingest(null, 'Principals', ['id'], [{
      id: AZURE_ONLY_SP, systemId: directoryId, displayName: 'Deployment SP', principalType: 'ServicePrincipal',
    }], { syncMode: 'full', systemId: directoryId });

    const row = await readPrincipal(AZURE_ONLY_SP);
    expect(row.systemId).toBe(directoryId);
    expect(row.displayName).toBe('Deployment SP');
  });
});
