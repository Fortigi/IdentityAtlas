// Contract test — the "include child contexts" scope sub-selects used by the
// matrix filter (matrix/filterSql.js), the context filter (contexts/contextFilters.js)
// and the scope timeline (matrix/scopeHistory.js) against a real PG16 schema.
//
// Each walks Contexts down "parentContextId" with a UNION ALL recursive CTE.
// Migration 059's trigger keeps committed writes acyclic, but a cycle that
// predates it (or arrives via a trigger-bypassing writer) made these recurse
// until statement_timeout. They now carry the same CYCLE guard as
// routes/contexts/read.js (SEC-2026-09 I-08). A cycle is seeded with triggers
// off for one session, exactly like contexts.contract.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { buildEntitySubquery } from '../src/matrix/filterSql.js';
import { buildContextFilterSql } from '../src/contexts/contextFilters.js';
import { createParams } from '../src/db/sqlParams.js';

let pool;
let systemId;
let principalId;
let ctxA;
let ctxB;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-context-scope-cycle') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);

  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType") VALUES ($1, 'Cycle member', 'User') RETURNING "id"`,
    [systemId],
  );
  principalId = p.rows[0].id;

  ctxA = randomUUID();
  ctxB = randomUUID();
  for (const [id, parent] of [[ctxA, null], [ctxB, ctxA]]) {
    await pool.query(
      `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "parentContextId", "scopeSystemId")
       VALUES ($1, 'synced', 'Principal', 'Department', $2, $3, $4)`,
      [id, `Cycle ${id}`, parent, systemId],
    );
  }
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, 'Principal', $2, 'sync')`,
    [ctxB, principalId],
  );

  // Close the loop A → B → A with triggers off for this session only.
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    await c.query(`UPDATE "Contexts" SET "parentContextId" = $1 WHERE id = $2`, [ctxB, ctxA]);
  } finally {
    await c.query(`SET session_replication_role = origin`).catch(() => {});
    c.release();
  }
});

// Run `sql` with a short statement_timeout so an unguarded recursion fails
// fast (57014) instead of hanging the suite.
async function runBounded(sql, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '5s'`);
    return (await client.query(sql, params)).rows;
  } finally {
    client.release();
  }
}

describe('include-children context scope terminates on a cyclic parent chain', () => {
  it('matrix/filterSql.js buildEntitySubquery returns the member', async () => {
    const { params, bind } = createParams();
    const { sql } = buildEntitySubquery({
      entity: 'Principal',
      include: [{ kind: 'context', contextId: ctxA, includeChildren: true }],
      validColumns: new Set(),
      contextTypes: new Map([[ctxA, 'Principal']]),
      bind,
    });
    const rows = await runBounded(`SELECT id FROM (${sql}) q WHERE id = ${bind(principalId)}`, params);
    expect(rows.map((r) => r.id)).toEqual([principalId]);
  });

  it('contexts/contextFilters.js buildContextFilterSql returns the member', async () => {
    const { params, bind } = createParams();
    const out = buildContextFilterSql([{ id: ctxA, includeChildren: true, targetType: 'Principal' }], bind);
    const rows = await runBounded(
      `SELECT p."principalId" FROM (SELECT id AS "principalId" FROM "Principals" WHERE "systemId" = ${bind(systemId)}) p
        WHERE ${out.principalClauses[0]}`,
      params,
    );
    expect(rows.map((r) => r.principalId)).toEqual([principalId]);
  });
});
