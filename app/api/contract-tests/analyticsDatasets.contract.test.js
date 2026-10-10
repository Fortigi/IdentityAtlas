// Contract test — the analytics datasets against real PostgreSQL, end to end
// through the HTTP routes (create profile → read dataset).
//
// Each scenario is seeded so a plausible-but-wrong implementation gives a
// DIFFERENT number:
//   * joint vs marginal — two account populations with identical marginal
//     totals but opposite joint distributions; only a true joint GROUP BY tells
//     them apart;
//   * an identity with three accounts counts once as an identity, three times as
//     accounts — and an account in two identities is bucketed, not duplicated;
//   * tombstoned accounts/assignments, group principals and business-role rows
//     must not count;
//   * history: an attribute change, a soft delete and a system loaded later
//     each move a different month.
// Expected values are derived by hand from the seed AND cross-checked with
// independent SQL written without the analytics helpers.
//
// The database is shared with the other contract files, so every profile is
// scoped to this file's own systems.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let pool;
let agent;
const sys = {};
const P = {};       // principal ids
const I = {};       // identity ids
const R = {};       // resource ids

const BASE = '/api/analytics/v1';

async function system(key, name) {
  const r = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('analytics-contract', $1) RETURNING "id"`, [name]);
  sys[key] = r.rows[0].id;
}

async function principal(key, systemKey, { enabled = true, dept = null, type = 'User', ext = {}, deleted = false } = {}) {
  P[key] = randomUUID();
  await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","principalType","accountEnabled","department","extendedAttributes","deletedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [P[key], sys[systemKey], `an-${key}`, type, enabled, dept, JSON.stringify(ext), deleted ? new Date() : null]);
}

async function identity(key, dept) {
  I[key] = randomUUID();
  await pool.query(`INSERT INTO "Identities" ("id","displayName","department") VALUES ($1,$2,$3)`, [I[key], `id-${key}`, dept]);
}

const link = (identityKey, principalKey) => pool.query(
  `INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2)`, [I[identityKey], P[principalKey]]);

async function resource(key, type, { governance = false } = {}) {
  R[key] = randomUUID();
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","governanceResource") VALUES ($1,$2,$3,$4,$5)`,
    [R[key], sys.gov, `res-${key}`, type, governance]);
}

const assign = (rKey, pKey, { governed = false, deleted = false } = {}) => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","governed","systemId","deletedAt")
   VALUES ($1,$2,'Direct',$3,$4,$5)`, [R[rKey], P[pKey], governed, sys.gov, deleted ? new Date() : null]);

async function createProfile(name, systems, dimensions, datasets, minGroupSize = 1) {
  const res = await agent.post(`${BASE}/profiles`).send({
    name,
    definition: {
      scope: { systemIds: systems.map(k => sys[k]) },
      dimensions: dimensions.map(field => ({ field })),
      datasets,
      privacy: { minGroupSize },
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const dataset = async (profile, id) => {
  const res = await agent.get(`${BASE}/profiles/${profile.id}/datasets/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

// rows → { "v1|v2": measure } for order-independent comparison.
const cells = (rows, dims, measure) =>
  Object.fromEntries(rows.map(r => [dims.map(d => r[d]).join('|'), r[measure]]));

