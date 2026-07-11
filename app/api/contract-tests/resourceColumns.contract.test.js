// Contract test — GET /api/resource-columns-page (and its /group-columns alias)
// against a real PostgreSQL schema.
//
// Guards #662: the handler used to probe for the table with
// `SELECT TOP 0 * FROM Resources` — T-SQL that always throws on Postgres, so the
// existence check silently failed and the endpoint took a legacy fallback path.
// The probe is gone; the endpoint now reads the Resources columns directly. This
// pins that it returns real Resources columns against the real schema — the kind
// of SQL-shape bug a mocked unit test can't see (#679).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-resource-columns') RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled")
     VALUES ($1, 'Contract Columns Group', 'Group', true)`,
    [systemId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /resource-columns-page — reads the Resources table', () => {
  it('schema=true returns real Resources columns', async () => {
    const res = await agent.get('/api/resource-columns-page?schema=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const cols = res.body.map(c => c.column);
    // Real Resources columns → proves the handler queried the Resources table.
    // With the old SELECT TOP 0 probe throwing, this endpoint could not have
    // been serving these against a real Postgres schema.
    expect(cols).toContain('resourceType');
    expect(cols).toContain('displayName');
  });

  it('the /group-columns alias resolves to the same Resources columns', async () => {
    const res = await agent.get('/api/group-columns?schema=true');
    expect(res.status).toBe(200);
    const cols = res.body.map(c => c.column);
    expect(cols).toContain('resourceType');
  });
});
