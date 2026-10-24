// HTTP integration test — importing the same data twice changes nothing.
//
// The ordinary life of a crawler is to run again over data that has mostly not
// changed. Two defects made every such re-run corrupt the database while
// reporting success, and both only show on real PostgreSQL:
//
//   1. Systems were upserted on UNIQUE (systemType, tenantId). A CSV system has
//      no tenant, NULLs never conflict, so each run registered every system again
//      and re-homed all of its principals, resources and assignments onto the new
//      ids — a real change, so a history row with two snapshots per row. On the
//      scale rig: 42 systems became 84, "_history" went from 4.1 GB to 10 GB.
//   2. A business-role membership arrives ungoverned and classify flips it.
//      governed is part of the assignment key, so the next import inserted an
//      ungoverned copy beside the flipped row, and classify then collided with
//      it: HTTP 500 on every later run.
//
// This drives the real ingest endpoints the way the CSV crawler does, twice over
// identical input, and asserts the second run left everything as it was —
// including that the audit history did not grow, the assertion that catches
// both defects at once.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let key;
let crawlerId;
const run = crypto.randomBytes(4).toString('hex');
const TYPE = `Rerun-${run}`;
const PREFIX = `rerun${run}`;

async function createCrawler() {
  const apiKey = `fgc_${crypto.randomBytes(24).toString('hex')}`;
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
  const r = await pool.query(
    `INSERT INTO "Crawlers" ("displayName", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "systemIds", "permissions", "rateLimit")
     VALUES ($1, $2, $3, $4, NULL, $5::jsonb, 10000) RETURNING id`,
    [`rerun-${run}`, hash, salt, apiKey.slice(0, 8), JSON.stringify(['ingest', 'refreshViews'])]);
  crawlerId = r.rows[0].id;
  return apiKey;
}