beforeAll(async () => {
  process.env.FEATURE_ANALYTICS = 'true';
  ({ pool, agent } = await bootContractApp());
  const tag = randomUUID().slice(0, 8);
  for (const k of ['joint', 'mirror', 'people', 'gov', 'hist', 'late', 'wide', 'empty']) await system(k, `analytics-${k}-${tag}`);

  // Joint vs marginal: identical marginals, opposite joints.
  //   joint:  (enabled, Sales) ×2, (disabled, Finance) ×2
  //   mirror: (enabled, Finance) ×2, (disabled, Sales) ×2
  await principal('j1', 'joint', { enabled: true, dept: 'Sales' });
  await principal('j2', 'joint', { enabled: true, dept: 'Sales' });
  await principal('j3', 'joint', { enabled: false, dept: 'Finance' });
  await principal('j4', 'joint', { enabled: false, dept: 'Finance' });
  await principal('m1', 'mirror', { enabled: true, dept: 'Finance' });
  await principal('m2', 'mirror', { enabled: true, dept: 'Finance' });
  await principal('m3', 'mirror', { enabled: false, dept: 'Sales' });
  await principal('m4', 'mirror', { enabled: false, dept: 'Sales' });

  // People: identities with several accounts, unlinked, ambiguous, deleted, group, unknown.
  await identity('alice', 'Finance');
  await identity('bob', 'Sales');
  await identity('ghost', 'Legal');                      // only a tombstoned account
  await principal('a1', 'people', { enabled: true, dept: 'Fin', ext: { workerKind: 'internal' } });
  await principal('a2', 'people', { enabled: true, dept: '   ', ext: { workerKind: 'internal' } });   // blank → unknown
  await principal('a3', 'people', { enabled: false, dept: null, ext: { workerKind: 'external' } });   // null → unknown
  await principal('b1', 'people', { enabled: true, dept: 'Sal', ext: { workerKind: 'external' } });
  await principal('u1', 'people', { enabled: true, dept: 'Ops' });                                    // no identity
  await principal('x1', 'people', { enabled: true, dept: 'Ops' });                                    // two identities
  await principal('d1', 'people', { enabled: true, dept: 'Legal', deleted: true });                   // tombstoned
  await principal('g1', 'people', { type: '#microsoft.graph.group', dept: 'Ops' });                   // group principal
  for (const p of ['a1', 'a2', 'a3']) await link('alice', p);
  await link('bob', 'b1');
  await link('alice', 'x1');
  await link('bob', 'x1');
  await link('ghost', 'd1');

  // Governance: BR contains R1; ann holds BR and R1 (governed), R2 (not);
  // ben holds R1 (not governed) and a tombstoned R2.
  await principal('ann', 'gov', { dept: 'Finance' });
  await principal('ben', 'gov', { dept: 'Sales' });
  await resource('br', 'BusinessRole', { governance: true });
  await resource('r1', 'Group');
  await resource('r2', 'Group');
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId") VALUES ($1,$2,'Contains',$3)`,
    [R.br, R.r1, sys.gov]);
  await assign('br', 'ann', { governed: true });
  await assign('r1', 'ann');
  await assign('r2', 'ann');
  await assign('r1', 'ben');
  await assign('r2', 'ben', { deleted: true });
  await pool.query('REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"');
  await pool.query('REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"');

  // Wide: 201 distinct values of one attribute — not a category.
  await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","principalType","extendedAttributes")
     SELECT gen_random_uuid(), $1, 'wide-' || g, 'User', jsonb_build_object('ticketNo', 'T' || g)
       FROM generate_series(1, 201) g`, [sys.wide]);
});

afterAll(async () => {
  delete process.env.FEATURE_ANALYTICS;
  delete process.env.USE_SQL;
  await pool?.end?.();
});

describe('principals.count — joint, not marginal', () => {
  it('keeps the joint distribution that two populations with equal marginals do not share', async () => {
    const dims = ['Principal.accountEnabled', 'Principal.department'];
    const datasets = [
      { id: 'joint', metric: 'principals.count', dimensions: dims },
      { id: 'by-enabled', metric: 'principals.count', dimensions: ['Principal.accountEnabled'] },
      { id: 'by-dept', metric: 'principals.count', dimensions: ['Principal.department'] },
    ];
    const a = await createProfile(`joint-${randomUUID()}`, ['joint'], dims, datasets);
    const b = await createProfile(`mirror-${randomUUID()}`, ['mirror'], dims, datasets);

    // The marginals are identical...
    for (const id of ['by-enabled', 'by-dept']) {
      const ma = (await dataset(a, id)).rows;
      const mb = (await dataset(b, id)).rows;
      expect(ma).toEqual(mb);
    }
    // ...so no marginal table can tell these apart. The joint can:
    expect(cells((await dataset(a, 'joint')).rows, dims, 'accounts')).toEqual({ 'true|Sales': 2, 'false|Finance': 2 });
    expect(cells((await dataset(b, 'joint')).rows, dims, 'accounts')).toEqual({ 'true|Finance': 2, 'false|Sales': 2 });
  });
});

describe('principals.count / identities.count — accounts vs persons', () => {
  let profile;
  beforeAll(async () => {
    profile = await createProfile(`people-${randomUUID()}`, ['people'],
      ['Identity.department', 'Principal.department', 'Principal.ext.workerKind'],
      [
        { id: 'accounts-by-person-dept', metric: 'principals.count', dimensions: ['Identity.department'] },
        { id: 'accounts-by-account-dept', metric: 'principals.count', dimensions: ['Principal.department', 'Principal.ext.workerKind'] },
        { id: 'persons', metric: 'identities.count', dimensions: ['Identity.department'] },
      ]);
  });

  it('counts each live account once, bucketing unlinked and ambiguous accounts', async () => {
    const out = await dataset(profile, 'accounts-by-person-dept');
    expect(cells(out.rows, ['Identity.department'], 'accounts')).toEqual({
      Finance: 3,                      // a1, a2, a3 — not d1 (tombstoned), not x1 (ambiguous)
      Sales: 1,                        // b1
      '(not linked)': 1,               // u1
      '(multiple identities)': 1,      // x1, once — not once per identity
    });
    // Independent check: live, non-group accounts of the system.
    const total = (await pool.query(
      `SELECT count(*)::int AS n FROM "Principals"
        WHERE "systemId" = $1 AND "deletedAt" IS NULL AND "principalType" <> '#microsoft.graph.group'`,
      [sys.people])).rows[0].n;
    expect(out.rows.reduce((s, r) => s + r.accounts, 0)).toBe(total);
  });

  it('puts blank and missing values in the unknown bucket and reads discovered attributes', async () => {
    const out = await dataset(profile, 'accounts-by-account-dept');
    expect(cells(out.rows, ['Principal.department', 'Principal.ext.workerKind'], 'accounts')).toEqual({
      'Fin|internal': 1, '(unknown)|internal': 1, '(unknown)|external': 1, 'Sal|external': 1, 'Ops|(unknown)': 2,
    });
  });

  it('counts an identity once however many accounts it has, and reports identities with none live', async () => {
    const out = await dataset(profile, 'persons');
    expect(cells(out.rows, ['Identity.department'], 'identities')).toEqual({ Finance: 1, Sales: 1 });
    expect(out.excluded).toEqual({ identitiesWithoutLiveAccount: 1 });   // ghost
  });
});

describe('assignments.governedShare', () => {
  it('reports numerator, denominator and exclusions, matching an independent count', async () => {
    const profile = await createProfile(`gov-${randomUUID()}`, ['gov'], ['Principal.department'],
      [{ id: 'gov', metric: 'assignments.governedShare', dimensions: ['Principal.department'] }]);
    const out = await dataset(profile, 'gov');
    const byDept = Object.fromEntries(out.rows.map(r => [r['Principal.department'], r]));
    expect(byDept.Finance).toMatchObject({ pairs: 2, governedPairs: 1, ungovernedPairs: 1, unknownPairs: 0, governedShare: 0.5, holders: 1 });
    expect(byDept.Sales).toMatchObject({ pairs: 1, governedPairs: 0, governedShare: 0, holders: 1 });   // tombstoned r2 not counted
    expect(out.excluded).toEqual({ hiddenResourceTypePairs: 1, groupHolderPairs: 0 });               // ann's business-role row

    // Independent: live non-BusinessRole assignments of the system's accounts.
    const raw = (await pool.query(
      `SELECT count(DISTINCT (ra."principalId", ra."resourceId"))::int AS n
         FROM "ResourceAssignments" ra JOIN "Resources" r ON r.id = ra."resourceId"
         JOIN "Principals" p ON p.id = ra."principalId"
        WHERE p."systemId" = $1 AND ra."deletedAt" IS NULL AND r."resourceType" <> 'BusinessRole'`,
      [sys.gov])).rows[0].n;
    expect(out.rows.reduce((s, r) => s + r.pairs, 0)).toBe(raw);
  });
});

describe('suppression, cardinality, empty scope', () => {
  it('withholds the measures of cells smaller than the minimum group size', async () => {
    const dims = ['Principal.accountEnabled', 'Principal.department'];
    const profile = await createProfile(`supp-${randomUUID()}`, ['joint', 'mirror'], dims,
      [{ id: 'joint', metric: 'principals.count', dimensions: dims }], 3);
    const out = await dataset(profile, 'joint');
    // Four cells of 2 each: every one is below 3.
    expect(out.rows).toHaveLength(4);
    expect(out.rows.every(r => r.suppressed === true && r.accounts === null)).toBe(true);
    expect(out.suppression).toEqual({ minGroupSize: 3, suppressedCells: 4 });
  });

  it('refuses a dimension with more distinct values than a category can have', async () => {
    const res = await agent.post(`${BASE}/profiles/validate`).send({
      name: 'wide',
      definition: {
        scope: { systemIds: [sys.wide] },
        dimensions: [{ field: 'Principal.ext.ticketNo' }],
        datasets: [{ id: 'w', metric: 'principals.count', dimensions: ['Principal.ext.ticketNo'] }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.details.errors.map(e => e.code)).toEqual(['high_cardinality']);
  });

  it('returns no rows — not a zero row — for a scope with no data', async () => {
    const profile = await createProfile(`empty-${randomUUID()}`, ['empty'], ['Principal.accountEnabled'], [
      { id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled'] },
      // No dimensions: an ungrouped COUNT(*) yields one row of 0 unless the query refuses it.
      { id: 'total', metric: 'principals.count', dimensions: [] },
      { id: 'persons', metric: 'identities.count', dimensions: [] },
      { id: 'g', metric: 'assignments.governedShare', dimensions: [] },
    ]);
    for (const id of ['a', 'total', 'persons', 'g']) {
      const out = await dataset(profile, id);
      expect(out.rows).toEqual([]);
      expect(out.rowCount).toBe(0);
    }
  });
});

describe('principals.countAsOf — reconstructed from the audit log', () => {
  const monthStart = (back) => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, 1));
  };
  const plusDays = (d, days) => new Date(d.getTime() + days * 86400000);
  const ym = d => d.toISOString().slice(0, 7);
  const backdate = (rowId, op, at) => pool.query(
    `UPDATE "_history" SET "changedAt" = $3 WHERE "tableName" = 'Principals' AND "rowId" = $1 AND "operation" = $2`,
    [rowId, op, at]);

  it('moves each month by the change that happened in it, and never estimates before history', async () => {
    // p1: created in M-3 as Old, renamed to New in M-1.
    await principal('h1', 'hist', { dept: 'Old' });
    await backdate(P.h1, 'I', plusDays(monthStart(3), 1));
    await pool.query(`UPDATE "Principals" SET "department" = 'New' WHERE id = $1`, [P.h1]);
    await backdate(P.h1, 'U', plusDays(monthStart(1), 1));
    // p2: created in M-2, soft-deleted in M-1.
    await principal('h2', 'hist', { dept: 'Gone' });
    await backdate(P.h2, 'I', plusDays(monthStart(2), 1));
    await pool.query(`UPDATE "Principals" SET "deletedAt" = now() WHERE id = $1`, [P.h2]);
    await backdate(P.h2, 'U', plusDays(monthStart(1), 2));
    // p3: arrives with its system's initial load in M-1 (no per-row insert event).
    await principal('h3', 'late', { dept: 'Late' });
    await pool.query(`DELETE FROM "_history" WHERE "tableName" = 'Principals' AND "rowId" = $1`, [P.h3]);
    await pool.query(
      `INSERT INTO "_history" ("tableName","rowId","operation","changedAt","rowData","prevData")
       VALUES ('Principals', $1, 'I', $2, jsonb_build_object('initialLoad', true, 'systemId', $3::int), NULL)`,
      [`initial-load:${sys.late}`, plusDays(monthStart(1), 3), sys.late]);
    // A group principal created now: a container, never an account, in any month.
    await principal('hg', 'hist', { type: '#microsoft.graph.group', dept: 'New' });

    const profile = await createProfile(`hist-${randomUUID()}`, ['hist', 'late'], ['Principal.department'],
      [{ id: 'trend', metric: 'principals.countAsOf', dimensions: ['Principal.department'], periods: 5 }]);
    const out = await dataset(profile, 'trend');

    const at = period => Object.fromEntries(out.rows.filter(r => r.period === period).map(r => [r['Principal.department'], r.accounts]));
    expect(at(ym(monthStart(3)))).toEqual({ Old: 1 });
    expect(at(ym(monthStart(2)))).toEqual({ Old: 1, Gone: 1 });          // 'late' not loaded yet
    expect(at(ym(monthStart(1)))).toEqual({ New: 1, Late: 1 });          // Gone tombstoned, Old renamed
    expect(at(ym(monthStart(0)))).toEqual({ New: 1, Late: 1 });
    expect(out.rows.filter(r => r.period === ym(monthStart(0))).every(r => r.historyMethod === 'current' && r.periodComplete === false)).toBe(true);
    expect(out.rows.filter(r => r.period === ym(monthStart(3))).every(r => r.historyMethod === 'reconstructed')).toBe(true);

    // M-4 ends before the oldest retained Principals event (unless another file
    // seeded older history): it is unavailable, not zero.
    const start = (await pool.query(`SELECT MIN("changedAt") AS s FROM "_history" WHERE "tableName" = 'Principals'`)).rows[0].s;
    expect(out.coverage.historyStart).toBe(new Date(start).toISOString());
    const m4End = new Date(monthStart(3).getTime() - 1);
    const m4Available = m4End >= new Date(start);
    expect(out.coverage.unavailablePeriods.includes(ym(monthStart(4)))).toBe(!m4Available);
    if (!m4Available) expect(at(ym(monthStart(4)))).toEqual({});
  });
});
