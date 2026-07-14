// Contract test — routes/identities/detail.js against the real PostgreSQL 16
// schema.
//
// Guards #679. The identity-detail endpoints run cross-table joins (Identities,
// IdentityMembers, Principals, ResourceAssignments, Contexts, the permission
// matview) whose column names were renamed in migration 030 and whose aggregate
// logic the SQL-blind unit mocks never exercise. This pins them end-to-end and
// catches the "Indirect assignments never counted" bug: the entity-graph
// aggregate object omitted the Indirect key, so indirect counts were dropped
// before reaching the UI (which reads m.Indirect).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, identityId, memberId, resDirect, resIndirect, tagId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-identity-detail') RETURNING "id"`,
  )).rows[0].id;

  memberId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "riskScore", "riskTier")
     VALUES (gen_random_uuid(), $1, 'Member One', 'member.one@example.com', 'User', 42, 'High') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  identityId = (await pool.query(
    `INSERT INTO "Identities" ("id", "displayName", "email", "primaryPrincipalId", "isHrAnchored", "accountCount", "linkConfidence")
     VALUES (gen_random_uuid(), 'Contract Identity', 'identity@example.com', $1, false, 1, 95) RETURNING "id"`,
    [memberId],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary", "accountType", "linkConfidence")
     VALUES ($1, $2, true, 'Cloud', 95)`,
    [identityId, memberId],
  );

  resDirect = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Direct Group', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
  resIndirect = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Indirect Group', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $3, 'Direct', 'User', $4), ($2, $3, 'Indirect', 'User', $4)`,
    [resDirect, resIndirect, memberId, systemId],
  );

  // A Principal-targeted Tag context — the identity reaches it through its member.
  tagId = (await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName")
     VALUES (gen_random_uuid(), 'manual', 'Principal', 'Tag', 'Contract Tag') RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
     VALUES ($1, 'Principal', $2, 'analyst')`,
    [tagId, memberId],
  );

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [identityId]); // cascades IdentityMembers
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = $1`, [tagId]);        // cascades ContextMembers
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);      // cascades Principals/Resources/RA
  await pool.query(`DELETE FROM "_history" WHERE "rowId" IN ($1,$2,$3,$4)`, [identityId, memberId, resDirect, resIndirect]);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /identities/:id', () => {
  it('returns the identity, enriched members, and correct Direct+Indirect aggregates', async () => {
    const res = await agent.get(`/api/identities/${identityId}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.displayName).toBe('Contract Identity');
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].displayName).toBe('Member One'); // COALESCE(m,u)
    expect(res.body.members[0].groupCount).toBe(1);             // one Direct assignment
    expect(res.body.members[0].riskScore).toBe(42);            // risk enrichment
    expect(res.body.aggregateAssignments.Direct).toBe(1);
    // The bug: Indirect was dropped because the aggregate object had no Indirect key.
    expect(res.body.aggregateAssignments.Indirect).toBe(1);
    expect(res.body.contextCount).toBe(1);                      // via the Principal-targeted tag
  });

  it('400s a malformed id', async () => {
    const res = await agent.get('/api/identities/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s a well-formed but unknown id', async () => {
    const res = await agent.get('/api/identities/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('GET /identities/:id sub-resources', () => {
  it('by-user maps the identity fields the frontend expects', async () => {
    const res = await agent.get(`/api/identities/by-user/${memberId}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.id).toBe(identityId);
    expect(res.body.identity.primaryAccountUpn).toBe('identity@example.com'); // aliased from email
    expect(res.body.memberInfo.accountType).toBe('Cloud');
  });

  it('assignments?type=Direct lists the direct assignment', async () => {
    const res = await agent.get(`/api/identities/${identityId}/assignments?type=Direct`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].resourceDisplayName).toBe('Direct Group');
  });

  it('assignments?type=Indirect lists the indirect assignment', async () => {
    const res = await agent.get(`/api/identities/${identityId}/assignments?type=Indirect`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].resourceDisplayName).toBe('Indirect Group');
  });

  it('assignments rejects a non-universal type', async () => {
    const res = await agent.get(`/api/identities/${identityId}/assignments?type=Owner`);
    expect(res.status).toBe(400);
  });

  it('contexts lists the tag reached through the member principal', async () => {
    const res = await agent.get(`/api/identities/${identityId}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].displayName).toBe('Contract Tag');
  });

  it('account-matrix returns the account plus its matview memberships', async () => {
    const res = await agent.get(`/api/identities/${identityId}/account-matrix`);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].displayName).toBe('Member One');
    expect(res.body.memberships.map(m => m.membershipType).sort()).toEqual(['Direct', 'Indirect']);
  });
});
