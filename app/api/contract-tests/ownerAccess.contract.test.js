// Contract test — the owner-access tiers (src/auth/ownerAccess/tiers.js)
// against the real schema.
//
// The unit tests mock the database; here the statements meet real rows. The
// owner's scope is a unit of people (Ann's person), a unit of accounts (Carl's
// account) and an application (a resource unit). The cases that matter:
//   - team crosses the account/person link both ways: Ann's admin account is on
//     the team through her person; Carl's person through his account;
//   - an outsider (Olga, her person, her account) is not, though she shares a
//     group with the team;
//   - held: a group held by a team account, a group assigned to the team PERSON,
//     an Eligible role — but not a soft-deleted assignment, not a group held only
//     by the outsider;
//   - a resource unit's member is team;
//   - 'member' is direct membership only (Ann's account is not a direct member);
//   - an owner of only the accounts unit does not get the people unit's team;
//   - holder (an application's mirror tier): Hank holds the app resource, so he
//     opens — and his person through him; Pia's person holds it, so Pia's
//     account opens through her person; Dora's assignment is soft-deleted, so she
//     does not; what Hank holds outside the app stays name-only;
//   - an owner of a unit AND an application gets the union.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { classifyTiers } from '../src/auth/ownerAccess/tiers.js';

let pool;
let systemId;
const id = Object.fromEntries([
  'ann', 'annAdmin', 'annPerson', 'carl', 'carlPerson', 'olga', 'olgaPerson',
  'hank', 'hankPerson', 'pia', 'piaPerson', 'dora', 'groupHankOther',
  'groupTeam', 'groupViaPerson', 'roleEligible', 'groupDeleted', 'groupOutsider', 'groupShared', 'appResource',
  'peopleUnit', 'accountUnit', 'appUnit', 'otherUnit',
].map(k => [k, randomUUID()]));

async function principal(pid, name) {
  await pool.query(`INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`, [pid, systemId, name]);
}
async function person(iid, name, accounts) {
  await pool.query(`INSERT INTO "Identities" ("id","displayName") VALUES ($1,$2)`, [iid, name]);
  for (const p of accounts) {
    await pool.query(`INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2)`, [iid, p]);
  }
}
async function resource(rid, name) {
  await pool.query(`INSERT INTO "Resources" ("id","systemId","displayName","resourceType") VALUES ($1,$2,$3,'Group')`, [rid, systemId, name]);
}
async function assign(resourceId, holder, type = 'Direct', deleted = false) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","identityId","assignmentType","systemId","deletedAt")
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [resourceId, holder.principalId ?? null, holder.identityId ?? null, type, systemId, deleted ? new Date() : null],
  );
}
async function unit(ctxId, targetType, memberIds) {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","scopeSystemId")
     VALUES ($1,'manual',$2,'Department',$3,$4)`,
    [ctxId, targetType, `unit ${ctxId.slice(0, 8)}`, systemId],
  );
  for (const m of memberIds) {
    await pool.query(`INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,$2,$3,'analyst')`, [ctxId, targetType, m]);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-owner-access') RETURNING "id"`,
  )).rows[0].id;
  for (const [pid, name] of [[id.ann, 'Ann'], [id.annAdmin, 'Ann (admin)'], [id.carl, 'Carl'], [id.olga, 'Olga'],
    [id.hank, 'Hank'], [id.pia, 'Pia'], [id.dora, 'Dora']]) await principal(pid, name);
  await person(id.hankPerson, 'Hank the person', [id.hank]);
  await person(id.piaPerson, 'Pia the person', [id.pia]);
  await person(id.annPerson, 'Ann the person', [id.ann, id.annAdmin]);
  await person(id.carlPerson, 'Carl the person', [id.carl]);
  await person(id.olgaPerson, 'Olga the person', [id.olga]);
  for (const [rid, name] of [
    [id.groupTeam, 'Team group'], [id.groupViaPerson, 'Person-assigned group'], [id.roleEligible, 'Eligible role'],
    [id.groupDeleted, 'Deleted assignment'], [id.groupOutsider, 'Outsider group'], [id.groupShared, 'Shared group'],
    [id.appResource, 'App resource'], [id.groupHankOther, 'Hank outside the app'],
  ]) await resource(rid, name);
  await assign(id.appResource, { principalId: id.hank });
  await assign(id.appResource, { identityId: id.piaPerson }, 'Eligible');
  await assign(id.appResource, { principalId: id.dora }, 'Direct', true);
  await assign(id.groupHankOther, { principalId: id.hank });

  await assign(id.groupTeam, { principalId: id.annAdmin });
  await assign(id.groupViaPerson, { identityId: id.annPerson });
  await assign(id.roleEligible, { principalId: id.carl }, 'Eligible');
  await assign(id.groupDeleted, { principalId: id.ann }, 'Direct', true);
  await assign(id.groupOutsider, { principalId: id.olga });
  await assign(id.groupShared, { principalId: id.olga });
  await assign(id.groupShared, { principalId: id.carl }, 'Indirect');

  await unit(id.peopleUnit, 'Identity', [id.annPerson]);
  await unit(id.accountUnit, 'Principal', [id.carl]);
  await unit(id.appUnit, 'Resource', [id.appResource]);
  await unit(id.otherUnit, 'Identity', [id.olgaPerson]);
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [[id.annPerson, id.carlPerson, id.olgaPerson, id.hankPerson, id.piaPerson]]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

