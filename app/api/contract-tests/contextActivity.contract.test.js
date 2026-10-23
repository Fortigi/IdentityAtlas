// Contract test — an activity upload end to end against real PostgreSQL:
// analyze → apply on the ROOT of a tree → read per unit and per child →
// re-upload of an overlapping period → undo → cascades. What only PostgreSQL can tell:
//   - the unnest() insert lands every row on the sub-unit it named, with the
//     matched account and person (date, numeric amount and jsonb attributes intact);
//   - the replace step deletes exactly the earlier rows of the same source whose
//     date falls in the new file's period — rows before it stay, nothing is doubled;
//   - the aggregate read (GROUP BY on lower(subjectEmail) and a CASE on the name)
//     and the recursive descendants query are valid and give the four groups and
//     the per-child table;
//   - undo removes one upload's rows only; deleting a context removes its rows;
//     deleting an account leaves the row with principalId NULL.
//
// Isolation on the shared contract DB: one system, a tree of fresh contexts and
// accounts with a random suffix; everything is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const db = await import('../src/db/connection.js');
const { analyzeActivity, previewActivity, applyActivity } = await import('../src/contexts/activity/service.js');
const { contextActivity, activitySummary } = await import('../src/contexts/activity/view.js');
const { listUploads, deleteUpload } = await import('../src/contexts/activity/store.js');

const SUFFIX = randomUUID().slice(0, 8);
const ROOT = randomUUID();
const NORTH = randomUUID();
const CONTOSO = randomUUID();
const P = {};
const I = {};
let pool;
let systemId;
let uploadRoot;

const HEAD = 'Project;Client;Description;Task;User;Email;Tags;Billable;Start Date;Start Time;End Date;End Time;Duration (h);Duration (decimal)';
const row = (client, user, email, date, hours) => `Platform;${client};Work;Build;${user};${email};;Yes;${date};09:00;${date};10:00;01:00:00;${hours}`;
const NORTH_NAME = `Northwind Traders ${SUFFIX}`;
const CONTOSO_NAME = `Contoso Bakery ${SUFFIX}`;
const vera = () => [`Vera Example ${SUFFIX}`, `vera-${SUFFIX}@example.org`];
const tom = () => [`Tom Sample ${SUFFIX}`, ''];

// Jan–Mar 2026: 5 rows, one of them on a client that is no sub-unit.
const FIRST = Buffer.from([
  HEAD,
  row(NORTH_NAME, ...vera(), '01/15/2026', '2.00'),
  row(NORTH_NAME, ...vera(), '02/14/2026', '1.50'),
  row(NORTH_NAME, ...tom(), '03/13/2026', '4.00'),
  row(CONTOSO_NAME, `Ghost Person ${SUFFIX}`, '', '03/20/2026', '0.50'),
  row(`Unknown Ltd ${SUFFIX}`, ...vera(), '03/21/2026', '9.00'),
].join('\n'));
// Feb–Apr 2026: overlaps the first file from Feb on.
const SECOND = Buffer.from([
  HEAD,
  row(NORTH_NAME, ...vera(), '02/14/2026', '1.50'),
  row(CONTOSO_NAME, ...vera(), '04/18/2026', '3.00'),
].join('\n'));

async function upload(buffer, fileName) {
  const a = await analyzeActivity({ buffer, fileName, uploadedBy: 'contract@example.org', contextId: ROOT }, { db });
  return { a, out: await applyActivity({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, ROOT, 'contract@example.org', { db }) };
}

async function rowsOf(contextIds) {
  return (await pool.query(`
    SELECT "contextId", "principalId", "identityId", "subjectName", to_char("activityDate", 'YYYY-MM-DD') AS d, amount::float8 AS amount, unit, kind, attributes
      FROM "ContextActivity" WHERE "contextId" = ANY($1::uuid[]) ORDER BY "activityDate", amount`, [contextIds])).rows;
}

beforeAll(async () => {
  uploadRoot = await mkdtemp(join(tmpdir(), 'ctx-activity-contract-'));
  process.env.UPLOAD_ROOT = uploadRoot;
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ('EntraID', $1, $1) RETURNING id`, [`act-${SUFFIX}`])).rows[0].id;
  for (const [key, [name, email]] of Object.entries({ vera: vera(), tom: tom() })) {
    P[key] = (await pool.query(
      `INSERT INTO "Principals" (id, "systemId", "displayName", email, "principalType") VALUES (gen_random_uuid(), $1, $2, NULLIF($3, ''), 'User') RETURNING id`,
      [systemId, name, email])).rows[0].id;
  }
  I.vera = (await pool.query(`INSERT INTO "Identities" (id, "displayName", email) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, vera())).rows[0].id;
  I.kim = (await pool.query(`INSERT INTO "Identities" (id, "displayName") VALUES (gen_random_uuid(), $1) RETURNING id`, [`Kim Idle ${SUFFIX}`])).rows[0].id;
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`, [I.vera, P.vera]);
  const ctx = `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "parentContextId", "externalId")
               VALUES ($1, 'manual', 'Identity', 'OrgUnit', 'OrganizationalUnit', $2, $3, $4)`;
  await pool.query(ctx, [ROOT, `Customers ${SUFFIX}`, null, null]);
  await pool.query(ctx, [NORTH, NORTH_NAME, ROOT, `K1-${SUFFIX}`]);
  await pool.query(ctx, [CONTOSO, CONTOSO_NAME, ROOT, `K2-${SUFFIX}`]);
  // Vera and Kim are members of Northwind; nobody of Contoso.
  for (const id of [I.vera, I.kim]) {
    await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, 'Identity', $2, 'analyst')`, [NORTH, id]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])', [[NORTH, CONTOSO, ROOT]]);
  await pool.query('DELETE FROM "Identities" WHERE id = ANY($1::uuid[])', [Object.values(I)]);
  await pool.query('DELETE FROM "Principals" WHERE "systemId" = $1', [systemId]);
  await pool.query('DELETE FROM "Systems" WHERE id = $1', [systemId]);
  await pool.end();
  await db.closePool();
  await rm(uploadRoot, { recursive: true, force: true });
  delete process.env.UPLOAD_ROOT;
});

