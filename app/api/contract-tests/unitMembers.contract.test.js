// Contract test — the unit report against a real PostgreSQL schema.
//
// The unit tests mock the DB; this proves the member and count statements are
// valid SQL selecting the right rows: a soft-deleted account left out, a
// soft-deleted assignment and a business role not counted, a person's
// entitlements summed across their linked accounts without double counting,
// and sub-units only when asked. Everything hangs off its own system.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { asBinary, sheetNamed } from '../test-utils/xlsxDownload.js';

const SYSTEM_NAME = 'contract-unit-members';
const ACCOUNTS = 'Contract Unit Accounts';
const PEOPLE = 'Contract Unit People';

let agent;
let pool;
let systemId;

const id = {
  accounts: randomUUID(), sub: randomUUID(), people: randomUUID(),
  alice: randomUUID(), bob: randomUUID(), gone: randomUUID(), carol: randomUUID(), boss: randomUUID(),
  grace: randomUUID(), dave: randomUUID(), interview: randomUUID(),
  g1: randomUUID(), g2: randomUUID(), g3: randomUUID(), role: randomUUID(),
};

const q = (sql, params) => pool.query(sql, params);

async function context(cid, name, targetType, parent = null) {
  await q(`INSERT INTO "Contexts" ("id","variant","targetType","contextType","contextCategory","displayName","parentContextId","extendedAttributes")
           VALUES ($1,'synced',$2,'Department','OrganizationalUnit',$3,$4,'{"costCenter":"FIN-01"}'::jsonb)`, [cid, targetType, name, parent]);
}
const member = (cid, mid, type) => q(
  `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,$3,$2,'sync')`, [cid, mid, type]);
const principal = (pid, name, { manager = null, deleted = false, attrs = {} } = {}) => q(
  `INSERT INTO "Principals" ("id","systemId","displayName","email","principalType","employeeId","managerId","accountEnabled","deletedAt","extendedAttributes")
   VALUES ($1,$2,$3,$4,'User',$5,$6,true,$7,$8::jsonb)`,
  [pid, systemId, name, `${name.toLowerCase()}@example.com`, `E-${name}`, manager, deleted ? new Date() : null, JSON.stringify(attrs)]);
const resource = (rid, name, type = 'Group') => q(
  `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","extendedAttributes") VALUES ($1,$2,$3,$4,'{}'::jsonb)`,
  [rid, systemId, name, type]);
const assign = (rid, pid, type = 'Direct', deleted = false) => q(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","deletedAt") VALUES ($1,$2,$3,$4,$5)`,
  [rid, pid, type, systemId, deleted ? new Date() : null]);

