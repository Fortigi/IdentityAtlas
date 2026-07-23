// Contract test — relationship/reference list filters against a real PostgreSQL
// schema. Verifies "AI agents without an owner", "groups without members" and
// "groups without an owner" resolve to exactly the right rows, plus the filter
// fields are advertised on the column-discovery endpoints.
//
// Fixtures (from the DoR sign-off packet):
//   Principals: AgentA (AIAgent, NO owner), AgentB (AIAgent, has an Owner row),
//               OwnerU (User, is AgentB's owner).
//   Groups:     G1 (a Direct member), G2 (empty), G3 (an owner, no members),
//               G4 (a soft-deleted member), G5 (only an Eligible assignment).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const groups = {};

const q = (obj) => encodeURIComponent(JSON.stringify(obj));
const names = (res) => res.body.data.map((r) => r.displayName).sort();

async function insResource(displayName, resourceType) {
  const r = await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled")
     VALUES ($1, $2, $3, true) RETURNING "id"`,
    [systemId, displayName, resourceType],
  );
  return r.rows[0].id;
}

async function insPrincipal(displayName, principalType) {
  const r = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType")
     VALUES ($1, $2, $3) RETURNING "id"`,
    [systemId, displayName, principalType],
  );
  return r.rows[0].id;
}

async function insAssignment(resourceId, assignmentType, { resourceType = null, deleted = false } = {}) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("resourceId", "principalId", "assignmentType", "systemId", "principalType", "resourceType", "deletedAt")
     VALUES ($1, gen_random_uuid(), $2, $3, 'User', $4, $5)`,
    [resourceId, assignmentType, systemId, resourceType, deleted ? new Date() : null],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-relfilter') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  // ── Principals ──
  const agentA = await insPrincipal('ZZRELFILT-AgentA', 'AIAgent'); // no owner
  const agentB = await insPrincipal('ZZRELFILT-AgentB', 'AIAgent'); // has owner
  const ownerU = await insPrincipal('ZZRELFILT-OwnerU', 'User');
  void agentA;
  await pool.query(
    `INSERT INTO "PrincipalRelationships" ("principalId", "relatedPrincipalId", "relationshipType", "systemId")
     VALUES ($1, $2, 'Owner', $3)`,
    [agentB, ownerU, systemId],
  );

  // ── Groups ──
  groups.G1 = await insResource('ZZRELFILT-G1-member', 'Group');
  groups.G2 = await insResource('ZZRELFILT-G2-empty', 'Group');
  groups.G3 = await insResource('ZZRELFILT-G3-ownerOnly', 'Group');
  groups.G4 = await insResource('ZZRELFILT-G4-deletedMember', 'Group');
  groups.G5 = await insResource('ZZRELFILT-G5-eligibleOnly', 'Group');

  // G1: a live Direct member (resourceType NULL = plain group membership).
  await insAssignment(groups.G1, 'Direct');
  // G4: a soft-deleted Direct member → must NOT count.
  await insAssignment(groups.G4, 'Direct', { deleted: true });
  // G5: only an Eligible assignment → not active membership.
  await insAssignment(groups.G5, 'Eligible');

  // G3: an owner, no members. Ownership = a synthetic GroupOwnership resource
  // linked via HasOwnership, with a Direct assignment on THAT resource.
  const own3 = await insResource('ZZRELFILT-G3-owner', 'GroupOwnership');
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
     VALUES ($1, $2, 'HasOwnership', $3)`,
    [groups.G3, own3, systemId],
  );
  await insAssignment(own3, 'Direct', { resourceType: 'GroupOwnership' });
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "PrincipalRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('relationship filters — AI agent owners (/api/users)', () => {
  const base = { principalType: 'AIAgent' };

  it('hasOwner=No returns only the ownerless agent (AC1)', async () => {
    const res = await agent.get(`/api/users?search=ZZRELFILT&filters=${q({ ...base, hasOwner: 'No' })}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['ZZRELFILT-AgentA']);
  });

  it('hasOwner=Yes returns only the owned agent (AC2)', async () => {
    const res = await agent.get(`/api/users?search=ZZRELFILT&filters=${q({ ...base, hasOwner: 'Yes' })}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['ZZRELFILT-AgentB']);
  });

  it('an invalid value is ignored → both agents returned (AC3)', async () => {
    const res = await agent.get(`/api/users?search=ZZRELFILT&filters=${q({ ...base, hasOwner: 'Maybe' })}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['ZZRELFILT-AgentA', 'ZZRELFILT-AgentB']);
  });
});

describe('relationship filters — group members & owners (/api/resources)', () => {
  const url = (extra) => `/api/resources?systemId=${systemId}&filters=${q({ resourceType: 'Group', ...extra })}`;

  it('hasMembers=No returns empty/owner-only/deleted-member/eligible-only groups (AC5)', async () => {
    const res = await agent.get(url({ hasMembers: 'No' }));
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      'ZZRELFILT-G2-empty',
      'ZZRELFILT-G3-ownerOnly',
      'ZZRELFILT-G4-deletedMember',
      'ZZRELFILT-G5-eligibleOnly',
    ]);
  });

  it('hasMembers=Yes returns only the group with a live Direct member (AC6)', async () => {
    const res = await agent.get(url({ hasMembers: 'Yes' }));
    expect(names(res)).toEqual(['ZZRELFILT-G1-member']);
  });

  it('hasOwner=Yes returns only the owned group (AC7)', async () => {
    const res = await agent.get(url({ hasOwner: 'Yes' }));
    expect(names(res)).toEqual(['ZZRELFILT-G3-ownerOnly']);
  });

  it('hasOwner=No excludes the owned group (AC7)', async () => {
    const res = await agent.get(url({ hasOwner: 'No' }));
    expect(names(res)).toEqual([
      'ZZRELFILT-G1-member',
      'ZZRELFILT-G2-empty',
      'ZZRELFILT-G4-deletedMember',
      'ZZRELFILT-G5-eligibleOnly',
    ]);
  });

  it('combining hasMembers=No AND hasOwner=No narrows to the truly orphaned groups', async () => {
    const res = await agent.get(url({ hasMembers: 'No', hasOwner: 'No' }));
    expect(names(res)).toEqual([
      'ZZRELFILT-G2-empty',
      'ZZRELFILT-G4-deletedMember',
      'ZZRELFILT-G5-eligibleOnly',
    ]);
  });
});

describe('relationship filters — advertised on column-discovery endpoints', () => {
  it('/api/user-columns-page advertises hasOwner with Yes/No values', async () => {
    const res = await agent.get('/api/user-columns-page');
    expect(res.status).toBe(200);
    const col = res.body.find((c) => c.column === 'hasOwner');
    expect(col).toBeTruthy();
    expect(col.values).toEqual(['Yes', 'No']);
  });

  it('/api/resource-columns advertises hasOwner and hasMembers', async () => {
    const res = await agent.get('/api/resource-columns');
    expect(res.status).toBe(200);
    const cols = res.body.map((c) => c.column);
    expect(cols).toContain('hasOwner');
    expect(cols).toContain('hasMembers');
  });
});
