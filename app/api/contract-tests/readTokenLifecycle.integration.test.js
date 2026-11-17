// READ-TOKEN LIFECYCLE — sign-in ON, real PostgreSQL, real HTTP.
//
// The Excel Power Query workbook and BI tools reach the read API with an
// `fgr_…` read token. CI's docker stack runs with sign-in OFF, where every
// request is let in anyway, so the token path — the hash lookup in
// auth/readTokens.js, the revoked/expiry checks, and the GET-only / no-admin
// fence in middleware/auth.js — only ever ran against a mocked database. Here
// the real app runs on the contract PostgreSQL with sign-in ON; only the JWT
// signature check is replaced (claims-as-token, test-utils/signInOnLiveMapping.js)
// and the role mapping is the built-in seed.
//
// Every refusal is paired with a positive control on the same route, so a
// refusal proves the token check, not a broken route.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { bearerFor } from '../test-utils/signInOnLiveMapping.js';

vi.mock('../src/config/authConfig.js', async (importOriginal) =>
  (await import('../test-utils/signInOnLiveMapping.js')).signInOnLiveMapping(await importOriginal()));
vi.mock('jsonwebtoken', async () =>
  (await import('../test-utils/signInOnLiveMapping.js')).claimsAsTokenJwt());

const NAME_PREFIX = 'rtlife-';
const SYSTEM_NAME = 'rtlife system';

let agent;
let pool;
let systemId;

const ADMIN = () => bearerFor(['Admin'], { username: 'admin@rtlife.test' });
const ROLE_MINER = () => bearerFor(['RoleMiner'], { username: 'miner@rtlife.test' });
const SERVICEDESK = () => bearerFor(['Servicedesk']);
const asToken = (plaintext) => `Bearer ${plaintext}`;
// What ReadApiKeys stores. Computed here rather than imported: importing
// src/ before bootContractApp() would load db/connection.js ahead of DATABASE_URL.
const hashToken = (plaintext) => crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');

async function mint(name, { by = ADMIN(), expiresAt } = {}) {
  const res = await agent.post('/api/admin/read-tokens').set('Authorization', by)
    .send({ name: NAME_PREFIX + name, ...(expiresAt ? { expiresAt } : {}) });
  expect(res.status).toBe(201);
  return res.body;
}
const readSystem = (authorization) => agent.get(`/api/systems/${systemId}`).set('Authorization', authorization);
const rowOf = async (id) => (await pool.query(`SELECT * FROM "ReadApiKeys" WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  await pool.query(`DELETE FROM "ReadApiKeys" WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING id`, [SYSTEM_NAME],
  )).rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ReadApiKeys" WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
  if (systemId) await pool?.query(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool?.end();
  delete process.env.USE_SQL;
});

describe('a minted read token reads real data until it is revoked', () => {
  it('create → read the seeded system → 200 with its data', async () => {
    const { token, row } = await mint('reads');
    expect(token).toMatch(/^fgr_[A-Za-z0-9_-]{43}$/);
    expect(row.tokenPrefix).toBe(token.slice(0, 12));
    expect(row.createdBy).toBe('admin@rtlife.test');
    expect(row.revoked).toBe(false);

    const res = await readSystem(asToken(token));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(systemId);
    expect(res.body.displayName).toBe(SYSTEM_NAME);
  });

  it('a revoked token is refused on the very next request; a sibling token keeps working', async () => {
    const revoked = await mint('to-revoke');
    const sibling = await mint('sibling');
    expect((await readSystem(asToken(revoked.token))).status).toBe(200);

    const del = await agent.delete(`/api/admin/read-tokens/${revoked.row.id}`).set('Authorization', ADMIN());
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const after = await readSystem(asToken(revoked.token));
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('Invalid, revoked, or expired read API key');
    expect((await rowOf(revoked.row.id)).revoked).toBe(true);
    // Revoking one key must not take the others down with it.
    expect((await readSystem(asToken(sibling.token))).status).toBe(200);
    expect((await rowOf(sibling.row.id)).revoked).toBe(false);
  });

  it('revoking an id that does not exist is a 404, not a silent success', async () => {
    const res = await agent.delete('/api/admin/read-tokens/2147483000').set('Authorization', ADMIN());
    expect(res.status).toBe(404);
  });

  it('stamps lastUsedAt when the token is used', async () => {
    const { token, row } = await mint('stamped');
    expect((await rowOf(row.id)).lastUsedAt).toBeNull();
    expect((await readSystem(asToken(token))).status).toBe(200);
    // The stamp is fire-and-forget (lib/throttledTouch.js) — give it a moment.
    let stamped = null;
    for (let i = 0; i < 40 && !stamped; i++) {
      stamped = (await rowOf(row.id)).lastUsedAt;
      if (!stamped) await new Promise(r => setTimeout(r, 50));
    }
    expect(stamped).toBeInstanceOf(Date);
  });
});

describe('expiry is enforced by the lookup', () => {
  it('a token minted with an expiry in the past is refused', async () => {
    const { token, row } = await mint('born-expired', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(new Date(row.expiresAt).getTime()).toBeLessThan(Date.now());
    expect((await readSystem(asToken(token))).status).toBe(401);
  });

  it('a token that works until its expiry passes is refused afterwards', async () => {
    const { token, row } = await mint('expires', { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await readSystem(asToken(token))).status).toBe(200);
    await pool.query(`UPDATE "ReadApiKeys" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [row.id]);
    const res = await readSystem(asToken(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid, revoked, or expired read API key');
  });
});

