// Contract test — GET /api/identities/:id against a real PostgreSQL schema.
//
// Verifies the identity-detail endpoint's SQL (Identities → IdentityMembers →
// Principals joins) runs against the real schema and returns the documented
// shape, including all linked accounts under `members`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
let identityId;
const principalIds = [];

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-identities') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  // Two principals (linked accounts) for one identity.
  for (const name of ['Jane (Entra)', 'Jane (AD)']) {
    const r = await pool.query(
      `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
       VALUES ($1, $2, $3, 'User') RETURNING "id"`,
      [systemId, name, 'jane@example.com'],
    );
    principalIds.push(r.rows[0].id);
  }

  // One identity aggregating both principals. The displayName carries the
  // random id so the list test can search-scope to exactly this row on the
  // shared contract DB, and accountCount/linkConfidence/department are set so
  // the numeric + attribute list filters have something to match.
  identityId = randomUUID();
  await pool.query(
    `INSERT INTO "Identities"
       ("id", "displayName", "email", "accountCount", "linkConfidence", "department")
     VALUES ($1, $2, 'jane@example.com', 2, 90, 'Contracts')`,
    [identityId, `Jane Doe ${identityId}`],
  );
  await pool.query(
    `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary") VALUES ($1, $2, true)`,
    [identityId, principalIds[0]],
  );
  await pool.query(
    `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary") VALUES ($1, $2, false)`,
    [identityId, principalIds[1]],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [identityId]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [identityId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /identities/:id', () => {
  it('returns the identity with both linked accounts under members', async () => {
    const res = await agent.get(`/api/identities/${identityId}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeTruthy();
    expect(res.body.identity.id).toBe(identityId);
    expect(Array.isArray(res.body.members)).toBe(true);
    // Regression pin: both linked principals are returned.
    expect(res.body.members.length).toBe(2);
    const returnedPrincipalIds = res.body.members.map(m => m.principalId).sort();
    expect(returnedPrincipalIds).toEqual([...principalIds].sort());
  });

  it('returns 400 for a malformed id', async () => {
    const res = await agent.get('/api/identities/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

// GET /identities (list) drives the dynamically-composed WHERE clause through
// bindNamedParams — the @name → $N conversion only runs correctly against real
// SQL, so these pin the list + column-discovery queries to the live schema.
describe('GET /identities (list)', () => {
  it('finds the seeded identity via the search filter', async () => {
    const res = await agent.get(`/api/identities?search=${identityId}&sort=accountCount`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    const mine = res.body.data.find(d => d.id === identityId);
    expect(mine).toBeTruthy();
    expect(mine.accountCount).toBe(2);
  });

  it('applies numeric + attribute filters together without error', async () => {
    const filters = encodeURIComponent(JSON.stringify({ department: 'Contracts' }));
    const res = await agent.get(
      `/api/identities?search=${identityId}&minAccounts=2&confidence=10&filters=${filters}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    // The row satisfies all three predicates, so bindNamedParams numbered them right.
    expect(res.body.data.some(d => d.id === identityId)).toBe(true);
  });

  it('returns filterable columns from /identity-columns (schema mode)', async () => {
    const res = await agent.get('/api/identity-columns?schema=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map(c => c.column)).toContain('displayName');
  });

  it('returns distinct values from /identity-columns (full path)', async () => {
    const res = await agent.get('/api/identity-columns');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
