// Contract test — default row visibility on the matrix resource axis (#937),
// against a real PostgreSQL schema and the real matviews.
//
// A governed assignment is a real Direct membership ON the business role, so
// without a filter the role appears twice in one matrix: once as a SOLL column
// and once as an ordinary resource row. The exclusion lives in SQL the unit
// tests only see as a string — this file is what proves the emitted query
// actually drops that row, keeps the group row it governs, and leaves the
// governance colouring intact.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { deleteSystemScopedRows } from '../test-utils/systemScopedCleanup.js';

let agent;
let pool;
let systemId;
let groupId;
let businessRoleId;
let ownershipId;
let principalId;

const EMPTY_SCOPE = { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } };
const post = (filter) => agent.post('/api/matrix/data').send({ filter: { ...EMPTY_SCOPE, ...filter } });
const rowsFor = (body, id) => body.data.filter(r => r.resourceId === id);

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-row-visibility') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
     VALUES ($1, 'Rita', 'rita@example.com', 'User') RETURNING "id"`, [systemId]);
  principalId = p.rows[0].id;

  const newResource = async (name, resourceType, governance = false) => {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "governanceResource")
       VALUES ($1, $2, $3, $4) RETURNING "id"`, [systemId, name, resourceType, governance]);
    return r.rows[0].id;
  };
  groupId        = await newResource('RV Engineering', 'Group');
  businessRoleId = await newResource('RV Engineer role', 'BusinessRole', true);
  // Decision 3's regression pin: ownership is its own resource type and stays
  // visible — it is the only place the matrix shows who controls the group.
  ownershipId    = await newResource('RV Engineering (Owners)', 'GroupOwnership');

  // The business role Contains the group…
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
     VALUES ($1, $2, 'Contains', $3)`, [businessRoleId, groupId, systemId]);

  // …and Rita holds the role (a real Direct membership on the role itself,
  // flagged governed), the group it grants, and ownership of that group.
  const assign = async (resourceId, governed) => pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType", "governed")
     VALUES ($1, $2, 'Direct', $3, 'User', $4)`, [resourceId, principalId, systemId, governed]);
  await assign(businessRoleId, true);
  await assign(groupId, true);
  await assign(ownershipId, false);

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  await deleteSystemScopedRows(pool, systemId);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /matrix/data — business roles on the resource axis', () => {
  it('drops the business-role row but keeps the group it governs', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    // Both halves matter: the seed produces a membership row for each, so a
    // query that dropped everything would satisfy "no business-role row".
    expect(rowsFor(res.body, businessRoleId)).toHaveLength(0);
    expect(rowsFor(res.body, groupId)).toHaveLength(1);
  });

  it('leaves the governance (SOLL) side of the group row intact', async () => {
    const res = await post({});
    // The role still colours the group's cell and still appears as a column —
    // this is the thing the exclusion must not take with it.
    const [row] = rowsFor(res.body, groupId);
    expect(row.managedByAccessPackage).toBe(true);
    const mapped = res.body.managedByPackages.filter(m => m.resourceId === groupId);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].accessPackageIds).toContain(businessRoleId);
  });

  it('keeps ownership rows — they are unique access, not a duplicated column', async () => {
    const res = await post({});
    expect(rowsFor(res.body, ownershipId)).toHaveLength(1);
  });

  it('shows the business-role row when the matrix opts in', async () => {
    const res = await post({ includeBusinessRoles: true });
    expect(res.status).toBe(200);
    const [row] = rowsFor(res.body, businessRoleId);
    expect(row).toBeDefined();
    expect(row.resourceType).toBe('BusinessRole');
    expect(row.membershipType).toBe('Direct');
    expect(rowsFor(res.body, groupId)).toHaveLength(1);
  });

  it('shows it when the resource scope explicitly selects the type', async () => {
    const res = await post({
      resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['BusinessRole'] }], exclude: [] },
    });
    expect(res.status).toBe(200);
    expect(rowsFor(res.body, businessRoleId)).toHaveLength(1);
    // …and only that type: the explicit scope still scopes.
    expect(rowsFor(res.body, groupId)).toHaveLength(0);
  });

  it('counts the same resources it renders', async () => {
    const hidden = await post({});
    const shown  = await post({ includeBusinessRoles: true });
    // resourceTotal is a global count over a shared contract database, so the
    // assertion is the DIFFERENCE the flag makes, not an absolute number.
    expect(shown.body.resourceTotal).toBeGreaterThan(hidden.body.resourceTotal);
    const ids = (body) => new Set(body.data.map(r => r.resourceId));
    expect(ids(hidden.body).has(businessRoleId)).toBe(false);
    expect(ids(shown.body).has(businessRoleId)).toBe(true);
  });
});

describe('POST /matrix/preview + /matrix/scope-stats', () => {
  it('excludes business roles from the preview counts, and includes them with the flag', async () => {
    const hidden = await agent.post('/api/matrix/preview').send({ filter: EMPTY_SCOPE });
    const shown  = await agent.post('/api/matrix/preview').send({ filter: { ...EMPTY_SCOPE, includeBusinessRoles: true } });
    expect(hidden.status).toBe(200);
    expect(shown.body.resourceCount).toBeGreaterThan(hidden.body.resourceCount);
    expect(shown.body.resourceTotal).toBeGreaterThan(hidden.body.resourceTotal);
    // The governed membership ON the role drops out of the totals with it.
    expect(shown.body.assignmentCount).toBeGreaterThan(hidden.body.assignmentCount);
  });

  it('runs scope-stats against the real schema with the exclusion applied', async () => {
    const res = await agent.post('/api/matrix/scope-stats').send({ filter: EMPTY_SCOPE });
    expect(res.status).toBe(200);
    const shown = await agent.post('/api/matrix/scope-stats')
      .send({ filter: { ...EMPTY_SCOPE, includeBusinessRoles: true } });
    expect(shown.body.resourceCount).toBeGreaterThan(res.body.resourceCount);
  });
});

describe('GET /api/resources — the second caller of the shared deny-list', () => {
  it('hides business roles by default and lists them on the governance opt-in', async () => {
    const hidden = await agent.get(`/api/resources?systemId=${systemId}&limit=100`);
    expect(hidden.status).toBe(200);
    const hiddenIds = hidden.body.data.map(r => r.id);
    expect(hiddenIds).toContain(groupId);
    expect(hiddenIds).not.toContain(businessRoleId);

    const shown = await agent.get(`/api/resources?systemId=${systemId}&limit=100&includeBusinessRoles=true`);
    expect(shown.body.data.map(r => r.id)).toContain(businessRoleId);
  });
});
