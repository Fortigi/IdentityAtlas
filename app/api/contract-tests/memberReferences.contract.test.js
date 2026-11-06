// Contract test — a context member's references (src/contexts/memberReferences.js)
// against the real schema.
//
// The unit tests use a fake pool, so they cannot tell whether these statements
// pick the right rows. The cases that matter for a context owner reading them:
//   - membership is of THIS context: a member of another context is not one;
//   - a person's references come through the person and every linked account,
//     one row per (resource, assignment type) however many accounts hold it;
//   - an account's references are its own (an assignment made to its person is
//     not one of them);
//   - soft-deleted assignments and resources are left out, a resource with no
//     type is a resource and not a business role;
//   - a resource is held by accounts and by a person; it sits in business roles;
//   - each group stops at 50 names and still tells the true total (51 vs 50).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { findContextMember, loadMemberReferences } from '../src/contexts/memberReferences.js';

const SYSTEM = 'contract-member-refs';
let pool;
let systemId;
const id = {
  ann: randomUUID(), annAdmin: randomUUID(), bob: randomUUID(), carol: randomUUID(), person: randomUUID(),
  alpha: randomUUID(), beta: randomUUID(), untyped: randomUUID(), gone: randomUUID(), role: randomUUID(),
  peopleUnit: randomUUID(), accountUnit: randomUUID(), otherPeople: randomUUID(), otherAccounts: randomUUID(),
  resourceUnit: randomUUID(), otherResources: randomUUID(), capUnit: randomUUID(),
};
const capResources = Array.from({ length: 51 }, (_, i) => ({ id: randomUUID(), name: `Cap ${String(i).padStart(2, '0')}` }));

async function principal(pid, name) {
  await pool.query(`INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`, [pid, systemId, name]);
}
async function resource(rid, name, type, deleted = false) {
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","deletedAt") VALUES ($1,$2,$3,$4,$5)`,
    [rid, systemId, name, type, deleted ? new Date() : null],
  );
}
async function assign(resourceId, holder, type, deleted = false) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","identityId","assignmentType","systemId","deletedAt")
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [resourceId, holder.principalId ?? null, holder.identityId ?? null, type, systemId, deleted ? new Date() : null],
  );
}
async function context(ctxId, name, targetType, memberIds) {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","scopeSystemId")
     VALUES ($1,'manual',$2,'Department',$3,$4)`,
    [ctxId, targetType, name, systemId],
  );
  for (const memberId of memberIds) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,$2,$3,'analyst')`,
      [ctxId, targetType, memberId],
    );
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING "id"`, [SYSTEM],
  )).rows[0].id;

  await principal(id.ann, 'Ann');
  await principal(id.annAdmin, 'Ann (admin)');
  await principal(id.bob, 'Bob');
  await principal(id.carol, 'Carol');
  await pool.query(`INSERT INTO "Identities" ("id","displayName") VALUES ($1,'Ann the person')`, [id.person]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2),($1,$3)`, [id.person, id.ann, id.annAdmin]);

  await resource(id.alpha, 'Alpha group', 'Group');
  await resource(id.beta, 'Beta group', 'Group');
  await resource(id.untyped, 'Untyped thing', null);
  await resource(id.gone, 'Gone group', 'Group', true);
  await resource(id.role, 'Payroll clerk', 'BusinessRole');
  for (const r of capResources) await resource(r.id, r.name, 'Group');

  await assign(id.alpha, { principalId: id.ann }, 'Direct');
  await assign(id.alpha, { principalId: id.annAdmin }, 'Direct');      // same group, the person's other account
  await assign(id.beta, { principalId: id.annAdmin }, 'Eligible');
  await assign(id.beta, { principalId: id.ann }, 'Indirect', true);     // soft-deleted assignment
  await assign(id.untyped, { principalId: id.ann }, 'Direct');
  await assign(id.gone, { principalId: id.ann }, 'Direct');             // soft-deleted resource
  await assign(id.role, { identityId: id.person }, 'Direct');           // assigned to the person
  for (const r of capResources) await assign(r.id, { principalId: id.bob }, 'Direct');
  for (const r of capResources.slice(0, 50)) await assign(r.id, { principalId: id.carol }, 'Direct');

  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId") VALUES ($1,$2,'Contains',$3)`,
    [id.role, id.alpha, systemId],
  );

  await context(id.peopleUnit, 'People unit', 'Identity', [id.person]);
  await context(id.accountUnit, 'Account unit', 'Principal', [id.ann]);
  await context(id.otherPeople, 'Other people', 'Identity', [id.person]);
  await context(id.otherAccounts, 'Other accounts', 'Principal', [id.annAdmin]);
  await context(id.resourceUnit, 'Resource unit', 'Resource', [id.alpha, id.role]);
  await context(id.otherResources, 'Other resources', 'Resource', [id.alpha]);
  await context(id.capUnit, 'Cap unit', 'Principal', [id.bob, id.carol]);
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Identities" WHERE "id" = $1`, [id.person]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

