// Contract test — the virtual `__system` filter column on the Principals and
// Resources list surfaces, against a real PostgreSQL schema.
//
// Red before #1204: `systemId` is excluded from column discovery
// (db/columnCache.js) and buildFilterWhere silently drops any filter key that
// isn't a discovered column, so `?filters={"__system":…}` returned every
// system's rows and no column endpoint offered a System field at all.
//
// The SQL shape (the EXISTS against "Systems") is exactly what a mocked unit
// test can't verify, which is why this tier owns it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool;
let sysA, sysB, sysEmpty, sysDupA, sysDupB;

const NAME_A = 'Contract EntraID';
const NAME_B = 'Contract SCIM';
const NAME_EMPTY = 'Contract Empty System';
const NAME_DUP = 'Contract Duplicate Name';

const createdSystems = () => [sysA, sysB, sysEmpty, sysDupA, sysDupB];

async function newSystem(type, displayName) {
  return (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ($1, $2) RETURNING id`,
    [type, displayName],
  )).rows[0].id;
}

const filtersQs = (obj) => encodeURIComponent(JSON.stringify(obj));

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  sysA = await newSystem('EntraID', NAME_A);
  sysB = await newSystem('SCIM', NAME_B);
  sysEmpty = await newSystem('CSV', NAME_EMPTY);
  sysDupA = await newSystem('CSV', NAME_DUP);
  sysDupB = await newSystem('CSV', NAME_DUP);

  await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "displayName", "principalType")
     VALUES (gen_random_uuid(), $1, 'Contract Entra Person', 'User'),
            (gen_random_uuid(), $2, 'Contract Scim Person',  'User'),
            (gen_random_uuid(), $3, 'Contract Dup Person A', 'User'),
            (gen_random_uuid(), $4, 'Contract Dup Person B', 'User')`,
    [sysA, sysB, sysDupA, sysDupB],
  );
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled")
     VALUES ($1, 'Contract Entra Group', 'Group', true),
            ($2, 'Contract Scim Group',  'Group', true)`,
    [sysA, sysB],
  );
});

afterAll(async () => {
  const ids = createdSystems();
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [ids]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('System filter on the Principals list', () => {
  it('GET /api/users narrows to one system by display name', async () => {
    const res = await agent.get(`/api/users?limit=500&filters=${filtersQs({ __system: NAME_B })}`);
    expect(res.status).toBe(200);
    const names = res.body.data.map(u => u.displayName);
    expect(names).toContain('Contract Scim Person');
    expect(names).not.toContain('Contract Entra Person');
  });

  it('GET /api/users without the filter still returns both systems', async () => {
    const res = await agent.get('/api/users?limit=500&search=Contract');
    const names = res.body.data.map(u => u.displayName);
    expect(names).toEqual(expect.arrayContaining(['Contract Scim Person', 'Contract Entra Person']));
  });

  it('matches every system sharing the selected display name', async () => {
    const res = await agent.get(`/api/users?limit=500&filters=${filtersQs({ __system: NAME_DUP })}`);
    const names = res.body.data.map(u => u.displayName);
    expect(names).toEqual(expect.arrayContaining(['Contract Dup Person A', 'Contract Dup Person B']));
    expect(names).not.toContain('Contract Entra Person');
  });

  it('returns nothing for a system nobody is in', async () => {
    const res = await agent.get(`/api/users?limit=500&filters=${filtersQs({ __system: NAME_EMPTY })}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('combines with a regular column filter', async () => {
    const res = await agent.get(
      `/api/users?limit=500&filters=${filtersQs({ __system: NAME_A, principalType: 'User' })}`);
    const names = res.body.data.map(u => u.displayName);
    expect(names).toContain('Contract Entra Person');
    expect(names).not.toContain('Contract Scim Person');
  });

  it('GET /api/user-columns-page offers System, valued by display name', async () => {
    const res = await agent.get('/api/user-columns-page');
    expect(res.status).toBe(200);
    const sysCol = res.body.find(c => c.column === '__system');
    expect(sysCol?.values).toEqual(expect.arrayContaining([NAME_A, NAME_B]));
    // A system with no principals is still offered (sourced from Systems, not
    // from distinct row values).
    expect(sysCol.values).toContain(NAME_EMPTY);
    // …and each name appears once even though two systems share NAME_DUP.
    expect(sysCol.values.filter(v => v === NAME_DUP)).toHaveLength(1);
  });
});

describe('System filter on the Resources list', () => {
  it('GET /api/resources narrows to one system by display name', async () => {
    const res = await agent.get(`/api/resources?limit=500&filters=${filtersQs({ __system: NAME_B })}`);
    expect(res.status).toBe(200);
    const names = res.body.data.map(r => r.displayName);
    expect(names).toContain('Contract Scim Group');
    expect(names).not.toContain('Contract Entra Group');
  });

  it('GET /api/groups narrows to one system by display name', async () => {
    const res = await agent.get(`/api/groups?limit=500&filters=${filtersQs({ __system: NAME_A })}`);
    expect(res.status).toBe(200);
    const names = res.body.data.map(r => r.displayName);
    expect(names).toContain('Contract Entra Group');
    expect(names).not.toContain('Contract Scim Group');
  });

  it('GET /api/resource-columns offers System, valued by display name', async () => {
    const res = await agent.get('/api/resource-columns');
    expect(res.status).toBe(200);
    const sysCol = res.body.find(c => c.column === '__system');
    expect(sysCol?.values).toEqual(expect.arrayContaining([NAME_A, NAME_B, NAME_EMPTY]));
  });

  it('GET /api/resource-columns-page offers System too', async () => {
    const res = await agent.get('/api/resource-columns-page');
    const sysCol = res.body.find(c => c.column === '__system');
    expect(sysCol?.values).toEqual(expect.arrayContaining([NAME_A, NAME_B]));
  });

  it('offers System with no values on the ?schema=true fast path', async () => {
    const res = await agent.get('/api/resource-columns?schema=true');
    expect(res.body.find(c => c.column === '__system').values).toEqual([]);
  });
});

describe('column discovery does not leak the raw systemId', () => {
  it('no list-page or matrix column endpoint gains a systemId field', async () => {
    for (const url of ['/api/user-columns-page', '/api/resource-columns', '/api/resource-columns-page']) {
      const res = await agent.get(url);
      expect(res.body.map(c => c.column)).not.toContain('systemId');
    }
    // The matrix attribute picker builds from the same discovery cache — it
    // must not gain a raw integer systemId field either, and it must not be
    // offered the list-page-only virtual column.
    for (const entity of ['Principal', 'Resource']) {
      const matrix = await agent.get(`/api/matrix/columns?entity=${entity}`);
      expect(matrix.status).toBe(200);
      const cols = matrix.body.map(c => c.column);
      expect(cols).not.toContain('systemId');
      expect(cols).not.toContain('__system');
    }
  });
});