const SCOPE = () => [id.peopleUnit, id.accountUnit, id.appUnit];
const tiers = async (kind, ids, scope = SCOPE()) => Object.fromEntries(
  ids.map(i => [i, null]).concat([...(await classifyTiers(pool, scope, kind, ids))]),
);

describe('principal', () => {
  it('team through the person (both of Ann\'s accounts) and directly (Carl); not the outsider', async () => {
    expect(await tiers('principal', [id.ann, id.annAdmin, id.carl, id.olga])).toEqual({
      [id.ann]: 'team', [id.annAdmin]: 'team', [id.carl]: 'team', [id.olga]: null,
    });
  });
});

describe('identity', () => {
  it('team directly (Ann\'s person) and through an account (Carl\'s person); not the outsider', async () => {
    expect(await tiers('identity', [id.annPerson, id.carlPerson, id.olgaPerson])).toEqual({
      [id.annPerson]: 'team', [id.carlPerson]: 'team', [id.olgaPerson]: null,
    });
  });
});

describe('resource', () => {
  it('held by a team account, by the team person, as Eligible and as Indirect; team as a resource unit\'s member', async () => {
    expect(await tiers('resource', [id.groupTeam, id.groupViaPerson, id.roleEligible, id.groupShared, id.appResource])).toEqual({
      [id.groupTeam]: 'held', [id.groupViaPerson]: 'held', [id.roleEligible]: 'held', [id.groupShared]: 'held', [id.appResource]: 'team',
    });
  });

  it('not held through a soft-deleted assignment, nor when only an outsider holds it', async () => {
    expect(await tiers('resource', [id.groupDeleted, id.groupOutsider])).toEqual({ [id.groupDeleted]: null, [id.groupOutsider]: null });
  });
});

describe('member', () => {
  it('a direct member of any in-scope context, whatever its type — not an account of a member person', async () => {
    expect(await tiers('member', [id.annPerson, id.carl, id.appResource, id.ann, id.olgaPerson])).toEqual({
      [id.annPerson]: 'team', [id.carl]: 'team', [id.appResource]: 'team', [id.ann]: null, [id.olgaPerson]: null,
    });
  });
});

describe('a narrower scope', () => {
  it('the owner of the accounts unit alone: Carl and what he holds, not Ann or her groups', async () => {
    const scope = [id.accountUnit];
    expect(await tiers('principal', [id.carl, id.ann], scope)).toEqual({ [id.carl]: 'team', [id.ann]: null });
    expect(await tiers('resource', [id.roleEligible, id.groupTeam, id.groupViaPerson], scope)).toEqual({
      [id.roleEligible]: 'held', [id.groupTeam]: null, [id.groupViaPerson]: null,
    });
  });
});

describe('holder — the application mirror', () => {
  const APP = () => [id.appUnit];

  it('an account holding an app resource opens, and so does an account whose person holds one; not a soft-deleted holder', async () => {
    expect(await tiers('principal', [id.hank, id.pia, id.dora, id.olga], APP())).toEqual({
      [id.hank]: 'holder', [id.pia]: 'holder', [id.dora]: null, [id.olga]: null,
    });
  });

  it('a person holding one, or one of whose accounts holds one, opens', async () => {
    expect(await tiers('identity', [id.hankPerson, id.piaPerson, id.olgaPerson], APP())).toEqual({
      [id.hankPerson]: 'holder', [id.piaPerson]: 'holder', [id.olgaPerson]: null,
    });
  });

  it('what a holder holds outside the application stays name-only', async () => {
    expect(await tiers('resource', [id.appResource, id.groupHankOther], APP())).toEqual({
      [id.appResource]: 'team', [id.groupHankOther]: null,
    });
  });

  it('an owner of a unit and an application gets the union — and team wins over holder', async () => {
    await assign(id.appResource, { principalId: id.carl });
    const both = [id.accountUnit, id.appUnit];
    expect(await tiers('principal', [id.carl, id.hank, id.ann], both)).toEqual({ [id.carl]: 'team', [id.hank]: 'holder', [id.ann]: null });
    expect(await tiers('resource', [id.roleEligible, id.appResource, id.groupHankOther], both)).toEqual({
      [id.roleEligible]: 'held', [id.appResource]: 'team', [id.groupHankOther]: null,
    });
    expect(await tiers('principal', [id.hank], [id.accountUnit])).toEqual({ [id.hank]: null });
  });
});
