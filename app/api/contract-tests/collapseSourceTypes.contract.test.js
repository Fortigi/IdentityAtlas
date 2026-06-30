// Contract test — migrations 044a (dedup) + 045 (collapse) turn the Entra
// "source" assignment types into the three universal kinds WITHOUT tripping the
// (resourceId, subject, assignmentType) unique indexes.
//
// Regression for the production boot crash: 045 is a blind UPDATE that assumed
// no two source types ever collapse to the same key. Real data broke that — a
// single (resourceId, principalId) can hold an 'AppRole' AND an 'OAuth2Grant'
// (both → 'Direct'), or a source row alongside a literal 'Direct'. The UPDATE
// then failed with "duplicate key value violates unique constraint
// uq_RA_principal", and because migrations run before the web port binds, the
// container crash-looped (Azure "Application Error"). Migration 044a now runs
// immediately before 045 and dedupes those rows first.
//
// The matrix matview always GROUP BY'd these duplicates away at read time
// (migration 026); collapsing the STORED value forces the same dedup here. This
// test runs the real 044a + 045 SQL against the real schema, in order, and
// proves the pair dedupes-then-collapses instead of throwing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migDir = join(__dirname, '..', 'src', 'db', 'migrations');
const dedupSql    = readFileSync(join(migDir, '044a_dedup_before_source_collapse.sql'), 'utf8');
const collapseSql = readFileSync(join(migDir, '045_collapse_source_assignment_types.sql'), 'utf8');

// Apply the two migrations in the order the runner would (044a before 045).
async function dedupThenCollapse(pool) {
  await pool.query(dedupSql);
  return pool.query(collapseSql);
}

let pool;
let systemId;

const R  = '11111111-1111-1111-1111-111111111111'; // resource A
const R2 = '22222222-2222-2222-2222-222222222222'; // resource B
const U  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // principal
const I  = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // identity

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'collapse-045') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
});

async function insertRA({ resourceId = R, principalId = null, identityId = null, assignmentType, deletedAt = null }) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "identityId", "assignmentType", "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [systemId, resourceId, principalId, identityId, assignmentType, deletedAt],
  );
}

async function rows(resourceId, { principalId = null, identityId = null }) {
  const r = await pool.query(
    `SELECT "assignmentType", "deletedAt" FROM "ResourceAssignments"
      WHERE "resourceId" = $1
        AND "principalId" IS NOT DISTINCT FROM $2
        AND "identityId"  IS NOT DISTINCT FROM $3
      ORDER BY "assignmentType"`,
    [resourceId, principalId, identityId],
  );
  return r.rows;
}

describe('migration 045 — collision-safe source-type collapse', () => {
  it('collapses two distinct Direct-mapped source types on one (resource, principal) to a single Direct row (regression: old SQL threw uq_RA_principal)', async () => {
    await insertRA({ principalId: U, assignmentType: 'AppRole' });
    await insertRA({ principalId: U, assignmentType: 'OAuth2Grant' });

    await expect(dedupThenCollapse(pool)).resolves.toBeDefined(); // must NOT throw

    const result = await rows(R, { principalId: U });
    expect(result).toHaveLength(1);
    expect(result[0].assignmentType).toBe('Direct');
  });

  it('handles the same collision on the identity arm (uq_RA_identity)', async () => {
    await insertRA({ identityId: I, assignmentType: 'DirectoryRole' });
    await insertRA({ identityId: I, assignmentType: 'AppRole' });

    await expect(dedupThenCollapse(pool)).resolves.toBeDefined(); // must NOT throw

    const result = await rows(R, { identityId: I });
    expect(result).toHaveLength(1);
    expect(result[0].assignmentType).toBe('Direct');
  });

  it('keeps the literal pre-existing Direct row when a source row would collapse onto it', async () => {
    await insertRA({ principalId: U, assignmentType: 'Direct' });   // already the target
    await insertRA({ principalId: U, assignmentType: 'AppRole' });  // collapses to Direct

    await dedupThenCollapse(pool);

    const result = await rows(R, { principalId: U });
    expect(result).toHaveLength(1);
    expect(result[0].assignmentType).toBe('Direct');
  });

  it('prefers a live survivor over a soft-deleted one', async () => {
    await insertRA({ principalId: U, assignmentType: 'OAuth2Grant', deletedAt: new Date('2020-01-01T00:00:00Z') });
    await insertRA({ principalId: U, assignmentType: 'AppRole' }); // live

    await dedupThenCollapse(pool);

    const result = await rows(R, { principalId: U });
    expect(result).toHaveLength(1);
    expect(result[0].assignmentType).toBe('Direct');
    expect(result[0].deletedAt).toBeNull(); // the live row survived
  });

  it('does NOT touch a governed actual/intent pair when no source row is present (already-upgraded install safety)', async () => {
    // Migration 047 makes `governed` part of the key: a governed membership is
    // two 'Direct' rows (actual governed=false + intent governed=true) on one
    // (resource, principal). When 044a runs as a pending file on an install that
    // already passed 045-049, it must leave that pair alone — the source-row
    // guard ensures it does (neither row is a source type).
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("systemId","resourceId","principalId","assignmentType","governed")
       VALUES ($1,$2,$3,'Direct',false), ($1,$2,$3,'Direct',true)`,
      [systemId, R, U],
    );

    await dedupThenCollapse(pool);

    const r = await pool.query(
      `SELECT "governed" FROM "ResourceAssignments"
        WHERE "resourceId"=$1 AND "principalId"=$2 ORDER BY "governed"`,
      [R, U],
    );
    expect(r.rows.map(x => x.governed)).toEqual([false, true]); // both rows survive
  });

  it('collapses non-colliding source types and leaves distinct cells untouched', async () => {
    await insertRA({ principalId: U, assignmentType: 'AppRoleViaGroup' });        // -> Indirect
    await insertRA({ resourceId: R2, principalId: U, assignmentType: 'DirectoryRoleEligible' }); // -> Eligible

    await dedupThenCollapse(pool);

    expect((await rows(R,  { principalId: U }))[0].assignmentType).toBe('Indirect');
    expect((await rows(R2, { principalId: U }))[0].assignmentType).toBe('Eligible');
  });
});
