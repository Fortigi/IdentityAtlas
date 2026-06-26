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

  // One identity aggregating both principals.
  identityId = randomUUID();
  await pool.query(
    `INSERT INTO "Identities" ("id", "displayName", "email") VALUES ($1, 'Jane Doe', 'jane@example.com')`,
    [identityId],
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
