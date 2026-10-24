// HTTP integration test — the per-system boundary on crawler ingest
// (SEC-2026-09 C-01 / H-04), against the real app and a real PostgreSQL schema.
//
// Real crawler keys are created in the Crawlers table and sent as Bearer tokens,
// so the whole chain runs: crawler auth → envelope/record validation → the
// boundary checks in ingest/systemBoundary.js → the engine's upsert and
// reconcile. The unit tests pin which predicate each table gets; this file proves
// the SQL selects the right rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let sysA;
let sysB;
let unrestricted;
let restrictedToB;
const crawlerIds = [];
const run = crypto.randomBytes(4).toString('hex');
const tenantA = `sec-boundary-a-${run}`;
const tenantB = `sec-boundary-b-${run}`;
const tenantNew = `sec-boundary-new-${run}`;

const uuid = () => crypto.randomUUID();
const PA = uuid();   // a principal of system A
const PB = uuid();   // a principal of system B
const PB2 = uuid();  // a second principal of system B

async function createCrawler(displayName, systemIds, permissions) {
  const apiKey = `fgc_${crypto.randomBytes(24).toString('hex')}`;
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
  const r = await pool.query(
    `INSERT INTO "Crawlers" ("displayName", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "systemIds", "permissions", "rateLimit")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 10000) RETURNING id`,
    [displayName, hash, salt, apiKey.slice(0, 8), systemIds === null ? null : JSON.stringify(systemIds), JSON.stringify(permissions)]);
  crawlerIds.push(r.rows[0].id);
  return apiKey;
}

const post = (key, path, body) => agent.post(`/api/ingest/${path}`).set('Authorization', `Bearer ${key}`).send(body);
const principal = async (id) => (await pool.query(`SELECT "displayName", "deletedAt", "systemId" FROM "Principals" WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  sysA = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ('SecBoundary', 'A', $1) RETURNING id`, [tenantA])).rows[0].id;
  sysB = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ('SecBoundary', 'B', $1) RETURNING id`, [tenantB])).rows[0].id;
  await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "displayName", "principalType") VALUES ($1, $2, 'A-principal', 'User'), ($3, $4, 'B-principal', 'User'), ($5, $4, 'B-principal-2', 'User')`,
    [PA, sysA, PB, sysB, PB2]);
  unrestricted = await createCrawler(`sec-boundary-unrestricted-${run}`, null, ['ingest']);
  restrictedToB = await createCrawler(`sec-boundary-restricted-${run}`, [sysB], ['ingest']);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM "CrawlerAuditLog" WHERE "crawlerId" = ANY($1::int[])`, [crawlerIds]).catch(() => {});
    await pool.query(`DELETE FROM "Crawlers" WHERE id = ANY($1::int[])`, [crawlerIds]);
    await pool.query(`DELETE FROM "Systems" WHERE "systemType" = 'SecBoundary' AND "tenantId" LIKE $1`, [`sec-boundary-%-${run}`]);
    await pool.end();
  }
  delete process.env.USE_SQL;
});

describe('C-01 — a full sync to ingest/systems never reconciles the Systems table', () => {
  it('a one-record full sync leaves every other system (and its data) in place', async () => {
    const res = await post(unrestricted, 'systems', {
      syncMode: 'full', records: [{ systemType: 'SecBoundary', displayName: 'New', tenantId: tenantNew }],
    });
    expect(res.status).toBe(201);
    expect(res.body.deleted).toBe(0);
    const { rows } = await pool.query(`SELECT id FROM "Systems" WHERE id = ANY($1::int[])`, [[sysA, sysB]]);
    expect(rows.map(r => r.id).sort()).toEqual([sysA, sysB].sort());
    expect(await principal(PA)).toMatchObject({ systemId: sysA, deletedAt: null });
  });
});

describe('H-04 — a key restricted to system B stays inside system B', () => {
  it('refuses a record that names system A, and writes nothing', async () => {
    const id = uuid();
    const res = await post(restrictedToB, 'principals', {
      systemId: sysB, syncMode: 'delta', records: [{ id, displayName: 'forged', systemId: sysA }],
    });
    expect(res.status).toBe(403);
    expect(await principal(id)).toBeUndefined();
  });

  it('refuses to overwrite a system-A principal by id', async () => {
    const res = await post(restrictedToB, 'principals', {
      systemId: sysB, syncMode: 'delta', records: [{ id: PA, displayName: 'overwritten' }],
    });
    expect(res.status).toBe(403);
    expect(await principal(PA)).toMatchObject({ displayName: 'A-principal', systemId: sysA });
  });

  it('refuses to update system A\'s own Systems row', async () => {
    const res = await post(restrictedToB, 'systems', {
      syncMode: 'delta', records: [{ systemType: 'SecBoundary', displayName: 'renamed', tenantId: tenantA }],
    });
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT "displayName" FROM "Systems" WHERE id = $1`, [sysA]);
    expect(rows[0].displayName).toBe('A');
  });

  it('deletedIds only reach system B\'s rows', async () => {
    const res = await post(restrictedToB, 'principals', {
      systemId: sysB, syncMode: 'delta', records: [], deletedIds: [PA, PB],
    });
    expect(res.status).toBe(201);
    expect(res.body.deleted).toBe(1);
    expect((await principal(PA)).deletedAt).toBeNull();
    expect((await principal(PB)).deletedAt).not.toBeNull();
  });

  it('refuses an unscoped full sync of a table without a systemId column', async () => {
    const res = await post(restrictedToB, 'identities', {
      systemId: sysB, syncMode: 'full', records: [{ id: uuid(), displayName: 'i' }],
    });
    expect(res.status).toBe(403);
  });

  it('an in-bounds full sync reconciles system B only', async () => {
    const res = await post(restrictedToB, 'principals', {
      systemId: sysB, syncMode: 'full', scope: { principalType: 'User' },
      records: [{ id: PB, displayName: 'B-principal', principalType: 'User' }],
    });
    expect(res.status).toBe(201);
    expect((await principal(PB)).deletedAt).toBeNull();      // re-ingested → live again
    expect((await principal(PB2)).deletedAt).not.toBeNull(); // absent from B's batch
    expect((await principal(PA)).deletedAt).toBeNull();      // system A untouched
  });
});
