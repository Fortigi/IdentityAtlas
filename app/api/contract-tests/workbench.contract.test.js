// Contract test — the Authorization workbench against real PostgreSQL (migration
// 106). The unit tests are SQL-blind; this file runs every statement of
// contexts/workbench/load.js and contexts/orgKnowledge/*.js on a migrated schema
// and asserts what came back and what landed: one row per person (two accounts
// folded), the best grant type, the business role's composition, knowledge from
// any source, an analyst's own link with its "Analyst notes" source and object,
// and a proposed claim that names its object once confirmed.
//
// Isolation on the shared contract DB: one private system and tree; everything
// this file creates is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { loadWorkbench } = await import('../src/contexts/workbench/load.js');
const { addKnowledgeLink, peopleWithObject } = await import('../src/contexts/orgKnowledge/manual.js');
const { listObjects } = await import('../src/contexts/orgKnowledge/objects.js');
const { decideClaim } = await import('../src/contexts/interviews/decide.js');

let pool;
let sysId;
const ID = {};
const P = {};
const R = {};
const C = {};
const created = { objects: [] };

const db = {
  query: (sql, params) => pool.query(sql, params),
  queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null,
  tx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function identity(key, name) {
  ID[key] = (await one(`INSERT INTO "Identities" (id, "displayName", "jobTitle") VALUES (gen_random_uuid(), $1, 'Handler') RETURNING id`, [`wbc-${name}`])).id;
}
async function account(key, name, identityKey) {
  P[key] = (await one(`INSERT INTO "Principals" (id, "systemId", "displayName", "principalType") VALUES (gen_random_uuid(), $1, $2, 'User') RETURNING id`, [sysId, `wbc-${name}`])).id;
  if (identityKey) await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`, [ID[identityKey], P[key]]);
}
async function resource(key, name, extra = '') {
  R[key] = (await one(`INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType"${extra ? ', "governanceResource"' : ''})
    VALUES (gen_random_uuid(), $1, $2, $3${extra ? ', true' : ''}) RETURNING id`, [sysId, `wbc-${name}`, extra ? 'BusinessRole' : 'Group'])).id;
}
const grant = (r, p, type = 'Direct') => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId") VALUES ($1, $2, $3, $4)`, [R[r], P[p], type, sysId]);
async function context(key, name, parent = null) {
  C[key] = (await one(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "parentContextId")
    VALUES (gen_random_uuid(), 'manual', 'Identity', 'Department', 'OrganizationalUnit', $1, $2) RETURNING id`, [`wbc-${name}`, parent ? C[parent] : null])).id;
}
const member = (ctx, type, id) => pool.query(
  `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, $2, $3, 'analyst')`, [C[ctx], type, id]);

let proposedClaimId;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysId = (await one(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('WorkbenchTest', 'workbench-1') RETURNING id`)).id;
  await identity('anna', 'Anna');
  await identity('bram', 'Bram');
  await account('anna', 'anna', 'anna');
  await account('annaAdm', 'adm-anna', 'anna');
  await account('bram', 'bram', 'bram');
  await account('loose', 'svc-batch', null);
  await resource('read', 'Read');
  await resource('or', 'WorksCouncil');
  await resource('role', 'Handler role', 'role');
  await pool.query(`INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId") VALUES ($1, $2, 'Contains', $3)`, [R.role, R.read, sysId]);
  await grant('read', 'anna', 'Indirect');
  await grant('read', 'annaAdm', 'Direct');
  await grant('read', 'bram', 'Eligible');
  await grant('or', 'bram');
  await grant('role', 'anna');
  await context('unit', 'Claims');
  await context('team', 'Motor', 'unit');
  await member('unit', 'Identity', ID.anna);
  await member('team', 'Identity', ID.bram);
  await member('team', 'Principal', P.loose);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);

  // A model's proposed duty claim, from an interview about the team.
  const iv = await one(`INSERT INTO "ContextInterviews" ("contextId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus")
    VALUES ($1, 'Manager', DATE '2026-10-20', 'i.txt', 'Bram sits on the works council.', 'done') RETURNING id`, [C.team]);
  proposedClaimId = (await one(`INSERT INTO "ContextClaims" ("interviewId", "contextId", "claimKind", "subjectKind", "identityId", "subjectName", value, quote, "claimStatus", "proposedBy")
    VALUES ($1, $2, 'duty', 'Person', $3, 'Bram', 'wbc-Works council member', 'Bram sits on the works council.', 'proposed', 'model') RETURNING id`, [iv.id, C.team, ID.bram])).id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [[C.unit, ...created.objects]]);
  await pool.query(`DELETE FROM "Contexts" WHERE "displayName" LIKE 'wbc-%'`);
  await pool.query(`DELETE FROM "Identities" WHERE id = ANY($1::uuid[])`, [Object.values(ID)]);
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sysId]);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
});

