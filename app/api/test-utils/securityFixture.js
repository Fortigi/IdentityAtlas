// The authorization security fixture: a small, deterministic organisation with
// overlapping and non-overlapping scopes, seeded straight into the contract-test
// PostgreSQL. Used by contract-tests/authzSecurity.integration.test.js; reusable
// by any test that needs "who may see what" to be known in advance.
//
//   Unit A (accounts)                Accountable: Carla   Responsible: Dave
//   ├ members: Ann, Sam
//   └ Unit A1 (sub-unit)             no roles of its own
//       members: Andy
//   Unit B (accounts)                Accountable: Bob
//     members: Ben, Sam              (Sam is in A and B — overlap)
//   App X (resources)                Accountable: Mia   (Mia also Responsible for B)
//     members: App resource          held by Hank, who also holds "Hank's other group"
//   Unit Other (accounts)            nobody in the test answers for it
//     members: Olga                  the outsider
//
//   Groups:  A group (Ann)  ·  A1 group (Andy)  ·  B group (Ben)  ·  Shared group (Sam)
//            Mixed group (Ann AND Olga)  ·  Outsider group (Olga)  ·  Hank's other group (Hank)
//            Gone group (Ann, assignment soft-deleted — never "held")
//   Person:  "Ann the person" links Ann's account (crossover is covered by
//            contract-tests/ownerAccess.contract.test.js; here it is just present).
//
// `expected` is the specification, written by hand: what each owner may open.
// It is deliberately NOT computed from the code under test.

import { randomUUID } from 'crypto';

export const FIXTURE_PREFIX = 'SecFx';

const KEYS = {
  principals: ['carla', 'dave', 'bob', 'mia', 'ann', 'sam', 'andy', 'ben', 'hank', 'olga'],
  identities: ['annPerson'],
  resources: ['groupA', 'groupA1', 'groupB', 'groupShared', 'groupMixed', 'groupOutsider', 'groupHankOther', 'groupGone', 'appResource'],
  contexts: ['unitA', 'unitA1', 'unitB', 'appX', 'unitOther'],
};

const NAMES = {
  carla: 'Carla Cash', dave: 'Dave Delegate', bob: 'Bob Boss', mia: 'Mia Multi', ann: 'Ann Andersen', sam: 'Sam Shared',
  andy: 'Andy Sub', ben: 'Ben Bee', hank: 'Hank Holder', olga: 'Olga Outsider',
  annPerson: 'Ann the person',
  groupA: 'A group', groupA1: 'A1 group', groupB: 'B group', groupShared: 'Shared group', groupMixed: 'Mixed group',
  groupOutsider: 'Outsider group', groupHankOther: "Hank's other group", groupGone: 'Gone group', appResource: 'App resource',
  unitA: 'Unit A', unitA1: 'Unit A1', unitB: 'Unit B', appX: 'App X', unitOther: 'Unit Other',
};

/** The fixture's display name for a key — prefixed, so it can never collide with other data. */
export const nameOf = (key) => `${FIXTURE_PREFIX} ${NAMES[key]}`;

export async function seedSecurityFixture(pool) {
  const id = Object.fromEntries(Object.values(KEYS).flat().map(k => [k, randomUUID()]));
  const systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING "id"`, [`${FIXTURE_PREFIX} system`],
  )).rows[0].id;

  for (const k of KEYS.principals) {
    await pool.query(
      `INSERT INTO "Principals" ("id","systemId","displayName","principalType","email","department")
       VALUES ($1,$2,$3,'User',$4,$5)`,
      [id[k], systemId, nameOf(k), `${k}@secfx.test`, k === 'olga' ? 'Secret department' : 'Fixture department'],
    );
  }
  await pool.query(`INSERT INTO "Identities" ("id","displayName") VALUES ($1,$2)`, [id.annPerson, nameOf('annPerson')]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2)`, [id.annPerson, id.ann]);
  for (const k of KEYS.resources) {
    await pool.query(
      `INSERT INTO "Resources" ("id","systemId","displayName","resourceType") VALUES ($1,$2,$3,$4)`,
      [id[k], systemId, nameOf(k), k === 'appResource' ? 'AppRole' : 'Group'],
    );
  }

  const assign = (resource, principal, deleted = false) => pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","deletedAt")
     VALUES ($1,$2,'Direct',$3,$4)`, [id[resource], id[principal], systemId, deleted ? new Date() : null],
  );
  for (const [r, p] of [
    ['groupA', 'ann'], ['groupA1', 'andy'], ['groupB', 'ben'], ['groupShared', 'sam'],
    ['groupMixed', 'ann'], ['groupMixed', 'olga'], ['groupOutsider', 'olga'],
    ['appResource', 'hank'], ['groupHankOther', 'hank'],
  ]) await assign(r, p);
  await assign('groupGone', 'ann', true);

  const context = (k, targetType, parent = null) => pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","scopeSystemId","parentContextId")
     VALUES ($1,'manual',$2,'Department',$3,$4,$5)`, [id[k], targetType, nameOf(k), systemId, parent ? id[parent] : null],
  );
  await context('unitA', 'Principal');
  await context('unitA1', 'Principal', 'unitA');
  await context('unitB', 'Principal');
  await context('appX', 'Resource');
  await context('unitOther', 'Principal');
  const member = (ctx, type, m) => pool.query(
    `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,$2,$3,'analyst')`, [id[ctx], type, id[m]],
  );
  for (const [c, m] of [['unitA', 'ann'], ['unitA', 'sam'], ['unitA1', 'andy'], ['unitB', 'ben'], ['unitB', 'sam'], ['unitOther', 'olga']]) {
    await member(c, 'Principal', m);
  }
  await member('appX', 'Resource', 'appResource');

  const role = (ctx, p, r) => pool.query(
    `INSERT INTO "ContextRoles" ("contextId","principalId","role","addedBy") VALUES ($1,$2,$3,'analyst')`, [id[ctx], id[p], r],
  );
  await role('unitA', 'carla', 'Accountable');
  await role('unitA', 'dave', 'Responsible');
  await role('unitB', 'bob', 'Accountable');
  await role('unitB', 'mia', 'Responsible');
  await role('appX', 'mia', 'Accountable');

  return { id, systemId, expected: expectedScopes(id) };
}

/** What each owner may open — the specification the tests hold the code to. */
function expectedScopes(id) {
  const ids = (keys) => new Set(keys.map(k => id[k]));
  const carla = {
    principal: ids(['ann', 'sam', 'andy']),
    identity: ids(['annPerson']),
    resource: ids(['groupA', 'groupA1', 'groupShared', 'groupMixed']),
    context: ids(['unitA', 'unitA1']),
  };
  return {
    carla,
    dave: carla, // Responsible counts the same as Accountable
    bob: {
      principal: ids(['ben', 'sam']),
      identity: ids([]),
      resource: ids(['groupB', 'groupShared']),
      context: ids(['unitB']),
    },
    mia: { // Unit B + App X: the union, with Hank as the application's holder
      principal: ids(['ben', 'sam', 'hank']),
      identity: ids([]),
      resource: ids(['groupB', 'groupShared', 'appResource']),
      context: ids(['unitB', 'appX']),
    },
  };
}

export async function dropSecurityFixture(pool, fx) {
  if (!fx) return;
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [fx.systemId]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [fx.systemId]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [fx.id.annPerson]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [fx.systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [fx.systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [fx.systemId]);
}

export const FIXTURE_KEYS = KEYS;
