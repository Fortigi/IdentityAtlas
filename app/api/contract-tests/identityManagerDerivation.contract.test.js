// Contract test — the person-level manager derived from linked accounts (#1640).
// Account managers are stored correctly for every source; the identity must
// inherit the manager THROUGH the link: I ─IdentityMembers→ P ─managerId→ M
// ─IdentityMembers→ J  ⇒  I.managerIdentityId = J.
//
// Every fixture is chosen so a plausible wrong implementation gives a different
// answer: B's primary account and its HR account name different managers, the
// tie in T has two managers, E's manager is E, F's link was rejected, D's source
// named a manager the derivation would compute differently.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent; let pool; let sys; let apiKey; let deriveIdentityManagers;
const crawlerIds = [];
const run = crypto.randomBytes(4).toString('hex');
const uuid = () => crypto.randomUUID();

// Accounts (principals) and people (identities).
const P = {
  mgrHr: uuid(), mgrErp: uuid(), ghostMgr: uuid(), a: uuid(), bHr: uuid(), bErp: uuid(), c: uuid(), d: uuid(),
  e1: uuid(), e2: uuid(), f: uuid(), t1: uuid(), t2: uuid(), h: uuid(),
};
const I = { mgr: uuid(), other: uuid(), a: uuid(), b: uuid(), c: uuid(), d: uuid(), e: uuid(), f: uuid(), t: uuid(), h: uuid() };

async function createCrawler(displayName) {
  const key = `fgc_${crypto.randomBytes(24).toString('hex')}`;
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(key, salt, 64, { N: 16384, r: 8, p: 1 });
  const r = await pool.query(
    `INSERT INTO "Crawlers" ("displayName","apiKeyHash","apiKeySalt","apiKeyPrefix","systemIds","permissions","rateLimit")
     VALUES ($1,$2,$3,$4,NULL,'["ingest"]'::jsonb,10000) RETURNING id`,
    [displayName, hash, salt, key.slice(0, 8)]);
  crawlerIds.push(r.rows[0].id);
  return key;
}

async function post(path, body) {
  const res = await agent.post(`/api/ingest/${path}`).set('Authorization', `Bearer ${apiKey}`).send(body);
  if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}
const identity = async (id) =>
  (await pool.query(`SELECT "managerIdentityId", "managerIdentitySource" FROM "Identities" WHERE id = $1`, [id])).rows[0];
const managerOf = async (id) => (await identity(id)).managerIdentityId;
const user = (id, displayName, managerId) => ({ id, displayName, principalType: 'User', ...(managerId ? { managerId } : {}) });