describe('loadWorkbench on PostgreSQL', () => {
  it('reads the unit with its sub-unit: one row per person, two accounts folded, an unlinked account its own row', async () => {
    const out = await loadWorkbench(db, C.unit, { includeChildren: true });
    expect(out.scope.units).toBe(2);
    expect(out.people.map(p => p.displayName)).toEqual(['wbc-Anna', 'wbc-Bram', 'wbc-svc-batch']);
    const anna = out.people[0];
    expect(anna.accounts.map(a => a.displayName).sort()).toEqual(['wbc-adm-anna', 'wbc-anna']);
    expect(anna.direct).toBe(true);
    expect(out.people[1]).toMatchObject({ direct: false, units: ['wbc-Motor'] });
    expect(out.people[2]).toMatchObject({ identityId: null, principalId: P.loose });
  });

  it('takes the best grant over the accounts, and the business role with what it Contains', async () => {
    const out = await loadWorkbench(db, C.unit, { includeChildren: true });
    const cell = (person, r) => out.cells.find(c => c.person === person && c.resourceId === R[r]);
    expect(cell(`i:${ID.anna}`, 'read')).toMatchObject({ type: 'Direct' });
    expect(cell(`i:${ID.anna}`, 'read').accounts.sort()).toEqual([P.anna, P.annaAdm].sort());
    expect(cell(`i:${ID.anna}`, 'read').viaRoles).toEqual([R.role]);
    expect(cell(`i:${ID.bram}`, 'read')).toMatchObject({ type: 'Eligible' });
    const role = out.columns.find(c => c.id === R.role);
    expect(role).toMatchObject({ isRole: true, contains: [R.read], holders: 1 });
    expect(out.columns.find(c => c.id === R.read).holders).toBe(2);
  });

  it('reads only the unit itself when asked', async () => {
    const out = await loadWorkbench(db, C.unit, { includeChildren: false });
    expect(out.people.map(p => p.displayName)).toEqual(['wbc-Anna']);
  });

  it('reads the knowledge about the people, stated in any unit', async () => {
    const out = await loadWorkbench(db, C.unit);
    const bram = out.people.find(p => p.identityId === ID.bram);
    expect(bram.knowledge).toEqual([expect.objectContaining({ kind: 'duty', name: 'wbc-Works council member', state: 'proposed', objectId: null })]);
    expect(bram.knowledge[0].claims[0]).toMatchObject({ quote: 'Bram sits on the works council.', contextName: 'wbc-Motor', source: { kind: 'file', date: '2026-10-20' } });
  });
});

describe('knowledge on PostgreSQL', () => {
  it('confirming a proposed duty claim names its object, created under the Duties root', async () => {
    const { effect } = await decideClaim(db, proposedClaimId, { status: 'confirmed' }, 'ann@example.test');
    expect(effect).toMatchObject({ kind: 'knowledge', created: true });
    created.objects.push(effect.objectContextId);
    const obj = await one(`SELECT c."contextType", c."contextCategory", c."targetType", c.variant, p."extendedAttributes"->>'knowledgeRoot' AS root
      FROM "Contexts" c JOIN "Contexts" p ON p.id = c."parentContextId" WHERE c.id = $1`, [effect.objectContextId]);
    expect(obj).toEqual({ contextType: 'Duty', contextCategory: 'Tag', targetType: 'Identity', variant: 'manual', root: 'true' });
    const out = await loadWorkbench(db, C.unit);
    expect(out.people.find(p => p.identityId === ID.bram).knowledge[0]).toMatchObject({ state: 'confirmed', objectId: effect.objectContextId });
  });

  it('an analyst’s own link reuses that object (another spelling), on the unit’s Analyst notes', async () => {
    const row = await addKnowledgeLink(db, C.unit, { kind: 'duty', value: 'WBC-works  council member', principalId: P.loose }, 'ann@example.test');
    expect(row).toMatchObject({ claimKind: 'duty', status: 'confirmed', proposedBy: 'analyst', principalId: P.loose, fileName: 'Analyst notes', objectContextId: created.objects[0] });
    const again = await addKnowledgeLink(db, C.unit, { kind: 'activity', value: 'wbc-Handle claims', identityId: ID.anna, status: 'proposed' }, 'ann@example.test');
    expect(again).toMatchObject({ status: 'proposed', objectContextId: null, interviewId: row.interviewId });
    const people = await peopleWithObject(db, created.objects[0]);
    expect(people.map(p => [p.displayName, p.status])).toEqual([['wbc-Bram', 'confirmed'], ['wbc-svc-batch', 'confirmed']]);
  });

  it('lists the object with how many people hold it', async () => {
    const duties = await listObjects(db, 'duty');
    expect(duties.find(o => o.id === created.objects[0])).toMatchObject({ displayName: 'wbc-Works council member', confirmedPeople: 2, proposedPeople: 0 });
  });

  it('adds nothing to access or members', async () => {
    const n = await one(`SELECT
      (SELECT count(*) FROM "ResourceAssignments" WHERE "systemId" = $1)::int AS grants,
      (SELECT count(*) FROM "ContextMembers" WHERE "contextId" = $2)::int AS members`, [sysId, created.objects[0]]);
    expect(n).toEqual({ grants: 5, members: 0 });
  });
});
