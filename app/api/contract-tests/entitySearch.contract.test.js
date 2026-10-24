// Contract test — extended list search (migration 091 + lib/entitySearch.js)
// against a real PostgreSQL schema.
//
// Two things only a real database can say:
//   1. the search SQL runs on the live schema and finds a value that sits in
//      extendedAttributes (nested, in a list, written as a differently
//      formatted phone number), on all four list endpoints;
//   2. the planner can answer the query expression from the search index. The
//      unit test holds the expression text to the migration; this holds the
//      planner to it, which is the thing that would actually regress.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { searchExpression } from '../src/lib/entitySearch.js';

let agent;
let pool;
let systemId;
let principalId;
let identityId;
let resourceId;
let contextId;
// Unique per run: the contract database is shared by every file.
const tag = randomUUID().slice(0, 8);
const CMDB = `CI-${tag}`;
const COST_CENTER = `KST-${tag}`;
const SAM = `GG-SAP-${tag}`;
const PHONE_DIGITS = String(Date.now()).slice(-8);           // 8 digits, unique enough
const MOBILE_STORED = `+31 6 ${PHONE_DIGITS.slice(0, 4)} ${PHONE_DIGITS.slice(4)}`;
const MOBILE_TYPED = `06-${PHONE_DIGITS}`;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-entity-search') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType", "extendedAttributes")
     VALUES ($1, 'Search Person', 'User', $2) RETURNING "id"`,
    [systemId, { mobilePhone: MOBILE_STORED, employeeOrgData: { costCenter: COST_CENTER }, accountEnabled: true }],
  );
  principalId = p.rows[0].id;

  identityId = randomUUID();
  await pool.query(`INSERT INTO "Identities" ("id", "displayName", "accountCount") VALUES ($1, 'Search Identity', 1)`, [identityId]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary") VALUES ($1, $2, true)`, [identityId, principalId]);

  resourceId = randomUUID();
  await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES ($1, $2, 'SAP users', 'Group', $3)`,
    [resourceId, systemId, { aliases: [SAM] }],
  );

  contextId = randomUUID();
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId", "extendedAttributes")
     VALUES ($1, 'synced', 'Resource', 'Application', 'Payroll', $2, $3)`,
    [contextId, systemId, { 'CMDB Reference': CMDB }],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [identityId]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [identityId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

const q = (s) => encodeURIComponent(s);

describe('extended search over the list endpoints', () => {
  it('users: a phone number typed differently from how it is stored', async () => {
    const res = await agent.get(`/api/users?search=${q(MOBILE_TYPED)}&extendedSearch=true`);
    expect(res.status).toBe(200);
    const hit = res.body.data.find(u => u.id === principalId);
    expect(hit).toBeTruthy();
    expect(hit.matchedOn).toEqual(['mobilePhone']);
  });

  it('users: the same search without extendedSearch does not find it', async () => {
    const res = await agent.get(`/api/users?search=${q(MOBILE_TYPED)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(u => u.id === principalId)).toBe(false);
  });

  it('identities: found through the linked account', async () => {
    const res = await agent.get(`/api/identities?search=${q(COST_CENTER)}&extendedSearch=true`);
    expect(res.status).toBe(200);
    const hit = res.body.data.find(i => i.id === identityId);
    expect(hit).toBeTruthy();
    expect(hit.matchedOn).toEqual(['linkedAccount']);
  });

  it('resources: a value inside a list', async () => {
    const res = await agent.get(`/api/resources?search=${q(SAM.toLowerCase())}&extendedSearch=true`);
    expect(res.status).toBe(200);
    expect(res.body.data.find(r => r.id === resourceId)?.matchedOn).toEqual(['aliases']);
  });

  it('groups: the same resource through the legacy list', async () => {
    const res = await agent.get(`/api/groups?search=${q(SAM)}&extendedSearch=true`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(r => r.id === resourceId)).toBe(true);
  });

  it('contexts: a CMDB reference under a key with a space in it', async () => {
    const res = await agent.get(`/api/contexts?search=${q(CMDB)}&extendedSearch=true`);
    expect(res.status).toBe(200);
    expect(res.body.data.find(c => c.id === contextId)?.matchedOn).toEqual(['CMDB Reference']);
  });

  it('never matches a key name or a boolean', async () => {
    const key = await agent.get(`/api/contexts?search=${q('CMDB Reference')}&extendedSearch=true&scopeSystemId=${systemId}`);
    expect(key.body.data).toEqual([]);
    const bool = await agent.get(`/api/users?search=true&extendedSearch=true&filters=${q(JSON.stringify({ __system: 'contract-entity-search' }))}`);
    expect(bool.body.data).toEqual([]);
  });
});

describe('the planner answers each search from its index', () => {
  const TABLES = [['principal', 'Principals'], ['identity', 'Identities'], ['resource', 'Resources'], ['context', 'Contexts']];

  it.each(TABLES)('%s → ix_%s_search', async (entity, table) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The tables are tiny here; forbid the sequential scan so the plan shows
      // whether the index CAN serve the expression, which is what drifts.
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN SELECT 1 FROM "${table}" t WHERE ${searchExpression(entity, 't')} ILIKE $1`, ['%abc%'],
      );
      expect(plan.rows.map(r => r['QUERY PLAN']).join('\n')).toContain(`ix_${table}_search`);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
