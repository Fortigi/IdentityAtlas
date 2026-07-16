// Contract test — the universal data-model value invariants are enforced at the
// DB layer by migration 054, not only by the ingest API. A write that bypasses
// ingest (a future migration, a manual backfill, a direct connection) still
// cannot persist a retired assignmentType or a renamed resourceType literal.
//
// Companion to app/api/src/db/migrations/054_value_guard_constraints.sql.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

// UUIDs unique to this file: uq_RA_principal is global (not system-scoped), so
// reusing another test's (resourceId, principalId) would collide on the shared
// DB container under some run orders.
const RES = 'faded054-0000-0000-0000-000000000001';
const PRI = 'faded054-0000-0000-0000-000000000002';

// 23514 = check_violation (a value blocked by a CHECK constraint).
const CHECK_VIOLATION = { code: '23514' };

const insertRA = (assignmentType, resourceType = null) =>
  pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "assignmentType", "resourceType")
     VALUES ($1, $2, $3, $4, $5)`,
    [systemId, RES, PRI, assignmentType, resourceType],
  );

const insertResource = (resourceType) =>
  pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'value-guard resource', $2)`,
    [systemId, resourceType],
  );

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test-valueguard', 'value-guard-constraints') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
});

describe('assignmentType — DB allow-list (migration 054)', () => {
  it('holds no live row outside the legal set (a CHECK makes this table-wide invariant unbreakable)', async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS c FROM "ResourceAssignments"
        WHERE "assignmentType" NOT IN ('Direct', 'Indirect', 'Eligible')`,
    );
    expect(r.rows[0].c).toBe(0);
  });

  it('accepts the three universal values', async () => {
    for (const t of ['Direct', 'Indirect', 'Eligible']) {
      await expect(insertRA(t)).resolves.toBeDefined();
      await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
    }
  });

  it('rejects every retired assignmentType via the CHECK constraint', async () => {
    const retired = ['Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];
    for (const t of retired) {
      await expect(insertRA(t), `${t} must be rejected`).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });
});

describe('resourceType — DB negative guard, open vocabulary (migrations 054, 058)', () => {
  it('accepts arbitrary open-vocabulary resourceTypes on Resources', async () => {
    // Entra types plus CSV/Azure/midPoint types that are NOT in any allow-list.
    // 'AppRole' is the canonical, unprefixed spelling that 058 renamed
    // 'EntraAppRole' to — it must keep validating.
    for (const rt of ['Group', 'EntraDirectoryRole', 'AppRole', 'SAPRole', 'AzureRoleAssignment', 'Service']) {
      await expect(insertResource(rt), `${rt} must be accepted`).resolves.toBeDefined();
    }
  });

  it('accepts NULL resourceType (orphan rows keep it NULL)', async () => {
    await expect(insertResource(null)).resolves.toBeDefined();
    await expect(insertRA('Direct', null)).resolves.toBeDefined();
  });

  // EntraGroup/EntraRole retired by 052; EntraAppRole by 058.
  const RETIRED_RESOURCE_TYPES = ['EntraGroup', 'EntraRole', 'EntraAppRole'];

  it('rejects the renamed Entra-era literals on Resources', async () => {
    for (const rt of RETIRED_RESOURCE_TYPES) {
      await expect(insertResource(rt), `${rt} must be rejected`).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('rejects the renamed Entra-era literals on ResourceAssignments', async () => {
    for (const rt of RETIRED_RESOURCE_TYPES) {
      await expect(insertRA('Direct', rt), `${rt} must be rejected`).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('holds no live row on the retired literals (the CHECK makes this table-wide)', async () => {
    // 058 rewrote existing rows before tightening the constraint; if that order
    // were wrong the migration would have failed, but assert the end state too.
    for (const table of ['Resources', 'ResourceAssignments']) {
      const r = await pool.query(
        `SELECT count(*)::int AS c FROM "${table}" WHERE "resourceType" = ANY($1)`,
        [RETIRED_RESOURCE_TYPES],
      );
      expect(r.rows[0].c, `${table} must hold no retired resourceType`).toBe(0);
    }
  });
});