// What the ingest wrote, before anything is adjusted by hand below.
const afterIngest = {};

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  ({ deriveIdentityManagers } = await import('../src/ingest/identityManagers.js'));
  sys = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test', $1) RETURNING id`,
    [`contract-idmgr-${run}`])).rows[0].id;
  apiKey = await createCrawler(`idmgr-${run}`);

  await post('principals', { systemId: sys, syncMode: 'delta', records: [
    user(P.mgrHr, 'Mia Manager (HR)'),
    user(P.mgrErp, 'Omar Other (ERP)'),
    user(P.ghostMgr, 'Nadia Nowhere (HR)'), // linked to no identity
    user(P.a, 'Person A (HR)', P.mgrHr),
    user(P.bHr, 'Person B (HR)', P.mgrHr),
    user(P.bErp, 'Person B (ERP)', P.mgrErp),
    user(P.c, 'Person C (HR)', P.ghostMgr),
    user(P.d, 'Person D (HR)', P.mgrErp),
    user(P.e2, 'Person E (admin)'),
    user(P.e1, 'Person E', P.e2), // E's manager account is E's own second account
    user(P.f, 'Person F', P.mgrHr),
    user(P.t1, 'Person T (one)', P.mgrHr),
    user(P.t2, 'Person T (two)', P.mgrErp),
    user(P.h, 'Person H', P.mgrHr),
  ]});
  await post('identities', { systemId: sys, syncMode: 'delta', records: [
    { id: I.mgr, displayName: 'Mia Manager' },
    { id: I.other, displayName: 'Omar Other' },
    { id: I.a, displayName: 'Person A' },
    { id: I.b, displayName: 'Person B' },
    { id: I.c, displayName: 'Person C' },
    // D's source states the person-level manager itself — must survive the derivation.
    { id: I.d, displayName: 'Person D', managerIdentityId: I.a },
    { id: I.e, displayName: 'Person E' },
    { id: I.f, displayName: 'Person F' },
    { id: I.t, displayName: 'Person T' },
    { id: I.h, displayName: 'Person H' },
  ]});
  // Posting the links is what triggers the derivation.
  await post('identity-members', { systemId: sys, syncMode: 'delta', records: [
    { identityId: I.mgr, principalId: P.mgrHr, isPrimary: true },
    { identityId: I.other, principalId: P.mgrErp, isPrimary: true },
    { identityId: I.a, principalId: P.a, isPrimary: true },
    { identityId: I.b, principalId: P.bHr, isPrimary: false },
    { identityId: I.b, principalId: P.bErp, isPrimary: true }, // deliberately primary, NOT HR
    { identityId: I.c, principalId: P.c, isPrimary: true },
    { identityId: I.d, principalId: P.d, isPrimary: true },
    { identityId: I.e, principalId: P.e1, isPrimary: true },
    { identityId: I.e, principalId: P.e2, isPrimary: false },
    { identityId: I.f, principalId: P.f, isPrimary: true },
    { identityId: I.t, principalId: P.t1, isPrimary: false },
    { identityId: I.t, principalId: P.t2, isPrimary: false },
    { identityId: I.h, principalId: P.h, isPrimary: true },
    // P.ghostMgr stays unlinked on purpose (fixture C).
  ]});
  for (const k of ['a', 'b', 'f', 'h']) afterIngest[k] = await identity(I[k]);

  // The ingest schema carries no isHrAuthoritative; the HR-anchor side sets it.
  // Stamp B's HR account the way linking would, reject F's only link the way an
  // analyst would, drop H's account manager — then derive again, as the next
  // load or linking run does.
  await pool.query(
    `UPDATE "IdentityMembers" SET "isHrAuthoritative" = true WHERE "identityId" = $1 AND "principalId" = $2`,
    [I.b, P.bHr]);
  await pool.query(
    `UPDATE "IdentityMembers" SET "analystOverride" = 'rejected' WHERE "identityId" = $1 AND "principalId" = $2`,
    [I.f, P.f]);
  await pool.query(`UPDATE "Principals" SET "managerId" = NULL WHERE id = $1`, [P.h]);
  await deriveIdentityManagers({ query: (sql, params) => pool.query(sql, params) });
});

afterAll(async () => {
  delete process.env.USE_SQL;
  if (pool) {
    await pool.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = ANY($1::uuid[])`, [Object.values(I)]);
    await pool.query(`DELETE FROM "Identities" WHERE id = ANY($1::uuid[])`, [Object.values(I)]);
    await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [sys]);
    await pool.query(`DELETE FROM "CrawlerAuditLog" WHERE "crawlerId" = ANY($1::int[])`, [crawlerIds]).catch(() => {});
    await pool.query(`DELETE FROM "Crawlers" WHERE id = ANY($1::int[])`, [crawlerIds]);
    await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sys]);
    await pool.end();
  }
});

describe('identity manager derived from linked accounts (#1640)', () => {
  it('A: the identity-members ingest itself gives the person the manager behind their account', () => {
    expect(afterIngest.a).toEqual({ managerIdentityId: I.mgr, managerIdentitySource: 'Derived' });
  });

  it('B: two accounts, different managers → the HR-authoritative account wins over the primary', async () => {
    // Before the HR flag existed, the primary account decided — and the value
    // is refreshed once the HR account is known.
    expect(afterIngest.b.managerIdentityId).toBe(I.other);
    expect(await managerOf(I.b)).toBe(I.mgr);
  });

  it("C: the manager's account is linked to no identity → stays empty, no guess", async () => {
    expect(await identity(I.c)).toEqual({ managerIdentityId: null, managerIdentitySource: null });
  });

  it('D: a manager the source sent itself is never overwritten by the derivation', async () => {
    expect(await identity(I.d)).toEqual({ managerIdentityId: I.a, managerIdentitySource: 'Source' });
  });

  it("E: an account managed by the person's own other account gives no self-manager", async () => {
    expect(await managerOf(I.e)).toBeNull();
  });

  it('F: a rejected link is not a membership — the derived manager is withdrawn', async () => {
    expect(afterIngest.f.managerIdentityId).toBe(I.mgr);
    expect(await identity(I.f)).toEqual({ managerIdentityId: null, managerIdentitySource: null });
  });

  it('T: two equally ranked accounts naming different managers → empty, not a coin toss', async () => {
    expect(await managerOf(I.t)).toBeNull();
  });

  it("H: an account that loses its manager takes the person's derived manager with it", async () => {
    expect(afterIngest.h.managerIdentityId).toBe(I.mgr);
    expect(await managerOf(I.h)).toBeNull();
  });
});