describe('a read token reads; it never writes and never reaches admin surfaces', () => {
  let token;
  beforeAll(async () => { ({ token } = await mint('fence')); });

  it('a write (PUT) is refused and changes nothing — an admin may make the same write', async () => {
    const res = await agent.put(`/api/systems/${systemId}`).set('Authorization', asToken(token))
      .send({ displayName: 'renamed by a read token' });
    expect(res.status).toBe(403);
    const name = async () => (await pool.query(`SELECT "displayName" FROM "Systems" WHERE id = $1`, [systemId])).rows[0].displayName;
    expect(await name()).toBe(SYSTEM_NAME);

    const asAdmin = await agent.put(`/api/systems/${systemId}`).set('Authorization', ADMIN())
      .send({ description: 'edited by an admin' });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.description).toBe('edited by an admin');
  });

  it('cannot mint another token', async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM "ReadApiKeys"`)).rows[0].n;
    const res = await agent.post('/api/admin/read-tokens').set('Authorization', asToken(token))
      .send({ name: `${NAME_PREFIX}minted-by-token` });
    expect(res.status).toBe(403);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "ReadApiKeys"`)).rows[0].n).toBe(before);
  });

  it('cannot read an admin route, whatever the path casing', async () => {
    for (const path of ['/api/admin/read-tokens', '/api/Admin/Read-Tokens', '/api/admin/roles']) {
      const res = await agent.get(path).set('Authorization', asToken(token));
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('Read API keys cannot access admin endpoints');
    }
    expect((await agent.get('/api/admin/read-tokens').set('Authorization', ADMIN())).status).toBe(200);
  });

  it('cannot read a non-data GET route that refuses read tokens (the request log)', async () => {
    const res = await agent.get('/api/perf').set('Authorization', asToken(token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Read API keys cannot access this endpoint');
    expect((await agent.get('/api/perf').set('Authorization', ADMIN())).status).toBe(200);
  });
});

describe('unknown and malformed credentials are refused', () => {
  it('a well-formed but unknown fgr_ token → 401', async () => {
    const res = await readSystem(asToken(`fgr_${'A'.repeat(43)}`));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid, revoked, or expired read API key');
  });

  it('a real token with one character changed → 401 (the lookup is exact, not a prefix match)', async () => {
    const { token } = await mint('tampered');
    const last = token.at(-1);
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect((await readSystem(asToken(tampered))).status).toBe(401);
    expect((await readSystem(asToken(token))).status).toBe(200);
  });

  it('the stored hash itself is not a credential', async () => {
    const { token } = await mint('hash-replay');
    expect((await readSystem(asToken(hashToken(token)))).status).toBe(401);
    expect((await readSystem(asToken(`fgr_${hashToken(token)}`))).status).toBe(401);
  });

  it('a bare prefix, garbage and no header at all → 401', async () => {
    expect((await readSystem(asToken('fgr_'))).status).toBe(401);
    expect((await readSystem(asToken('not-a-token'))).status).toBe(401);
    expect((await agent.get(`/api/systems/${systemId}`)).status).toBe(401);
  });
});

describe('who may mint and list tokens, and what a listing reveals', () => {
  it('a listing never carries the secret or its hash', async () => {
    const { token, row } = await mint('listed');
    const res = await agent.get('/api/admin/read-tokens').set('Authorization', ADMIN());
    expect(res.status).toBe(200);
    const listed = res.body.find(t => t.id === row.id);
    expect(listed).toMatchObject({ name: `${NAME_PREFIX}listed`, tokenPrefix: token.slice(0, 12), revoked: false });
    expect(Object.keys(listed).sort()).toEqual(
      ['createdAt', 'createdBy', 'expiresAt', 'id', 'lastUsedAt', 'name', 'revoked', 'tokenPrefix']);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(hashToken(token));
    expect(raw).not.toContain('tokenHash');
  });

  it('a role with data.export.apikey mints its own token but may not list or revoke', async () => {
    const res = await agent.post('/api/admin/read-tokens').set('Authorization', ROLE_MINER())
      .send({ name: `${NAME_PREFIX}miner` });
    expect(res.status).toBe(201);
    expect(res.body.row.createdBy).toBe('miner@rtlife.test');
    expect((await agent.get('/api/admin/read-tokens').set('Authorization', ROLE_MINER())).status).toBe(403);
    expect((await agent.delete(`/api/admin/read-tokens/${res.body.row.id}`).set('Authorization', ROLE_MINER())).status).toBe(403);
    expect((await rowOf(res.body.row.id)).revoked).toBe(false);
  });

  it('a role without data.export.apikey may not mint', async () => {
    const res = await agent.post('/api/admin/read-tokens').set('Authorization', SERVICEDESK())
      .send({ name: `${NAME_PREFIX}desk` });
    expect(res.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM "ReadApiKeys" WHERE name = $1`, [`${NAME_PREFIX}desk`])).rowCount).toBe(0);
  });
});
