// Contract tests for the SQL patterns underlying matrix/shared.js.
//
// The unit tests in shared.test.js cover pure JS helpers. These tests cover
// the SQL that scopeCounts and subjectScopeClauses emit against the real
// schema — catching wrong table names, wrong column names in WHERE clauses,
// wrong casts, or missing views before they reach production.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'matrix-contract-test') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  // Materialized views are created unpopulated by the migrations. Refresh once
  // so they can be queried; with empty base tables the result is 0 rows.
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function insertPrincipal(externalId, principalType = 'User') {
  await pool.query(
    `INSERT INTO "Principals" ("systemId", "externalId", "principalType") VALUES ($1, $2, $3)`,
    [systemId, externalId, principalType],
  );
}

async function countAll(table, where = '') {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "${table}"${where}`);
  return r.rows[0].c;
}

// ── scopeCounts SQL patterns ─────────────────────────────────────────────────

// Counts are scoped to this file's own systemId: the contract suite shares one
// DB container, so sibling files' Principals would otherwise leak into a global
// COUNT(*). The assertion under test is the group-exclusion WHERE clause, which
// is preserved verbatim.
const GROUP_EXCL = `("principalType" IS NULL OR "principalType" != '#microsoft.graph.group')`;

describe('scopeCounts — Principals', () => {
  it('returns an integer (not a string) for an empty table', async () => {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "Principals" WHERE "systemId" = $1`, [systemId]);
    expect(typeof r.rows[0].c).toBe('number');
    expect(r.rows[0].c).toBe(0);
  });

  it('scoped count uses the group-exclusion WHERE from subjectScopeClauses', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM "Principals" WHERE "systemId" = $1 AND ${GROUP_EXCL}`,
      [systemId],
    );
    expect(typeof r.rows[0].c).toBe('number');
    expect(r.rows[0].c).toBe(0);
  });

  it('reflects a newly inserted User in both the scoped and total counts', async () => {
    await insertPrincipal('u1');
    const scoped = await countAll('Principals', ` WHERE "systemId" = ${systemId} AND ${GROUP_EXCL}`);
    const total  = await countAll('Principals', ` WHERE "systemId" = ${systemId}`);
    expect(scoped).toBe(1);
    expect(total).toBe(1);
  });

  it('group-typed Principals are excluded from scoped count but included in total', async () => {
    await insertPrincipal('g1', '#microsoft.graph.group');
    await insertPrincipal('u1', 'User');
    const scoped = await countAll('Principals', ` WHERE "systemId" = ${systemId} AND ${GROUP_EXCL}`);
    const total  = await countAll('Principals', ` WHERE "systemId" = ${systemId}`);
    expect(scoped).toBe(1); // only the User
    expect(total).toBe(2);  // User + group
  });
});

describe('scopeCounts — Identities and Resources', () => {
  it('counts Identities and returns an integer', async () => {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "Identities"`);
    expect(typeof r.rows[0].c).toBe('number');
  });

  it('counts Resources and returns an integer', async () => {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "Resources"`);
    expect(typeof r.rows[0].c).toBe('number');
  });
});

// ── view existence and column shape ─────────────────────────────────────────

describe('vw_ResourceUserPermissionAssignments', () => {
  it('is queryable and exposes principalId and resourceId', async () => {
    const r = await pool.query(
      `SELECT "principalId", "resourceId" FROM "vw_ResourceUserPermissionAssignments" LIMIT 0`,
    );
    const cols = r.fields.map(f => f.name);
    expect(cols).toContain('principalId');
    expect(cols).toContain('resourceId');
  });
});
