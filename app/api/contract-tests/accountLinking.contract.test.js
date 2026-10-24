// Contract test — the account-linking run against a real PostgreSQL schema.
//
// The engine's unit tests mock db/connection.js and dispatch on SQL fragments,
// so they prove the write loop's decisions but say nothing about which rows the
// orphan queries actually select. This file runs the real runLinking against
// the contract database and asserts on the IdentityMembers rows and the
// orphansRemaining statistic it leaves behind.
//
// What it pins (#1442): a principal that a full sync has soft-deleted
// (reconcileStale stamps "deletedAt" instead of removing the row) is not a
// linking candidate, is not counted as a remaining orphan, and — the half the
// acceptance measurement showed matters most — is never attached to the live
// namesake it would otherwise match. A link made *before* the removal is kept.
//
// The database is shared with the other contract files, so the membership
// assertions are scoped to this file's own identities and the orphan count is
// asserted as a delta rather than an absolute.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const SYSTEM_NAME = 'contract-account-linking';
// Distinct enough that no other contract file's fixtures can match it.
const EMPLOYEE_ID = 'AL-CT-E123';

let pool;
let systemId;
let engine;

const ids = {
  identity: randomUUID(),
  live: randomUUID(),
  departed: randomUUID(),
  unmatched: randomUUID(),
  kept: randomUUID(),
};

// ── the namesake fixtures ────────────────────────────────────────────────────
//
// The acceptance measurement of #1442 found the inflated count was not the worst
// of it. Where linking first ran *after* a sync that had removed accounts, every
// removed account it attached went to a different, live person who shares the
// leaver's name — on the `fullName` signal alone (weight 60, over the default
// threshold of 50). The leaver has no Identity of their own (they are gone from
// the HR source too), so the namesake is the only candidate, no tie forms for the
// ambiguity guard to refuse, and a live person inherits a leaver's account and
// every grant on it. Two spellings of that, both taken from the measurement.
//
// Every name carries the `alct` tag: the contract database is shared, and a
// fixture that matched another file's person would make these tests pass for the
// wrong reason.
const NAMESAKES = [
  {
    // "Jordy van den Hurk" leaves; another Jordy van den Hurk stays.
    what: 'who is called the same thing',
    identity: {
      id: randomUUID(),
      displayName: 'van den Hurkalct, Jordy',
      email: 'jordy.hurkalct@al-ct.invalid',
    },
    account: {
      id: randomUUID(),
      displayName: 'van den Hurkalct, Jordy (left the company)',
      email: 'j.hurkalct.departed@al-ct.invalid',
    },
  },
  {
    // "Sabine Schmidt" leaves; "Sabine Schmidt-Richter" — whose HR surname
    // column still reads Schmidt — stays. nameVariants indexes that person
    // under the birth surname as well as the name in use, so the leaver's
    // account matches them at full-name strength.
    what: 'whose record still holds the leaver’s surname',
    identity: {
      id: randomUUID(),
      displayName: 'Schmidtalct-Richter, Sabine',
      givenName: 'Sabine',
      surname: 'Schmidtalct',
      email: 'sabine.schmidtalct.richter@al-ct.invalid',
    },
    account: {
      id: randomUUID(),
      displayName: 'Schmidtalct, Sabine',
      email: 's.schmidtalct.departed@al-ct.invalid',
    },
  },
];

/** Every identity this file seeds — deleting one cascades its IdentityMembers. */
const IDENTITY_IDS = [ids.identity, ...NAMESAKES.map(n => n.identity.id)];

beforeAll(async () => {
  // db/connection.js builds its pool lazily from DATABASE_URL, so this has to
  // be set before the engine issues its first query.
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  // The run ends by enqueueing the orphaned-accounts context plugin. That is a
  // fire-and-forget background job against the shared database and is not what
  // this file is testing — stub it, as the engine unit tests do.
  vi.doMock('../src/contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => {}) }));
  engine = await import('../src/accountlinking/engine.js');

  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME],
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "AccountLinkingRuns" WHERE "triggeredBy" = 'contract-test'`);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [IDENTITY_IDS]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  vi.doUnmock('../src/contexts/plugins/runner.js');
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [IDENTITY_IDS]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
});

function insertPrincipal(id, displayName, { employeeId = null, email = null, givenName = null, surname = null } = {}) {
  return pool.query(
    `INSERT INTO "Principals"
       ("id", "systemId", "displayName", "email", "employeeId", "givenName", "surname",
        "principalType", "extendedAttributes")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'User', '{}'::jsonb)`,
    [id, systemId, displayName, email, employeeId, givenName, surname],
  );
}

function insertIdentity(id, displayName, { employeeId = null, email = null, givenName = null, surname = null } = {}) {
  return pool.query(
    `INSERT INTO "Identities" ("id", "displayName", "email", "employeeId", "givenName", "surname")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, displayName, email, employeeId, givenName, surname],
  );
}

