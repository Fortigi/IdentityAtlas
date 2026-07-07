// Contract test — ComponentVersions (migration 056) + record/getComponentVersion
// against the real schema. Verifies the upsert semantics the skew logic relies
// on: one row per component, with the version and lastSeenAt replaced on repeat.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { recordComponentVersion, getComponentVersion, stampSchemaVersion } from '../src/updates/componentVersions.js';

let pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ComponentVersions"`);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ComponentVersions"`);
});

describe('ComponentVersions', () => {
  it('records a component version and reads it back', async () => {
    await recordComponentVersion('worker', '5.310.20260629.1221', pool);
    const row = await getComponentVersion('worker', pool);
    expect(row.component).toBe('worker');
    expect(row.version).toBe('5.310.20260629.1221');
    expect(row.lastSeenAt).toBeTruthy(); // default now()
  });

  it('upserts one row per component — a newer report replaces the version', async () => {
    await recordComponentVersion('worker', '5.309.20260628.1000', pool);
    await recordComponentVersion('worker', '5.311.20260630.0900', pool);
    const all = await pool.query(`SELECT * FROM "ComponentVersions" WHERE "component" = 'worker'`);
    expect(all.rows).toHaveLength(1); // upsert on conflict, not a second insert
    const row = await getComponentVersion('worker', pool);
    expect(row.version).toBe('5.311.20260630.0900');
  });

  it('getComponentVersion returns null for a component that never reported', async () => {
    expect(await getComponentVersion('worker', pool)).toBeNull();
  });

  it('stampSchemaVersion stamps the running version once all migrations are applied', async () => {
    // The contract harness applies every migration, so the guard (pending/ahead)
    // passes and the version is stamped as the "database" component.
    const v = await stampSchemaVersion('5.999.20260707.0000', pool);
    expect(v).toBe('5.999.20260707.0000');
    const row = await getComponentVersion('database', pool);
    expect(row.version).toBe('5.999.20260707.0000');
  });
});