const group = (out, key) => out.groups.find(g => g.key === key);

describe('findContextMember', () => {
  it('finds a member of this context, with its type', async () => {
    expect(await findContextMember(pool, id.peopleUnit, id.person)).toEqual({ memberType: 'Identity' });
  });

  it('does not find a member of ANOTHER context', async () => {
    // Ann is a member of the account unit, not of the people unit.
    expect(await findContextMember(pool, id.peopleUnit, id.ann)).toBeNull();
  });
});

describe('a person', () => {
  it('holds what their accounts and they themselves hold — once per resource and type, live rows only', async () => {
    const out = await loadMemberReferences(pool, id.peopleUnit, 'Identity', id.person);
    expect(group(out, 'resources')).toEqual({
      key: 'resources',
      total: 3,
      items: [
        { displayName: 'Alpha group', resourceType: 'Group', systemName: SYSTEM, assignmentType: 'Direct' },
        { displayName: 'Beta group', resourceType: 'Group', systemName: SYSTEM, assignmentType: 'Eligible' },
        { displayName: 'Untyped thing', resourceType: null, systemName: SYSTEM, assignmentType: 'Direct' },
      ],
    });
    expect(group(out, 'businessRoles').items).toEqual([
      { displayName: 'Payroll clerk', resourceType: 'BusinessRole', systemName: SYSTEM, assignmentType: 'Direct' },
    ]);
  });

  it('is in the other contexts of the person and of each account, never this one', async () => {
    const out = await loadMemberReferences(pool, id.peopleUnit, 'Identity', id.person);
    expect(group(out, 'contexts').items.map(c => c.displayName)).toEqual(['Account unit', 'Other accounts', 'Other people']);
    expect(group(out, 'contexts').items[0]).toEqual({ displayName: 'Account unit', contextType: 'Department', targetType: 'Principal' });
  });
});

describe('an account', () => {
  it('holds its own assignments only — not its person\'s, nor its sibling account\'s', async () => {
    const out = await loadMemberReferences(pool, id.accountUnit, 'Principal', id.ann);
    expect(group(out, 'resources').items.map(r => [r.displayName, r.assignmentType])).toEqual([
      ['Alpha group', 'Direct'], ['Untyped thing', 'Direct'],
    ]);
    expect(group(out, 'businessRoles')).toEqual({ key: 'businessRoles', items: [], total: 0 });
    expect(group(out, 'contexts').total).toBe(0);
  });
});

describe('a resource', () => {
  it('is held by accounts, sits in a business role and in another context', async () => {
    const out = await loadMemberReferences(pool, id.resourceUnit, 'Resource', id.alpha);
    expect(group(out, 'holders').items).toEqual([
      { displayName: 'Ann', holderType: 'User', assignmentType: 'Direct' },
      { displayName: 'Ann (admin)', holderType: 'User', assignmentType: 'Direct' },
    ]);
    expect(group(out, 'businessRoles').items).toEqual([{ displayName: 'Payroll clerk', systemName: SYSTEM }]);
    expect(group(out, 'contexts').items.map(c => c.displayName)).toEqual(['Other resources']);
  });

  it('is held by a person when the assignment was made to the person', async () => {
    const out = await loadMemberReferences(pool, id.resourceUnit, 'Resource', id.role);
    expect(group(out, 'holders').items).toEqual([{ displayName: 'Ann the person', holderType: 'Person', assignmentType: 'Direct' }]);
  });
});

describe('the cap', () => {
  it('lists 50 of 51 alphabetically and tells the total of 51', async () => {
    const g = group(await loadMemberReferences(pool, id.capUnit, 'Principal', id.bob), 'resources');
    expect(g.total).toBe(51);
    expect(g.items).toHaveLength(50);
    expect(g.items[0].displayName).toBe('Cap 00');
    expect(g.items[49].displayName).toBe('Cap 49');
  });

  it('lists all of exactly 50', async () => {
    const g = group(await loadMemberReferences(pool, id.capUnit, 'Principal', id.carol), 'resources');
    expect(g.total).toBe(50);
    expect(g.items).toHaveLength(50);
  });
});
