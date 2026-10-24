// Contract test — extendedAttributes keys with spaces and dashes (lib/extKeys.js)
// against a real PostgreSQL schema.
//
// The key rule exists twice: as a JS regex and as a PostgreSQL regex inside the
// discovery query. Only a real database can say the PostgreSQL one parses and
// agrees, and that a quoted key with a space reads the value back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { discoverExtendedAttrKeys } from '../src/db/columnCache.js';

let agent;
let pool;
let systemId;
let principalId;
const tag = randomUUID().slice(0, 8);
const SPACED = `CMDB Reference ${tag}`;
const DASHED = `Cost-Center-${tag}`;
const QUOTED = `it's-${tag}`;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-ext-keys') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType", "extendedAttributes")
     VALUES ($1, 'Ext Key Person', 'User', $2) RETURNING "id"`,
    [systemId, { [SPACED]: 'CI-1', [DASHED]: 'KST-9', [QUOTED]: 'x' }],
  );
  principalId = p.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('extendedAttributes keys a source writes with spaces and dashes', () => {
  it('discovery offers them, and still drops a key with a quote', async () => {
    const keys = await discoverExtendedAttrKeys('Principals');
    expect(keys).toContain(SPACED);
    expect(keys).toContain(DASHED);
    expect(keys).not.toContain(QUOTED);
  });

  it('the Users list filters on a key with a space', async () => {
    const filters = encodeURIComponent(JSON.stringify({ [`ext.${SPACED}`]: 'CI-1' }));
    const res = await agent.get(`/api/users?filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map(u => u.id)).toEqual([principalId]);
  });

  it('a wrong value on that key finds nobody (the filter is applied, not dropped)', async () => {
    const filters = encodeURIComponent(JSON.stringify({ [`ext.${SPACED}`]: 'CI-2' }));
    const res = await agent.get(`/api/users?filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
