// Contract test — a synced context whose owner is a DISPLAY NAME gets that
// account as its Accountable (ingest/contextOwners.js, step 4 by_name), against
// real PostgreSQL: the SQL normaliser (lib/nameMatch.js normalizedNameSql), the
// word-similarity lookup and the user-first uniqueness are only meaningful here.
// Every assertion names the account the role landed on.
//
// Isolation on the shared contract DB: one private system; everything this file
// creates is deleted in afterAll (the roles go with their contexts). Names are
// prefixed so no other file's principal can share one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { reconcileBatchAccountables } = await import('../src/ingest/contextOwners.js');

let pool;
let sys;
const C = {};
const runner = () => ({ query: (sql, params) => pool.query(sql, params) });

async function principal(displayName, principalType = 'User', deleted = false) {
  await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType", "deletedAt")
     VALUES (gen_random_uuid(), $1, gen_random_uuid()::text, $2, $3, $4)`,
    [sys, displayName, principalType, deleted ? new Date() : null]);
}

async function context(key, owner) {
  const r = await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", "ownerUserId")
     VALUES (gen_random_uuid(), 'synced', 'Principal', 'OrgUnit', $1, 'OrganizationalUnit', $2, $3) RETURNING id`,
    [`nm-${key}`, sys, owner]);
  C[key] = r.rows[0].id;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sys = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('OwnerNameTest', 'owner-names') RETURNING id`)).rows[0].id;
  await principal('Qzorra Brümmel');                       // accents
  await principal('Qzaida Example | Qz Org');              // org suffix on the account
  await principal('Qzelda Sample');                        // owner written "Sample, Qzelda"
  await principal('Qzoe Twin');                            // two users: ambiguous
  await principal('qzoe twin');
  await principal('Qzack Robot', 'ServicePrincipal');      // a user and a service principal: the user
  await principal('Qzack Robot');
  await principal('Qzeno Service', 'ServicePrincipal');    // only a service principal: that one
  await principal('Qzara Gone', 'User', true);             // only soft-deleted: nobody
  await principal('Qzimon Smith');                         // a typo is not resolved at ingest
  await principal('Qzolo');                                // a one-word owner is not a name

  await context('accents', 'Qzorra Brummel');
  await context('suffix', 'qzaida example');
  await context('lastFirst', 'Sample, Qzelda | Qz Org');
  await context('ambiguous', 'Qzoe Twin');
  await context('userFirst', 'Qzack Robot');
  await context('spOnly', 'Qzeno Service');
  await context('deleted', 'Qzara Gone');
  await context('typo', 'Qzimon Smitt');
  await context('oneWord', 'Qzolo');
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [sys]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [sys]);
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sys]);
  await pool.end();
});

const accountableCount = async () => (await pool.query(
  `SELECT count(*)::int AS n FROM "ContextRoles" r JOIN "Contexts" c ON c.id = r."contextId"
    WHERE c."scopeSystemId" = $1 AND r.role = 'Accountable'`, [sys])).rows[0].n;

describe('synced owner named by display name → Accountable', () => {
  afterAll(() => { delete process.env.FEATURE_SOURCE_OWNER_NAME_MATCH; });

  it('sets nobody by name while the "…also match by name" setting is off (the default)', async () => {
    delete process.env.FEATURE_SOURCE_OWNER_NAME_MATCH;
    const counts = await reconcileBatchAccountables(runner(), 'Contexts', Object.values(C).map(id => ({ id })));
    expect(counts).toEqual({ set: 0, replaced: 0, removed: 0, unresolved: 9 });
    expect(await accountableCount()).toBe(0);
  });

  it('resolves a unique normalised name, user accounts first, and nothing else', async () => {
    process.env.FEATURE_SOURCE_OWNER_NAME_MATCH = 'true';
    const counts = await reconcileBatchAccountables(runner(), 'Contexts', Object.values(C).map(id => ({ id })));
    const r = await pool.query(
      `SELECT c."displayName" AS c, p."displayName" AS p, p."principalType" AS t
         FROM "ContextRoles" r
         JOIN "Contexts" c ON c.id = r."contextId"
         JOIN "Principals" p ON p.id = r."principalId"
        WHERE c."scopeSystemId" = $1 AND r.role = 'Accountable'`, [sys]);
    expect(r.rows.map(x => `${x.c.slice(3)}:${x.p}:${x.t}`).sort()).toEqual([
      'accents:Qzorra Brümmel:User',
      'lastFirst:Qzelda Sample:User',
      'spOnly:Qzeno Service:ServicePrincipal',
      'suffix:Qzaida Example | Qz Org:User',
      'userFirst:Qzack Robot:User',
    ]);
    expect(counts).toEqual({ set: 5, replaced: 0, removed: 0, unresolved: 4 });
  });
});