async function seed() {
  systemId = (await q(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING id`, [SYSTEM_NAME])).rows[0].id;
  await principal(id.boss, 'Boss');
  await principal(id.alice, 'Alice', { manager: id.boss, attrs: { badge: 7 } });
  await principal(id.bob, 'Bob', { manager: id.boss });
  await principal(id.gone, 'Gone', { deleted: true });
  await principal(id.carol, 'Carol');
  for (const [rid, name] of [[id.g1, 'G1'], [id.g2, 'G2'], [id.g3, 'G3']]) await resource(rid, name);
  await resource(id.role, 'A role', 'BusinessRole');

  // Alice: G1 directly and via a role (one entitlement), G2, a deleted G3, and the role itself.
  await assign(id.g1, id.alice);
  await assign(id.g1, id.alice, 'Indirect');
  await assign(id.g2, id.alice);
  await assign(id.g3, id.alice, 'Direct', true);
  await assign(id.role, id.alice);
  await assign(id.g3, id.bob);
  await assign(id.g2, id.carol);

  await context(id.accounts, ACCOUNTS, 'Principal');
  await context(id.sub, 'Contract Unit Sub', 'Principal', id.accounts);
  for (const m of [id.alice, id.bob, id.gone]) await member(id.accounts, m, 'Principal');
  await member(id.sub, id.carol, 'Principal');

  // Grace is one person with two accounts (Alice and Carol): G1, G2 — G2 held by both, counted once.
  await q(`INSERT INTO "Identities" ("id","displayName","email","employeeId","accountCount","extendedAttributes")
           VALUES ($1,'Grace','grace@example.com','E-G',2,'{"site":"Utrecht"}'::jsonb)`, [id.grace]);
  for (const p of [id.alice, id.carol]) await q(`INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2)`, [id.grace, p]);
  await context(id.people, PEOPLE, 'Identity');
  await member(id.people, id.grace, 'Identity');

  // What an interview with Boss says: Alice is the controller (confirmed), and
  // Dave — not a member any more — left (confirmed) and still holds G2.
  await principal(id.dave, 'Dave');
  await assign(id.g2, id.dave);
  await q(`INSERT INTO "ContextInterviews" ("id","contextId","principalId","intervieweeName","interviewedAt","fileName","transcript")
           VALUES ($1,$2,$3,'Boss','2026-10-01','gesprek.vtt','…')`, [id.interview, id.accounts, id.boss]);
  const claim = (pid, kind, attribute, value, status = 'confirmed') => q(
    `INSERT INTO "ContextClaims" ("interviewId","contextId","claimKind","subjectKind","principalId","attribute","value","claimStatus","proposedBy")
     VALUES ($1,$2,$3,'Person',$4,$5,$6,$7,'analyst')`, [id.interview, id.accounts, kind, pid, attribute, value, status]);
  await claim(id.alice, 'role', null, 'Controller');
  await claim(id.bob, 'role', null, 'Auditor', 'proposed');
  await claim(id.dave, 'membership', 'left', 'left the team');
}

async function rows(contexts, extra = {}) {
  const res = await agent.get('/api/reports/unit-members/rows').query({ contexts, ...extra });
  expect(res.status).toBe(200);
  return res.body;
}
const byName = body => Object.fromEntries(body.rows.map(r => [r.displayName, r]));

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  await seed();
});

afterAll(async () => {
  const contexts = [id.accounts, id.sub, id.people];
  await q(`DELETE FROM "ContextMembers" WHERE "contextId" = ANY($1::uuid[])`, [contexts]);
  await q(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [contexts]);
  await q(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [id.grace]);
  await q(`DELETE FROM "Identities" WHERE id = $1`, [id.grace]);
  await q(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
});

describe('GET /reports/unit-members on a unit of accounts', () => {
  it('lists the live direct members with their manager and their distinct entitlements', async () => {
    const body = await rows(ACCOUNTS);
    const members = byName(body);
    // Dave is not a member; he follows the members because an interview says he left (below).
    expect(Object.keys(members)).toEqual(['Alice', 'Bob', 'Dave']);
    // G1 twice counts once, the deleted G3 and the business role not at all.
    expect(members.Alice).toMatchObject({ entitlements: 2, manager: 'Boss', employeeId: 'E-Alice', 'member.ext.badge': 7 });
    expect(members.Bob).toMatchObject({ entitlements: 1, 'member.ext.badge': null });
    expect(body.details[0].title).toBe(`Context: ${ACCOUNTS}`);
    expect(body.details[0].entries).toContainEqual({ label: 'costCenter', value: 'FIN-01' });
  });

  it('adds the sub-units\' members when asked, each under its own unit', async () => {
    const body = await rows(ACCOUNTS, { includeSubUnits: 'true' });
    expect(body.rows.map(r => [r.unit, r.displayName])).toEqual([
      [ACCOUNTS, 'Alice'], [ACCOUNTS, 'Bob'], ['Contract Unit Sub', 'Carol'], [ACCOUNTS, 'Dave'],
    ]);
  });

  it('downloads a workbook that opens with the unit', async () => {
    const res = await asBinary(agent.get('/api/reports/unit-members/export').query({ contexts: id.accounts, format: 'xlsx' }));
    expect(res.status).toBe(200);
    const summary = await sheetNamed(res.body, 'Summary');
    const labels = [];
    summary.eachRow(row => labels.push(row.getCell(1).value));
    expect(labels).toEqual(expect.arrayContaining([`Context: ${ACCOUNTS}`, 'Accountable', 'costCenter']));
  });
});

describe('GET /reports/unit-members — organisational claims', () => {
  it('adds the People overview status, role and source, and the people who left after the members', async () => {
    const body = await rows(ACCOUNTS);
    expect(body.rows.map(r => [r.displayName, r.status, r.claimStatus, r.claimRole, r.entitlements])).toEqual([
      ['Alice', 'current', 'Current', 'Controller', 2],
      // Open mode is a writer: the proposed role shows, marked.
      ['Bob', 'current', 'Current', 'Auditor (proposed)', 1],
      ['Dave', 'not listed by the source', 'Left', null, 1],
    ]);
    expect(byName(body).Alice.claimSource).toBe('interview with Boss, 2026-10-01');
    const entries = Object.fromEntries(body.details[0].entries.map(e => [e.label, e.value]));
    expect(entries).toMatchObject({ 'Current members': 2, 'Former people': 1, 'Claims proposed (not reviewed)': 1 });
  });

  it('names the claim columns, set apart in the workbook', async () => {
    const res = await asBinary(agent.get('/api/reports/unit-members/export').query({ contexts: id.accounts, format: 'xlsx' }));
    const data = await sheetNamed(res.body, 'Data');
    const header = data.getRow(1).values.slice(1);
    const at = header.indexOf('Org claim — Status');
    expect(header.slice(at, at + 3)).toEqual(['Org claim — Status', 'Org claim — Role', 'Org claim — Source']);
    expect(data.getRow(1).getCell(at + 1).fill.fgColor.argb).toBe('FFFEF3C7');
  });
});

describe('GET /reports/unit-members on a unit of people', () => {
  it('lists the person, counting entitlements across their linked accounts once each', async () => {
    const body = await rows(PEOPLE);
    expect(byName(body).Grace).toMatchObject({ entitlements: 2, linkedAccounts: 2, 'member.ext.site': 'Utrecht' });
  });
});
