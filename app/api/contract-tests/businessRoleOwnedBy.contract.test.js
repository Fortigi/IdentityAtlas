// Contract test — "which business roles does this person answer for?"
// (OWNED_ROLES_SQL in src/lib/businessRoleOwners.js) against the real schema
// (migration 114's BusinessRoleOwners).
//
// The unit tests mock the database, so they cannot tell whether the statement
// picks the right rows. The cases that matter for who may sign off a role:
//   - a role held by the account, by the person (Identity), or by ANOTHER
//     account of the same person counts;
//   - a role held by somebody else does not, nor a deleted role;
//   - Accountable and Responsible on one role give one row, as Accountable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { OWNED_ROLES_SQL } from '../src/lib/businessRoleOwners.js';

let pool;
let systemId;
const id = {
  me: randomUUID(), myAdmin: randomUUID(), stranger: randomUUID(), person: randomUUID(),
  byAccount: randomUUID(), byPerson: randomUUID(), byAdmin: randomUUID(), both: randomUUID(),
  strangers: randomUUID(), deleted: randomUUID(),
};

async function role(rid, name, deleted = false) {
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","deletedAt") VALUES ($1,$2,$3,'BusinessRole',$4)`,
    [rid, systemId, name, deleted ? new Date() : null],
  );
}
async function owner(rid, holder, roleName) {
  await pool.query(
    `INSERT INTO "BusinessRoleOwners" ("resourceId","principalId","identityId","role","addedBy") VALUES ($1,$2,$3,$4,'analyst')`,
    [rid, holder.principalId ?? null, holder.identityId ?? null, roleName],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-br-owned-by') RETURNING "id"`,
  )).rows[0].id;
  for (const [pid, name] of [[id.me, 'Me'], [id.myAdmin, 'Me (admin)'], [id.stranger, 'Stranger']]) {
    await pool.query(`INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`, [pid, systemId, name]);
  }
  await pool.query(`INSERT INTO "Identities" ("id","displayName") VALUES ($1,'Me the person')`, [id.person]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2),($1,$3)`, [id.person, id.me, id.myAdmin]);

  await role(id.byAccount, 'A by account');
  await role(id.byPerson, 'B by person');
  await role(id.byAdmin, 'C by admin account');
  await role(id.both, 'D both');
  await role(id.strangers, 'E stranger');
  await role(id.deleted, 'F deleted', true);
  await owner(id.byAccount, { principalId: id.me }, 'Responsible');
  await owner(id.byPerson, { identityId: id.person }, 'Accountable');
  await owner(id.byAdmin, { principalId: id.myAdmin }, 'Responsible');
  await owner(id.both, { principalId: id.me }, 'Responsible');
  await owner(id.both, { principalId: id.myAdmin }, 'Accountable');
  await owner(id.strangers, { principalId: id.stranger }, 'Accountable');
  await owner(id.deleted, { principalId: id.me }, 'Accountable');
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [id.person]);
  await pool?.query(`DELETE FROM "Identities" WHERE "id" = $1`, [id.person]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

const owned = async (principalId, identityId) => {
  const { rows } = await pool.query(OWNED_ROLES_SQL, [principalId, identityId]);
  return rows.map(r => [r.displayName, r.role]).sort();
};

describe('OWNED_ROLES_SQL', () => {
  it('finds roles held by the account, the person and the person\'s other account — one row each, Accountable first', async () => {
    expect(await owned(id.me, id.person)).toEqual([
      ['A by account', 'Responsible'], ['B by person', 'Accountable'], ['C by admin account', 'Responsible'], ['D both', 'Accountable'],
    ]);
  });

  it('an account linked to no person finds only what names that account', async () => {
    expect(await owned(id.me, null)).toEqual([['A by account', 'Responsible'], ['D both', 'Responsible']]);
  });

  it('somebody else finds only their own role', async () => {
    expect(await owned(id.stranger, null)).toEqual([['E stranger', 'Accountable']]);
  });
});
