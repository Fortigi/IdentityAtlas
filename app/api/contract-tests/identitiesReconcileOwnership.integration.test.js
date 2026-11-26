// HTTP integration test — a full identities sync reconciles ONLY the sender's
// identities (#1510), against the real app and a real PostgreSQL schema.
//
// Identities used to carry no owner, so a full sync from one source compared the
// WHOLE table against its batch: every identity another source (or an upload,
// or account linking) had created was deleted. Migration 119 gives Identities a
// nullable systemId, the ingest stamps the envelope system on every record, and
// reconcileBounds bounds the delete to `systemId = <sender>`. A row nobody has
// claimed (systemId NULL) is outside every crawler's reconcile.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let sysA;
let sysB;
let workerKey;
const run = crypto.randomBytes(4).toString('hex');
const uuid = () => crypto.randomUUID();
const IA1 = uuid();
const IA2 = uuid();
const IB1 = uuid();
const MANUAL = uuid();
const CLAIMED = uuid();
const ALL = [IA1, IA2, IB1, MANUAL, CLAIMED];

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  sysA = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId")
                            VALUES ('IdRecon', 'A', $1) RETURNING id`, [`id-recon-a-${run}`])).rows[0].id;
  sysB = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId")
                            VALUES ('IdRecon', 'B', $1) RETURNING id`, [`id-recon-b-${run}`])).rows[0].id;
  // Unrestricted key = the built-in worker's shape (systemIds NULL), the path every shipped crawler uses.
  const apiKey = `fgc_${crypto.randomBytes(24).toString('hex')}`;
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
  await pool.query(
    `INSERT INTO "Crawlers" ("displayName", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "systemIds", "permissions", "rateLimit")
     VALUES ($1, $2, $3, $4, NULL, '["ingest"]'::jsonb, 10000)`,
    [`id-recon-${run}`, hash, salt, apiKey.slice(0, 8)]);
  workerKey = apiKey;
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM "Identities" WHERE id = ANY($1::uuid[])`, [ALL]);
    await pool.query(`DELETE FROM "Crawlers" WHERE "displayName" = $1`, [`id-recon-${run}`]);
    await pool.query(`DELETE FROM "Systems" WHERE "systemType" = 'IdRecon' AND "tenantId" LIKE $1`, [`id-recon-%-${run}`]);
    await pool.end();
  }
  delete process.env.USE_SQL;
});

const post = (body) => agent.post('/api/ingest/identities').set('Authorization', `Bearer ${workerKey}`).send(body);
const live = async () => (await pool.query(
  `SELECT id FROM "Identities" WHERE id = ANY($1::uuid[])`, [ALL],
)).rows.map(r => r.id).sort();
const ownerOf = async (id) => (await pool.query(`SELECT "systemId" FROM "Identities" WHERE id = $1`, [id])).rows[0]?.systemId;

describe('a full identities sync is bounded to the sending source (#1510)', () => {
  it("source A's full sync removes only A's stale identity; B's and unclaimed identities survive", async () => {
    // An identity no sync has claimed — an upload / account-linking creation.
    await pool.query(`INSERT INTO "Identities" (id, "displayName") VALUES ($1, 'Uploaded person')`, [MANUAL]);
    // Source A owns IA1 + IA2; source B owns IB1.
    expect((await post({ systemId: sysA, syncMode: 'full',
      records: [{ id: IA1, displayName: 'A One' }, { id: IA2, displayName: 'A Two' }] })).status).toBe(201);
    expect((await post({ systemId: sysB, syncMode: 'full',
      records: [{ id: IB1, displayName: 'B One' }] })).status).toBe(201);
    // B's full sync must not have taken A's identities or the upload with it.
    expect(await live()).toEqual([IA1, IA2, IB1, MANUAL].sort());

    // A's next full sync omits IA2: IA2 goes, IA1 stays, and IB1 + MANUAL survive.
    expect((await post({ systemId: sysA, syncMode: 'full',
      records: [{ id: IA1, displayName: 'A One' }] })).status).toBe(201);
    expect(await live()).toEqual([IA1, IB1, MANUAL].sort());
    expect(await ownerOf(IA1)).toBe(sysA);
    expect(await ownerOf(IB1)).toBe(sysB);
    expect(await ownerOf(MANUAL)).toBeNull();
  });

  it('a sync claims an unowned identity it sends, and from then on reconciles it', async () => {
    await pool.query(`INSERT INTO "Identities" (id, "displayName") VALUES ($1, 'Pre-upgrade person')`, [CLAIMED]);
    expect((await post({ systemId: sysB, syncMode: 'delta',
      records: [{ id: CLAIMED, displayName: 'Pre-upgrade person' }] })).status).toBe(201);
    expect(await ownerOf(CLAIMED)).toBe(sysB);

    // Now B's: a full sync of B that omits it removes it — and still nothing of A's.
    expect((await post({ systemId: sysB, syncMode: 'full',
      records: [{ id: IB1, displayName: 'B One' }] })).status).toBe(201);
    expect(await live()).toEqual([IA1, IB1, MANUAL].sort());
  });

  it('deleting a system leaves its people in place, unowned', async () => {
    await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sysB]);
    expect(await live()).toEqual([IA1, IB1, MANUAL].sort());
    expect(await ownerOf(IB1)).toBeNull();
  });
});
