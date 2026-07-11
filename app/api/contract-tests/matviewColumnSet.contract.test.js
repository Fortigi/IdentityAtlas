// Contract test — the live matrix materialized view exposes a stable column set.
//
// vw_ResourceUserPermissionAssignments has been redefined ~10 times (043/046/049/…).
// The matrix UI and several read routes select fixed columns off it; a future
// redefinition that silently drops or renames one would break the matrix at read
// time with no unit test failing (unit tests mock the DB). This pins the column
// contract structurally — a redefinition that removes a required column fails here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

let pool;

// Columns the matrix / read layer depends on. Presence-checked (extra columns are
// fine); dropping or renaming any of these must fail. This is the collapsed
// per-(resource, principal, how-held) grid — its unique key is
// (resourceId, principalId, membershipType).
const REQUIRED_COLUMNS = [
  'resourceId',
  'principalId',
  'principalType',
  'membershipType',
  'managedByAccessPackage',
];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.end();
});

describe('vw_ResourceUserPermissionAssignments — column contract', () => {
  it('exposes every column the matrix/read layer depends on', async () => {
    // `SELECT * LIMIT 0` returns the field metadata even for a matview (which is
    // absent from information_schema.columns), and needs no REFRESH.
    const res = await pool.query('SELECT * FROM "vw_ResourceUserPermissionAssignments" LIMIT 0');
    const cols = new Set(res.fields.map((f) => f.name));
    const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c));
    expect(missing, `matview is missing required column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps membershipType as the collapsed how-held value (no legacy source types leak as columns)', async () => {
    // A sanity assertion that the view still models "how held" via membershipType
    // rather than exposing a raw assignmentType column consumers would misread.
    const res = await pool.query('SELECT * FROM "vw_ResourceUserPermissionAssignments" LIMIT 0');
    const cols = new Set(res.fields.map((f) => f.name));
    expect(cols.has('membershipType')).toBe(true);
    expect(cols.has('assignmentType')).toBe(false);
  });
});
