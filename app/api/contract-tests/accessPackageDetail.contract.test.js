// Contract test — routes/details/accessPackage.js against the real PostgreSQL 16
// schema.
//
// Guards #679. The access-package detail endpoints run governance SQL that the
// SQL-blind unit mocks never parse. Two shape bugs only surface against real pg:
//
//   1. GET /access-package/:id/policies always returned []. Its query used
//      CAST(0 AS BOOLEAN) (postgres can't cast int→bool) and JSON_VALUE()
//      (a SQL-Server/Oracle function absent in postgres 16). Both throw, and the
//      endpoint's catch swallowed it to an empty list.
//   2. The detail counts (assignmentCount/groupCount/policyCount) came back as
//      bigint strings, not numbers.
//
// Exactly the query bugs a mocked unit test can't see (#679).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, apId, childId, memberId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-access-package') RETURNING "id"`,
  )).rows[0].id;

  apId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource")
     VALUES (gen_random_uuid(), $1, 'Contract AP', 'BusinessRole', true) RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  childId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Child Group', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId", "roleName")
     VALUES ($1, $2, 'Contains', $3, 'Member')`,
    [apId, childId, systemId],
  );

  memberId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'AP Member', 'apmember@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', 'User', $3)`,
    [apId, memberId, systemId],
  );

  await pool.query(
    `INSERT INTO "AssignmentPolicies"
       ("id", "systemId", "resourceId", "displayName", "hasAutoAddRule", "hasAutoRemoveRule", "hasAccessReview", "automaticRequestSettings")
     VALUES (gen_random_uuid(), $1, $2, 'Policy A', true, false, false, '{"filter":{"rule":"dept eq IT"}}')`,
    [systemId, apId],
  );
});

afterAll(async () => {
  // Every seeded table has a systemId FK with ON DELETE CASCADE.
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.query(`DELETE FROM "_history" WHERE "rowId" IN ($1, $2)`, [apId, childId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /access-package/:id — attributes + numeric counts', () => {
  it('returns BusinessRole attributes and numeric assignment/group/policy counts', async () => {
    const res = await agent.get(`/api/access-package/${apId}`);
    expect(res.status).toBe(200);
    expect(res.body.attributes.displayName).toBe('Contract AP');
    expect(res.body.attributes.resourceType).toBe('BusinessRole');
    expect(res.body.assignmentCount).toBe(1);
    expect(res.body.groupCount).toBe(1);
    expect(res.body.policyCount).toBe(1);
    expect(res.body.assignmentType).toBe('Auto-assigned');
    expect(res.body.hasHistory).toBe(true); // Resources INSERT trigger logs it
  });

  it('400s a malformed id', async () => {
    const res = await agent.get('/api/access-package/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s a well-formed but unknown id', async () => {
    const res = await agent.get('/api/access-package/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('GET /access-package/:id sub-resources', () => {
  it('/policies returns the policy (CAST/JSON_VALUE bug used to blank it)', async () => {
    const res = await agent.get(`/api/access-package/${apId}/policies`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].displayName).toBe('Policy A');
    expect(res.body[0].hasAutoAddRule).toBe(true);
    // JSON_VALUE(...,'$.filter.rule') → postgres jsonb #>> '{filter,rule}'
    expect(res.body[0].autoAssignmentFilter).toBe('dept eq IT');
  });

  it('/assignments lists the Direct assignee joined to Principals', async () => {
    const res = await agent.get(`/api/access-package/${apId}/assignments`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].targetDisplayName).toBe('AP Member');
  });

  it('/resource-roles lists the contained resource scope', async () => {
    const res = await agent.get(`/api/access-package/${apId}/resource-roles`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].roleName).toBe('Member');
    expect(res.body[0].scopeDisplayName).toBe('Child Group');
  });

  it('/history returns the BusinessRole audit row(s)', async () => {
    const res = await agent.get(`/api/access-package/${apId}/history`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some(h => h.displayName === 'Contract AP')).toBe(true);
  });
});
