// Contract test — routes/details/group.js against the real PostgreSQL 16 schema.
//
// Guards #679. The group-detail endpoints run their counts/joins against real
// tables + the tags compat views; SQL-blind unit mocks hid two shape bugs that
// only surface against the real schema:
//
//   1. Tags never resolved. The GraphTagAssignments view normalises entityId to
//      UPPER(uuid::text) (its migration says "downstream queries compare against
//      UPPER(uuid::text)"), but the tags query compared `ta."entityId" = @id`
//      without upper-casing @id — so an all-lowercase resource id never matched
//      and every group reported zero tags.
//   2. Member count was always 0. It ran COUNT(DISTINCT "memberId") against
//      vw_ResourceUserPermissionAssignments, which exposes "principalId", not
//      "memberId" — an undefined-column error that isMissingSchema() swallowed to 0.
//
// Both are exactly the query bugs a mocked unit test can't see (#679).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, groupId, memberId, apId, tagId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-group-detail') RETURNING "id"`,
  )).rows[0].id;

  groupId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "enabled")
     VALUES (gen_random_uuid(), $1, 'Contract Group Detail', 'Group', true) RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  memberId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'Group Member', 'member@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  // A Direct membership → one row in the permission matview after REFRESH.
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', 'User', $3)`,
    [groupId, memberId, systemId],
  );

  // A tag on the group: a manual Tag context targeting Resources + a membership.
  tagId = (await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "extendedAttributes")
     VALUES (gen_random_uuid(), 'manual', 'Resource', 'Tag', 'Contract Group Tag', '{"tagColor":"#ff0000"}')
     RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
     VALUES ($1, 'Resource', $2, 'analyst')`,
    [tagId, groupId],
  );

  // An access package that Contains the group.
  apId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Contract AP', 'BusinessRole') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId", "roleName")
     VALUES ($1, $2, 'Contains', $3, 'Member')`,
    [apId, groupId, systemId],
  );

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [tagId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = $1`, [tagId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /group/:id — attributes, tags, counts', () => {
  it('returns attributes, the tag, and non-zero member/AP counts against the real schema', async () => {
    const res = await agent.get(`/api/group/${groupId}`);
    expect(res.status).toBe(200);
    expect(res.body.attributes.displayName).toBe('Contract Group Detail');
    expect(res.body.attributes.resourceType).toBe('Group');
    // Bug 1 — tags never resolved without UPPER(@id).
    expect(res.body.tags).toHaveLength(1);
    expect(res.body.tags[0].name).toBe('Contract Group Tag');
    expect(res.body.tags[0].color).toBe('#ff0000');
    // Bug 2 — member count was always 0 (COUNT of a non-existent column).
    expect(res.body.memberCount).toBe(1);
    expect(res.body.accessPackageCount).toBe(1);
    // The Resources INSERT trigger logs an audit row, so the group has history.
    expect(res.body.hasHistory).toBe(true);
    expect(res.body.historyCount).toBeGreaterThanOrEqual(1);
  });

  it('400s a malformed id', async () => {
    const res = await agent.get('/api/group/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s a well-formed but unknown id', async () => {
    const res = await agent.get('/api/group/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('GET /group/:id sub-resources', () => {
  it('/members lists the Direct member joined to Principals', async () => {
    const res = await agent.get(`/api/group/${groupId}/members`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].memberDisplayName).toBe('Group Member');
    expect(res.body[0].membershipType).toBe('Direct');
  });

  it('/access-packages lists the containing access package', async () => {
    const res = await agent.get(`/api/group/${groupId}/access-packages`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].accessPackageName).toBe('Contract AP');
    expect(res.body[0].roleName).toBe('Member');
  });

  it('/history returns the audit row(s) from the _history table', async () => {
    const res = await agent.get(`/api/group/${groupId}/history`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    // fetchHistory spreads each _history rowData, so the group's own columns show.
    expect(res.body.some(h => h.displayName === 'Contract Group Detail')).toBe(true);
  });
});