async function post(path, body) {
  const res = await agent.post(`/api/ingest/${path}`).set('Authorization', `Bearer ${key}`).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

const deterministic = (entity, systemId, records, extra = {}) => ({
  systemId, syncMode: 'full', idGeneration: 'deterministic', idPrefix: `${PREFIX}-${entity}`, records, ...extra,
});

// One run of a CSV-style crawler: two tenant-less systems (like Systems.csv) plus
// its fallback system, then principals, resources — one of them a business
// role — assignments, and classification.
async function importOnce() {
  const sys = await post('systems', {
    syncMode: 'delta',
    records: [
      { systemType: TYPE, displayName: 'Fallback', enabled: true, syncEnabled: true },
      { systemType: TYPE, displayName: 'HR', externalId: 'hr', enabled: true, syncEnabled: true },
      { systemType: TYPE, displayName: 'Finance', externalId: 'fin', enabled: true, syncEnabled: true },
    ],
  });
  const [, hr] = sys.systemIds;
  await post('principals', deterministic('principals', hr, [
    { externalId: 'u1', displayName: 'User One', principalType: 'User' },
    { externalId: 'u2', displayName: 'User Two', principalType: 'User' },
  ]));
  await post('resources', deterministic('resources', hr, [
    { externalId: 'g1', displayName: 'Group One', resourceType: 'Group' },
    { externalId: 'br1', displayName: 'Role One', resourceType: 'BusinessRole' },
  ]));
  await post('resource-assignments', deterministic('resource-assignments', hr, [
    { resourceExternalId: 'g1', principalExternalId: 'u1', assignmentType: 'Direct' },
    { resourceExternalId: 'br1', principalExternalId: 'u1', assignmentType: 'Direct' },
    { resourceExternalId: 'br1', principalExternalId: 'u2', assignmentType: 'Direct' },
  ], { scope: { assignmentType: 'Direct' } }));
  const classify = await post('classify-business-role-assignments', {});
  return { systemIds: sys.systemIds, hr, classify };
}

async function snapshot(hr) {
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  return {
    systems: await q(`SELECT id, "displayName" FROM "Systems" WHERE "systemType" = $1 ORDER BY id`, [TYPE]),
    principals: await q(`SELECT id, "systemId" FROM "Principals" WHERE "systemId" IN (SELECT id FROM "Systems" WHERE "systemType" = $1) ORDER BY id`, [TYPE]),
    resources: await q(`SELECT id, "systemId", "governanceResource" FROM "Resources" WHERE "systemId" IN (SELECT id FROM "Systems" WHERE "systemType" = $1) ORDER BY id`, [TYPE]),
    assignments: await q(
      `SELECT "resourceId", "principalId", "assignmentType", "governed", "systemId", "extendedAttributes"
         FROM "ResourceAssignments" WHERE "systemId" = $1
        ORDER BY "resourceId", "principalId", "governed"`, [hr]),
    history: Number((await q(`SELECT count(*) AS n FROM "_history"`))[0].n),
  };
}

let first;
let second;
let afterFirst;
let afterSecond;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  key = await createCrawler();
  const before = Number((await pool.query(`SELECT count(*) AS n FROM "_history"`)).rows[0].n);
  first = await importOnce();
  afterFirst = await snapshot(first.hr);
  afterFirst.historyWritten = afterFirst.history - before;
  second = await importOnce();
  afterSecond = await snapshot(first.hr);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM "Systems" WHERE "systemType" = $1`, [TYPE]);
    await pool.query(`DELETE FROM "CrawlerAuditLog" WHERE "crawlerId" = $1`, [crawlerId]).catch(() => {});
    await pool.query(`DELETE FROM "Crawlers" WHERE id = $1`, [crawlerId]);
    await pool.end();
  }
  delete process.env.USE_SQL;
});

describe('a crawler run twice over identical input', () => {
  it('the first run did write data and history (so the checks below are not vacuous)', () => {
    expect(afterFirst.systems).toHaveLength(3);
    expect(afterFirst.principals).toHaveLength(2);
    expect(afterFirst.assignments).toHaveLength(3);
    expect(afterFirst.historyWritten).toBeGreaterThan(0);
  });

  it('keeps the same systems, with the same ids', () => {
    expect(second.systemIds).toEqual(first.systemIds);
    expect(afterSecond.systems).toEqual(afterFirst.systems);
  });

  it('leaves every principal, resource and assignment in its system', () => {
    expect(afterSecond.principals).toEqual(afterFirst.principals);
    expect(afterSecond.resources).toEqual(afterFirst.resources);
    expect(afterSecond.assignments.map(a => a.systemId)).toEqual(afterFirst.assignments.map(a => a.systemId));
  });

  it('holds each business-role membership once, governed — no ungoverned copy beside it', () => {
    const br = afterFirst.resources.find(r => r.governanceResource).id;
    const memberships = afterSecond.assignments.filter(a => a.resourceId === br);
    expect(memberships).toHaveLength(2);
    expect(memberships.every(a => a.governed)).toBe(true);
    expect(afterSecond.assignments).toEqual(afterFirst.assignments);
  });

  it('marks the memberships governed at ingest, so classification has nothing left to do', () => {
    expect(first.classify).toMatchObject({ ok: true, governedMarked: 0, ungovernedCopiesRemoved: 0 });
    expect(second.classify).toMatchObject({ ok: true, governedMarked: 0, ungovernedCopiesRemoved: 0 });
  });

  it('writes no audit history the second time', () => {
    expect(afterSecond.history - afterFirst.history).toBe(0);
  });

  it('stores no copy of the resolved external ids in extendedAttributes', () => {
    expect(afterFirst.assignments.every(a => a.extendedAttributes === null)).toBe(true);
  });
});

describe('an installation that already holds a governed membership and its ungoverned copy', () => {
  it('classify removes the copy instead of colliding with the governed row', async () => {
    const br = afterSecond.resources.find(r => r.governanceResource).id;
    const u1 = afterSecond.principals[0].id;
    // What a pre-fix re-import left behind: the ungoverned twin of a governed row.
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "governed", "systemId")
       VALUES ($1, $2, 'Direct', false, $3)`, [br, u1, first.hr]);
    const res = await post('classify-business-role-assignments', { systemId: first.hr });
    expect(res.ungovernedCopiesRemoved).toBe(1);
    const { rows } = await pool.query(
      `SELECT "governed" FROM "ResourceAssignments" WHERE "resourceId" = $1 AND "principalId" = $2`, [br, u1]);
    expect(rows).toEqual([{ governed: true }]);
  });
});
