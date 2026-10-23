// Contract test — the context-owner reads (src/auth/contextOwner.js) against
// the real schema (migration 092's ContextRoles + ContextRelationships).
//
// The unit tests mock the database, so they cannot tell whether these
// statements pick the right rows. Here the cases that matter for access:
//   - a role held by the account, by the person (Identity), or by ANOTHER
//     account of the same person all make them an owner;
//   - a role held by somebody else does not;
//   - SameUnitAs is found from either end of the stored pair;
//   - the report-resolution check sees a context whose NAME is a held id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import {
  findHeldContexts, findSameUnitVariants, resolveReportContexts,
} from '../src/auth/contextOwner.js';

let pool;
let systemId;
const id = {
  me: randomUUID(), myAdmin: randomUUID(), stranger: randomUUID(),
  person: randomUUID(),
  ctxAccount: randomUUID(), ctxPerson: randomUUID(), ctxAdmin: randomUUID(), ctxStranger: randomUUID(),
  variantOut: randomUUID(), variantIn: randomUUID(), unrelated: randomUUID(), namedLikeId: randomUUID(),
};

async function context(ctxId, name, targetType = 'Identity') {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","contextCategory","scopeSystemId")
     VALUES ($1,'manual',$2,'Department',$3,'OrganizationalUnit',$4)`,
    [ctxId, targetType, name, systemId],
  );
}

async function role(contextId, holder, roleName) {
  await pool.query(
    `INSERT INTO "ContextRoles" ("contextId","principalId","identityId","role","addedBy") VALUES ($1,$2,$3,$4,'analyst')`,
    [contextId, holder.principalId ?? null, holder.identityId ?? null, roleName],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-context-owner') RETURNING "id"`,
  )).rows[0].id;
  for (const [pid, name] of [[id.me, 'Me'], [id.myAdmin, 'Me (admin)'], [id.stranger, 'Stranger']]) {
    await pool.query(
      `INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`,
      [pid, systemId, name],
    );
  }
  await pool.query(`INSERT INTO "Identities" ("id","displayName") VALUES ($1,'Me the person')`, [id.person]);
  await pool.query(
    `INSERT INTO "IdentityMembers" ("identityId","principalId") VALUES ($1,$2),($1,$3)`,
    [id.person, id.me, id.myAdmin],
  );

  await context(id.ctxAccount, 'B account-held');
  await context(id.ctxPerson, 'C person-held');
  await context(id.ctxAdmin, 'A admin-account-held');
  await context(id.ctxStranger, 'D stranger-held');
  await context(id.variantOut, 'B account-held', 'Resource');
  await context(id.variantIn, 'C person-held', 'Principal');
  await context(id.unrelated, 'E unrelated', 'Resource');
  await context(id.namedLikeId, id.ctxAccount, 'Resource');

  await role(id.ctxAccount, { principalId: id.me }, 'Responsible');
  await role(id.ctxAccount, { principalId: id.me }, 'Accountable');
  await role(id.ctxPerson, { identityId: id.person }, 'Responsible');
  await role(id.ctxAdmin, { principalId: id.myAdmin }, 'Responsible');
  await role(id.ctxStranger, { principalId: id.stranger }, 'Accountable');

  // Stored once per pair, in either direction.
  await pool.query(
    `INSERT INTO "ContextRelationships" ("contextId","relatedContextId","relationshipType","addedBy")
     VALUES ($1,$2,'SameUnitAs','analyst'), ($3,$4,'SameUnitAs','analyst')`,
    [id.ctxAccount, id.variantOut, id.variantIn, id.ctxPerson],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [id.person]);
  await pool?.query(`DELETE FROM "Identities" WHERE "id" = $1`, [id.person]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

describe('findHeldContexts', () => {
  it('finds roles held by the account, the person and the person\'s other account — one entry each', async () => {
    const held = await findHeldContexts(pool, id.me, id.person);
    expect(held.map(c => [c.id, c.role])).toEqual([
      [id.ctxAdmin, 'Responsible'],
      [id.ctxAccount, 'Accountable'],
      [id.ctxPerson, 'Responsible'],
    ]);
    expect(held[1]).toMatchObject({ displayName: 'B account-held', contextCategory: 'OrganizationalUnit', targetType: 'Identity' });
  });

  it('without a linked person, finds only the account\'s own roles', async () => {
    const held = await findHeldContexts(pool, id.me, null);
    expect(held.map(c => c.id)).toEqual([id.ctxAccount]);
  });

  it('finds nothing for an account that holds no role', async () => {
    const unrelatedPrincipal = randomUUID();
    expect(await findHeldContexts(pool, unrelatedPrincipal, null)).toEqual([]);
  });
});

describe('findSameUnitVariants', () => {
  it('finds the other end whichever way the pair was stored, and nothing else', async () => {
    const variants = await findSameUnitVariants(pool, [id.ctxAccount, id.ctxPerson]);
    expect(variants.sort()).toEqual([id.variantOut, id.variantIn].sort());
  });
});

describe('resolveReportContexts', () => {
  it('resolves an id to that context AND to a context named like it', async () => {
    const resolved = await resolveReportContexts(pool, [id.ctxAccount.toUpperCase()]);
    expect(resolved.sort()).toEqual([id.ctxAccount, id.namedLikeId].sort());
  });

  it('resolves a name case-insensitively, across every context of that name', async () => {
    const resolved = await resolveReportContexts(pool, ['b ACCOUNT-held']);
    expect(resolved.sort()).toEqual([id.ctxAccount, id.variantOut].sort());
  });
});