/** What a full-sync reconcile does to a principal missing from the source. */
function softDelete(id) {
  return pool.query(`UPDATE "Principals" SET "deletedAt" = now() WHERE "id" = $1`, [id]);
}

/** Run linking to completion and return the finished AccountLinkingRuns row. */
async function runLinking() {
  const run = await engine.startAccountLinkingRun('contract-test', { awaitCompletion: true });
  const r = await pool.query(`SELECT * FROM "AccountLinkingRuns" WHERE "id" = $1`, [run.id]);
  return r.rows[0];
}

/** The accounts attached to one of this file's identities, with how they scored. */
async function membersOf(identityId) {
  const r = await pool.query(
    `SELECT "principalId", "linkConfidence", "linkSignals"
       FROM "IdentityMembers" WHERE "identityId" = $1 ORDER BY "principalId"`, [identityId]);
  return r.rows;
}

const memberIdsOf = async (identityId) => (await membersOf(identityId)).map(row => row.principalId);

describe('runLinking — soft-deleted principals', () => {
  it('links the live account but never a soft-deleted one that matches just as strongly', async () => {
    // Both accounts carry the identity's employeeId — an exact signal at weight
    // 95, well over the default linkThreshold of 50 — and both classify as
    // Secondary, so the only thing separating them is the deletedAt stamp.
    await insertIdentity(ids.identity, 'Robin Euson', { employeeId: EMPLOYEE_ID });
    await insertPrincipal(ids.live, 'Euson, Robin', { employeeId: EMPLOYEE_ID });
    await insertPrincipal(ids.departed, 'Euson, Robin (old tenant)', { employeeId: EMPLOYEE_ID });
    await softDelete(ids.departed);

    expect((await runLinking()).status).toBe('completed');

    // Control and regression in one assertion: the live twin must link (so a
    // change that simply stopped linking would also go red), the departed twin
    // must not.
    expect(await memberIdsOf(ids.identity)).toEqual([ids.live]);
  });

  it('does not count a soft-deleted account in orphansRemaining', async () => {
    // Baseline first, with none of our principals present; then add a single
    // soft-deleted account that matches no identity. The count is global to the
    // shared database, so assert the delta.
    const before = (await runLinking()).orphansRemaining;

    await insertPrincipal(ids.unmatched, 'Ghost Account', { employeeId: 'AL-CT-E999' });
    await softDelete(ids.unmatched);

    expect((await runLinking()).orphansRemaining).toBe(before);
  });

  it('keeps a link made before the account was removed', async () => {
    // The other half of the decision, and the one a tenant sees on every sync
    // after the first: removal must not detach a person's history. Link the
    // account while it is live, then remove it and link again.
    await insertIdentity(ids.identity, 'Robin Euson', { employeeId: EMPLOYEE_ID });
    await insertPrincipal(ids.kept, 'Euson, Robin', { employeeId: EMPLOYEE_ID });

    await runLinking();
    const [linked] = await membersOf(ids.identity);
    expect(linked?.principalId).toBe(ids.kept);

    await softDelete(ids.kept);
    await runLinking();

    // Untouched, not re-scored: the second run never considered the account at
    // all, so the row the analyst reviews still says exactly what it said.
    expect(await membersOf(ids.identity)).toEqual([linked]);
  });
});

describe.each(NAMESAKES)('runLinking — a removed account and the live person $what', (fx) => {
  const seed = () => Promise.all([
    insertIdentity(fx.identity.id, fx.identity.displayName, fx.identity),
    insertPrincipal(fx.account.id, fx.account.displayName, fx.account),
  ]);

  it('attaches the account to them while it is live, on the shared name alone', async () => {
    // The control, and a reproduction of what the base build did: nothing but
    // the name connects these two people, and that is enough to link. Without
    // it the regression below would pass against a fixture that never matched.
    await seed();

    await runLinking();

    const [member] = await membersOf(fx.identity.id);
    expect(member?.principalId).toBe(fx.account.id);
    expect(member?.linkConfidence).toBe(60);  // fullName's weight, and nothing else
    expect(member?.linkSignals).toBe('fullName');
  });

  it('never attaches it once a sync has removed it', async () => {
    // Same two rows, same rules, one difference: the sync that removed the
    // leaver's account ran before linking did. The live namesake must not
    // inherit it — a wrong person's account, not merely a wrong count.
    await seed();
    await softDelete(fx.account.id);

    expect((await runLinking()).status).toBe('completed');

    expect(await memberIdsOf(fx.identity.id)).toEqual([]);
  });
});