describe('activity upload on a tree root (real PostgreSQL)', () => {
  let first;
  let second;

  it('lands each row on its sub-unit with the matched account and person', async () => {
    first = await upload(FIRST, 'q1.csv');
    expect(first.a.guess.contextColumn).toBe('Client');
    expect(first.out).toMatchObject({ imported: 4, replaced: 0, notImported: 1, period: { start: '2026-01-15', end: '2026-03-21' } });
    const rows = await rowsOf([NORTH, CONTOSO, ROOT]);
    expect(rows.map(r => [r.contextId, r.d, r.amount])).toEqual([
      [NORTH, '2026-01-15', 2], [NORTH, '2026-02-14', 1.5], [NORTH, '2026-03-13', 4], [CONTOSO, '2026-03-20', 0.5],
    ]);
    expect(rows[0]).toMatchObject({ principalId: P.vera, identityId: I.vera, unit: 'hours', kind: 'Build', attributes: { Project: 'Platform', Description: 'Work' } });
    expect(rows[2]).toMatchObject({ principalId: P.tom, identityId: null });
    expect(rows[3]).toMatchObject({ principalId: null, identityId: null, subjectName: `Ghost Person ${SUFFIX}` });
  });

  it('groups a unit\'s people against its members, in the period asked for', async () => {
    const v = await contextActivity(db, NORTH, { from: '2026-01-01', to: '2026-03-31' });
    const people = Object.fromEntries(v.groups.map(g => [g.key, g.people.map(p => p.displayName)]));
    expect(people).toEqual({
      memberAndActive: [vera()[0]],
      activeNotMember: [tom()[0]],
      memberNoActivity: [`Kim Idle ${SUFFIX}`],
      activeUnknown: [],
    });
    expect(v.groups[0].people[0]).toMatchObject({ amount: 3.5, firstDate: '2026-01-15', lastDate: '2026-02-14' });
    // Outside the period: Vera's January row only.
    const jan = await contextActivity(db, NORTH, { from: '2026-01-01', to: '2026-01-31' });
    expect(jan.groups.find(g => g.key === 'activeNotMember').people).toEqual([]);
    expect(jan.groups.find(g => g.key === 'memberAndActive').people[0].amount).toBe(2);
  });

  it('the root\'s table has one line per sub-unit with its suggestion counts', async () => {
    const s = await activitySummary(db, ROOT);
    expect(s.period).toEqual({ from: '2025-04-01', to: '2026-03-20' });
    const byId = Object.fromEntries(s.children.map(c => [c.contextId, c]));
    expect(byId[NORTH]).toMatchObject({ total: 7.5, activePeople: 2, activeNotMember: 1, memberNoActivity: 1 });
    expect(byId[CONTOSO]).toMatchObject({ total: 0.5, activePeople: 1, activeUnknown: 1, memberNoActivity: 0 });
  });

  it('a re-upload of the same source replaces only the overlapping period', async () => {
    const draft = await analyzeActivity({ buffer: SECOND, fileName: 'feb-apr.csv', uploadedBy: 'x', contextId: ROOT }, { db });
    const preview = await previewActivity({ uploadDraftId: draft.uploadDraftId, mapping: draft.guess }, ROOT, { db });
    // Feb 14, Mar 13, Mar 20 of the first upload fall in Feb 14 – Apr 18; Jan 15 does not.
    expect(preview.replaces.rows).toBe(3);
    second = { out: await applyActivity({ uploadDraftId: draft.uploadDraftId, mapping: draft.guess }, ROOT, 'x', { db }) };
    expect(second.out).toMatchObject({ imported: 2, replaced: 3 });
    const rows = await rowsOf([NORTH, CONTOSO]);
    expect(rows.map(r => [r.contextId, r.d, r.amount])).toEqual([
      [NORTH, '2026-01-15', 2], [NORTH, '2026-02-14', 1.5], [CONTOSO, '2026-04-18', 3],
    ]);
  });

  it('the history shows both uploads with what each still holds, on the root and on a unit', async () => {
    const onRoot = await listUploads(db, ROOT);
    expect(onRoot.map(u => [u.fileName, u.rowsHeld])).toEqual([['feb-apr.csv', 2], ['q1.csv', 1]]);
    const onContoso = await listUploads(db, CONTOSO);
    expect(onContoso.map(u => [u.fileName, u.rowsHere, u.contextName])).toEqual([['feb-apr.csv', 1, `Customers ${SUFFIX}`]]);
  });

  it('undo removes one upload and only its rows; it is null on another context', async () => {
    expect(await deleteUpload(db, NORTH, second.out.uploadId)).toBeNull();
    expect(await deleteUpload(db, ROOT, second.out.uploadId)).toEqual({ id: second.out.uploadId, rows: 2 });
    expect((await rowsOf([NORTH, CONTOSO])).map(r => r.d)).toEqual(['2026-01-15']);
  });

  it('deleting an account keeps its activity, unattributed; deleting a context removes its activity', async () => {
    await pool.query('DELETE FROM "Principals" WHERE id = $1', [P.vera]);
    const [kept] = await rowsOf([NORTH]);
    expect(kept).toMatchObject({ principalId: null, identityId: I.vera });
    await pool.query('DELETE FROM "Contexts" WHERE id = $1', [NORTH]);
    expect(await rowsOf([NORTH])).toEqual([]);
  });
});
