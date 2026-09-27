// Contract test — a full sync of the shared context tables deletes only what the
// sending system owns.
//
// Contexts and ContextMembers have no systemId column, and every crawler writes
// them. A full sync was bounded only by the caller's scope, so with the built-in
// worker key (unrestricted) it reconciled the WHOLE table against one batch.
// Found on a live stack: loading one SQL system deleted another system's 150
// logical applications, and an analyst's tag membership on an unrelated context
// vanished on a routine refresh. Every count check still passed, because the
// damage was outside the run's own data.
//
// Asserted here against the real schema, driven through scopedDelete the way the
// ingest drives it: system A reconciles with a batch that keeps one context and
// one membership, and everything that is not A's to delete must survive.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { scopedDelete } from '../src/ingest/engine.js';

let pool;
let sysA;
let sysB;

const CTX_COLS = new Set(['id', 'variant', 'targetType', 'contextType', 'displayName', 'scopeSystemId']);
const CM_COLS = new Set(['contextId', 'memberType', 'memberId', 'addedBy', 'addedAt']);

const ID = {
  aKept:    '44444444-0000-0000-0000-00000000000a',
  aGone:    '44444444-0000-0000-0000-00000000000b',
  bSynced:  '44444444-0000-0000-0000-00000000000c',
  unowned:  '44444444-0000-0000-0000-00000000000d',   // synced, no scopeSystemId
  tag:      '44444444-0000-0000-0000-00000000000e',   // manual
};
const M = (n) => `55555555-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

async function ctx(id, variant, scopeSystemId) {
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
     VALUES ($1, $2, 'Principal', 'ContractCtx', $1, $3)`, [id, variant, scopeSystemId]);
}
async function member(contextId, memberId, addedBy) {
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy", "addedAt")
     VALUES ($1, 'Principal', $2, $3, now())`, [contextId, memberId, addedBy]);
}
async function exists(sql, params) {
  return (await pool.query(sql, params)).rows.length > 0;
}
const hasContext = (id) => exists(`SELECT 1 FROM "Contexts" WHERE "id" = $1`, [id]);
const hasMember = (contextId, memberId) =>
  exists(`SELECT 1 FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [contextId, memberId]);

// One full-sync reconcile from system A, keeping exactly `keep`.
async function reconcileFromA(table, keyColumns, tempDdl, keep, scope, cols) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE "tmp_ctx_scope" (${tempDdl}) ON COMMIT DROP`);
    for (const row of keep) {
      await client.query(
        `INSERT INTO "tmp_ctx_scope" VALUES (${row.map((_, i) => `$${i + 1}`).join(', ')})`, row);
    }
    const deleted = await scopedDelete(client, table, keyColumns, 'tmp_ctx_scope', sysA, scope, 'systemId', cols);
    await client.query('COMMIT');
    return deleted;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysA = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'ctx-scope-A') RETURNING "id"`)).rows[0].id;
  sysB = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'ctx-scope-B') RETURNING "id"`)).rows[0].id;
  await ctx(ID.aKept, 'synced', sysA);
  await ctx(ID.aGone, 'synced', sysA);
  await ctx(ID.bSynced, 'synced', sysB);
  await ctx(ID.unowned, 'synced', null);
  await ctx(ID.tag, 'manual', null);
  await member(ID.aKept, M(1), 'sync');      // in A's batch
  await member(ID.aKept, M(2), 'sync');      // A's, not in the batch: the one to go
  await member(ID.aKept, M(3), 'analyst');   // added by hand on A's context
  await member(ID.bSynced, M(4), 'sync');    // another system's
  await member(ID.unowned, M(5), 'sync');    // a context nobody owns
  await member(ID.tag, M(6), 'analyst');     // an analyst's tag
  await member(ID.tag, M(7), 'algorithm');   // a generated membership
});

afterAll(async () => {
  const ids = Object.values(ID);
  await pool?.query(`DELETE FROM "ContextMembers" WHERE "contextId" = ANY($1::uuid[])`, [ids]);
  await pool?.query(`DELETE FROM "Contexts" WHERE "id" = ANY($1::uuid[])`, [ids]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = ANY($1::int[])`, [[sysA, sysB]]);
  await pool?.end();
});

describe('full sync of ContextMembers from system A', () => {
  it('deletes only A\'s own sync membership that left the batch', async () => {
    const deleted = await reconcileFromA('ContextMembers', ['contextId', 'memberId'],
      '"contextId" uuid, "memberId" uuid', [[ID.aKept, M(1)]], {}, CM_COLS);
    expect(deleted).toBe(1);
    expect(await hasMember(ID.aKept, M(2))).toBe(false);
    expect(await hasMember(ID.aKept, M(1))).toBe(true);
  });

  it('leaves an analyst\'s membership on A\'s own context', async () => {
    expect(await hasMember(ID.aKept, M(3))).toBe(true);
  });

  it('leaves another system\'s, an unowned context\'s, an analyst tag\'s and a generated membership', async () => {
    expect(await hasMember(ID.bSynced, M(4))).toBe(true);
    expect(await hasMember(ID.unowned, M(5))).toBe(true);
    expect(await hasMember(ID.tag, M(6))).toBe(true);
    expect(await hasMember(ID.tag, M(7))).toBe(true);
  });
});

describe('full sync of Contexts from system A, scoped only by variant as crawlers send it', () => {
  it('deletes only A\'s own synced context that left the batch', async () => {
    const deleted = await reconcileFromA('Contexts', ['id'], '"id" uuid', [[ID.aKept]], { variant: 'synced' }, CTX_COLS);
    expect(deleted).toBe(1);
    expect(await hasContext(ID.aGone)).toBe(false);
    expect(await hasContext(ID.aKept)).toBe(true);
  });

  it('leaves another system\'s synced context, an unowned one and a manual one', async () => {
    expect(await hasContext(ID.bSynced)).toBe(true);
    expect(await hasContext(ID.unowned)).toBe(true);
    expect(await hasContext(ID.tag)).toBe(true);
  });
});
