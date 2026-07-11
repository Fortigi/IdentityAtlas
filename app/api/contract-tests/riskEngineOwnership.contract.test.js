// Contract test — the risk engine's ownership traversal against a real schema.
//
// Since migration 046 ownership is no longer an assignmentType='Owner' row on
// the group's own resource; it's a Direct assignment on a synthetic
// GroupOwnership resource linked to the owned group by a HasOwnership
// relationship. loadScoringData()'s owner-count / principal-ownership indexes
// (and the membership index it uses for propagation) must reflect that:
//   - owner counts key on the OWNED group id, not the synthetic resource,
//   - a principal's ownerships resolve to the owned groups,
//   - GroupOwnership Direct rows must NOT leak into the membership headcount or
//     the propagation graph (ownership is admin control, not "has access to").
//
// A unit test with a mocked db can't catch a wrong table/column/join here — only
// a real PostgreSQL run can. Drives the real loadScoringData by pointing
// db/connection.js at the contract container (DATABASE_URL is honoured first).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const noop = async () => {};

let pool;
let systemId;
let classifierId;
let loadScoringData;
let closePool;

// Fixture ids — a group, its synthetic ownership resource, an owner, a member.
const groupId     = randomUUID();
const ownershipId = randomUUID();
const ownerPid    = randomUUID();
const memberPid   = randomUUID();

beforeAll(async () => {
  // Must be set before db/connection.js is imported so its pool targets the
  // contract container (buildConfig() honours DATABASE_URL first).
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  ({ loadScoringData } = await import('../src/riskscoring/engine.js'));
  ({ closePool } = await import('../src/db/connection.js'));

  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'risk-ownership') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const cls = await pool.query(
    `INSERT INTO "RiskClassifiers" ("displayName", "classifiers", "isActive")
     VALUES ('risk-ownership-fixture', '{}'::jsonb, false) RETURNING "id"`,
  );
  classifierId = cls.rows[0].id;

  // Group + its synthetic ownership resource.
  await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES ($1, $3, 'Admins', 'Group'), ($2, $3, 'Owner @ Admins', 'GroupOwnership')`,
    [groupId, ownershipId, systemId],
  );
  // Owned group ← HasOwnership → ownership resource.
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
     VALUES ($1, $2, 'HasOwnership', $3)`,
    [groupId, ownershipId, systemId],
  );
  // The owner (Direct on the GroupOwnership resource) and a plain Direct member.
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "assignmentType", "resourceType", "principalType")
     VALUES ($1, $2, $3, 'Direct', 'GroupOwnership', 'User'),
            ($1, $4, $5, 'Direct', 'Group',          'User')`,
    [systemId, ownershipId, ownerPid, groupId, memberPid],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "RiskClassifiers" WHERE "id" = $1`, [classifierId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
  await closePool?.();          // release db/connection.js's own pool
  delete process.env.DATABASE_URL; // singleFork — env mutations leak across files
});

describe('loadScoringData — ownership traversal (post migration 046)', () => {
  it('keys owner counts on the OWNED group and resolves principal ownerships to it', async () => {
    const data = await loadScoringData(classifierId, noop);

    // Owner count is attributed to the owned group, not the synthetic resource.
    expect(data.ownerCountMap.get(groupId)).toBe(1);
    expect(data.ownerCountMap.get(ownershipId)).toBeUndefined();

    // The owner's ownership set resolves to the owned group id.
    expect(data.principalOwnerships.get(ownerPid)).toBeInstanceOf(Set);
    expect(data.principalOwnerships.get(ownerPid).has(groupId)).toBe(true);
    expect(data.principalOwnerships.get(ownerPid).has(ownershipId)).toBe(false);
  });

  it('excludes GroupOwnership Direct rows from membership headcount and propagation', async () => {
    const data = await loadScoringData(classifierId, noop);

    // Plain member is counted; the ownership resource is not a "group with members".
    expect(data.memberCountMap.get(groupId)).toBe(1);
    expect(data.memberCountMap.get(ownershipId)).toBeUndefined();

    // The owner is not double-counted as a member (would poison propagation).
    expect(data.principalMemberships.get(ownerPid)).toBeUndefined();
    expect(data.resourceMembers.get(ownershipId)).toBeUndefined();

    // The real member still flows into the propagation graph.
    expect(data.principalMemberships.get(memberPid)?.has(groupId)).toBe(true);
    expect(data.resourceMembers.get(groupId)?.has(memberPid)).toBe(true);
  });
});
