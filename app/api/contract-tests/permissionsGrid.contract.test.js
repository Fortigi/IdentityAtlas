// Contract test — routes/permissions/grid.js against the real PostgreSQL 16
// schema. /api/permissions is the matrix data feed — the most important read in
// the app — and runs a big dynamic query over the permission matview.
//
// Guards #679, and catches a real bug: when a userLimit is set (the UI default
// is 25), the limited-branch main query never interpolated ${filterWhere}, so
// user-column filters (e.g. department) were silently ignored — the matrix
// showed the top-N users by assignment count regardless of the filter. The
// no-limit branch applied the filter, so the SQL-blind unit tests never noticed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, resId, hrId, engId;

const rowsForResource = (body) => body.data.filter(d => d.resourceId === resId);
const memberIds = (body) => rowsForResource(body).map(d => d.memberId);

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-permissions-grid') RETURNING "id"`,
  )).rows[0].id;

  resId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Shared Group', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  hrId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "department")
     VALUES (gen_random_uuid(), $1, 'HR Person', 'hr@example.com', 'User', 'HR') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
  engId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "department")
     VALUES (gen_random_uuid(), $1, 'Eng Person', 'eng@example.com', 'User', 'Engineering') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', 'User', $4), ($1, $3, 'Direct', 'User', $4)`,
    [resId, hrId, engId, systemId],
  );

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]); // cascades Principals/Resources/RA
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /api/permissions — the matrix feed', () => {
  it('returns matrix rows for the seeded assignments (no limit)', async () => {
    const res = await agent.get('/api/permissions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const rows = rowsForResource(res.body);
    expect(rows.length).toBe(2);
    const row = rows.find(r => r.memberId === hrId);
    expect(row.memberDisplayName).toBe('HR Person');
    expect(row.resourceDisplayName).toBe('Shared Group');
    expect(row.membershipType).toBe('Direct');
    expect(res.body.totalUsers).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(res.body.managedByPackages)).toBe(true);
  });

  it('applies a user-column filter in the no-limit branch', async () => {
    const res = await agent.get(`/api/permissions?filters=${encodeURIComponent('{"department":"HR"}')}`);
    expect(res.status).toBe(200);
    expect(memberIds(res.body)).toEqual([hrId]);
  });

  it('applies a user-column filter WITH a userLimit (regression: it was ignored)', async () => {
    const res = await agent.get(`/api/permissions?userLimit=10000&filters=${encodeURIComponent('{"department":"HR"}')}`);
    expect(res.status).toBe(200);
    const ids = memberIds(res.body);
    expect(ids).toContain(hrId);
    expect(ids).not.toContain(engId);
  });

  it('returns both users under a userLimit with no filter', async () => {
    const res = await agent.get('/api/permissions?userLimit=10000');
    expect(res.status).toBe(200);
    expect(memberIds(res.body).sort()).toEqual([hrId, engId].sort());
  });
});

describe('GET /api/user-columns', () => {
  it('schema=true lists Principals filter columns (incl. department)', async () => {
    const res = await agent.get('/api/user-columns?schema=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const cols = res.body.map(c => c.column);
    expect(cols).toContain('department');
  });
});
