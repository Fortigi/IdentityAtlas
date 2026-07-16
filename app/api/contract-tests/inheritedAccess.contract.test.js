// Contract test — matrix/inheritedAccess.js against real PostgreSQL 16.
//
// The inherited-access builders fold Azure-style "capability @ scope" grants that
// propagate DOWN the Contains hierarchy into the matrix ("Owner on the
// subscription" ⇒ Indirect on every key vault beneath it). They emit real
// recursive SQL (the ancestor walk), read generated columns (capabilityId /
// targetNodeId out of extendedAttributes), and resolve propagationScope + effect —
// none of which the SQL-blind unit mocks in inheritedAccess.test.js can verify.
//
// This pins the folded-count + flat-row output for a seeded scope against the real
// schema, so the near-identical rollup builders (buildInheritedRollupCounts /
// buildInheritedContextCounts / buildInheritedFoldCounts) can be deduped under #647
// with a behaviour-preserving guarantee. (#666 — inheritedAccess.js had unit
// coverage only; the whole point of the file needs a real-Postgres test.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { capabilityResourceId } from '../src/lib/capabilityId.js';
import { buildInheritedRollupCounts, buildInheritedFlatRows } from '../src/matrix/inheritedAccess.js';

let pool;
let systemId;
let subscriptionId, keyVaultId, capResourceId, holderId, otherId;

// The capability the holder is granted at the subscription. Its synthesized
// resource id at the (scoped) key-vault node is deterministic, so the assertions
// can recompute it.
const CAP = 'contract-inherited-owner';
const SYS_NAME = 'contract-inherited-access';

// A `built` scope object in the shape the matrix generators pass: resource scope =
// the key-vault node; subject scope optional. The builders render each fragment
// through a per-query binder, so `resource` / `subject` are closures returning
// `{ sql }`; here we inline the seeded uuid (not user input) so no binder is used.
function builtScopedTo(resourceIdLiteral, subjectSql = null) {
  return {
    hasResource: true,
    hasSubject: subjectSql != null,
    resource: () => ({ sql: `(SELECT '${resourceIdLiteral}'::uuid)` }),
    subject: () => ({ sql: subjectSql }),
  };
}

beforeAll(async () => {
  // The builders + the effective-access engine use the module-level db pool, which
  // is lazy and built from DATABASE_URL at first query — point it at the container.
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`,
    [SYS_NAME],
  );
  systemId = sys.rows[0].id;

  // Two scope nodes forming a containment chain: Subscription ⊃ Key Vault. Both
  // are plain scope nodes (capabilityId IS NULL) so the resource scope selects them.
  const sub = await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES ($1, 'Subscription A', 'AzureScope', '{"scopeTypeLabel":"Subscription"}') RETURNING "id"`,
    [systemId],
  );
  subscriptionId = sub.rows[0].id;
  const kv = await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES ($1, 'Key Vault 1', 'AzureScope', '{"scopeTypeLabel":"KeyVault"}') RETURNING "id"`,
    [systemId],
  );
  keyVaultId = kv.rows[0].id;

  // Subscription Contains Key Vault (propagates=true by default → grants ride down).
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
     VALUES ($1, $2, 'Contains', $3)`,
    [subscriptionId, keyVaultId, systemId],
  );

  // The capability-resource "Owner @ Subscription A": capabilityId + targetNodeId
  // live in extendedAttributes and are surfaced by the generated columns the engine
  // gathers on.
  const cap = await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES ($1, 'Owner @ Subscription A', 'AzureRoleAssignment',
             jsonb_build_object('capabilityId', $2::text, 'targetNodeId', $3::text, 'roleName', 'Owner'))
     RETURNING "id"`,
    [systemId, CAP, subscriptionId],
  );
  capResourceId = cap.rows[0].id;

  // Alice holds Owner on the subscription and inherits it down to the key vault.
  // Bob holds nothing — the subject-scope filter test drops Alice when scoped to Bob.
  const h = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType", "extendedAttributes")
     VALUES ($1, 'Alice', 'alice@example.com', 'User', '{"department":"Engineering"}') RETURNING "id"`,
    [systemId],
  );
  holderId = h.rows[0].id;
  const o = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType", "extendedAttributes")
     VALUES ($1, 'Bob', 'bob@example.com', 'User', '{"department":"Finance"}') RETURNING "id"`,
    [systemId],
  );
  otherId = o.rows[0].id;

  // The grant: Alice is Owner on Subscription A, propagating self-and-descendants.
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("resourceId", "principalId", "assignmentType", "systemId", "principalType", "effect", "propagationScope")
     VALUES ($1, $2, 'Direct', $3, 'User', 'allow', 'selfAndDescendants')`,
    [capResourceId, holderId, systemId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.DATABASE_URL; // singleFork — env mutations leak across files
});

describe('buildInheritedRollupCounts — inherited (propagated-down) grant folding', () => {
  it('folds the inherited holder into per-(resource, group-value) distinct counts', async () => {
    const r = await buildInheritedRollupCounts(pool, builtScopedTo(keyVaultId), 'principal', 'ext.department', []);
    expect(r).not.toBeNull();

    // The count lands on the SYNTHESIZED capability-resource at the scoped key
    // vault (capability rides constant down the tree, same deterministic id).
    const expectedResourceId = capabilityResourceId(keyVaultId, CAP);
    expect(r.counts).toEqual([
      { resourceId: expectedResourceId, groupValue: 'Engineering', directCount: 1, governedCount: 0 },
    ]);
    expect(r.groupValues).toEqual(['Engineering']);
    expect(r.groupTotals).toEqual([{ groupValue: 'Engineering', total: 1 }]);
    expect(r.resources[0]).toMatchObject({
      resourceId: expectedResourceId, resourceType: 'AzureRoleAssignment',
      systemId, systemName: SYS_NAME,
    });
  });

  it('returns null for an unbounded (no resource scope) matrix', async () => {
    const r = await buildInheritedRollupCounts(pool, { ...builtScopedTo(keyVaultId), hasResource: false }, 'principal', 'ext.department', []);
    expect(r).toBeNull();
  });
});

describe('buildInheritedFlatRows — inherited flat matrix rows', () => {
  it('emits one flat row for the inherited access, carrying the inheritance source', async () => {
    const out = await buildInheritedFlatRows(pool, builtScopedTo(keyVaultId), 'principal', []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      resourceId: capabilityResourceId(keyVaultId, CAP),
      membershipType: 'Indirect', // granted at an ancestor node, not the focus → Indirect
      memberId: holderId,
      memberDisplayName: 'Alice',
      systemId, systemName: SYS_NAME,
      inheritedNodeId: keyVaultId,
      inheritedPrincipalId: holderId,
      managedByAccessPackage: false,
    });
  });

  it('honours the subject scope — an inherited holder outside it is dropped', async () => {
    // Scope subjects to Bob (who holds nothing) → Alice's inherited row is filtered out.
    const out = await buildInheritedFlatRows(pool, builtScopedTo(keyVaultId, `(SELECT '${otherId}'::uuid)`), 'principal', []);
    expect(out).toEqual([]);
  });

  it('includes an inherited holder that IS within the subject scope', async () => {
    const out = await buildInheritedFlatRows(pool, builtScopedTo(keyVaultId, `(SELECT '${holderId}'::uuid)`), 'principal', []);
    expect(out).toHaveLength(1);
    expect(out[0].memberId).toBe(holderId);
  });
});
