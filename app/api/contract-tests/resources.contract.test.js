// Contract test — GET /api/resources against a real PostgreSQL schema.
//
// Verifies the resource list/filter endpoint's SQL runs against the real schema
// and that the resourceType filter selects only matching rows. Response is an
// object { data, total }, not a bare array.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-resources') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const seed = [
    ['Engineering', 'Group'],
    ['Finance', 'Group'],
    ['Global Admin', 'DirectoryRole'],
    ['Sales App', 'Application'],
    ['Joiner Package', 'BusinessRole'],
  ];
  for (const [name, type] of seed) {
    await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled")
       VALUES ($1, $2, $3, true)`,
      [systemId, name, type],
    );
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /resources', () => {
  it('filters to exactly the requested resourceType', async () => {
    const res = await agent.get(`/api/resources?resourceType=Group&systemId=${systemId}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data.every(r => r.resourceType === 'Group')).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBe(2);
  });

  it('excludes BusinessRole resources when no resourceType filter is given', async () => {
    const res = await agent.get(`/api/resources?systemId=${systemId}`);

    expect(res.status).toBe(200);
    // Engineering, Finance, Global Admin, Sales App — but NOT Joiner Package.
    expect(res.body.data.every(r => r.resourceType !== 'BusinessRole')).toBe(true);
    expect(res.body.data.some(r => r.displayName === 'Joiner Package')).toBe(false);
  });
});
