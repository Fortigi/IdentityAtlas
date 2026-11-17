// Matrix-share recipients as a RELATIVE permission, end to end.
//
// A shared matrix is opened by a named person, under their own sign-in
// (docs/ui/sharing-a-matrix.md → "Who can open a link";
// docs/architecture/context-owner-access.md → "Relative permissions"). The share
// grants nothing by itself: the recipient still needs a role. This boots the
// real app against PostgreSQL with sign-in ON and the SHIPPED role mapping
// (Admin / RoleMiner / Servicedesk), has a RoleMiner create two shares through
// the real route, and checks what one recipient, Rita, gets:
//   - without a role: refused at the door (the no-role 403), and her visit is
//     not recorded;
//   - as Servicedesk: she opens the share addressed to her, it is recorded, and
//     she can load its matrix — but not a share addressed to somebody else, and
//     she cannot see or change who a share is for;
//   - once the sharer revokes it, the link is gone for her too.
// Only the token check and the auth configuration are replaced; the share
// lookup, the recipient match and the usage stamp are the real SQL.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

vi.mock('../src/config/authConfig.js', async (importOriginal) =>
  (await import('../test-utils/authConfigMock.js')).signInOnConfig(
    await importOriginal(),
    (await import('../src/auth/permissions.js')).SEED_ROLE_PERMISSIONS,
  ));
// The bearer token IS the claims, base64url-encoded JSON (signature checking is
// middleware/jwtValidation.test.js's job).
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      try { cb(null, JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); } catch (e) { cb(e); }
    },
  },
}));

const PREFIX = 'shrfx';
const PEOPLE = {
  sharer: { email: `sharer@${PREFIX}.test`, oid: randomUUID() },
  rita: { email: `rita@${PREFIX}.test`, oid: randomUUID() },
  sam: { email: `sam@${PREFIX}.test`, oid: randomUUID() },
};
const FILTER = { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } };

let agent;
let pool;
let shareForRita;
let shareForSam;
let savedFeatureFlag;

const as = (person, roles) => {
  const { email, oid } = PEOPLE[person];
  const claims = { oid, roles, tid: 'test-tenant', email, preferred_username: email };
  return { Authorization: `Bearer ${Buffer.from(JSON.stringify(claims)).toString('base64url')}` };
};
const resolve = (headers, id) => agent.post('/api/matrix/shares/resolve').set(headers).send({ token: id });
const visits = async (shareId, person) => (await pool.query(
  `SELECT "accessCount" FROM "MatrixShareAccesses" WHERE "shareId" = $1 AND "userKey" = $2`,
  [shareId, PEOPLE[person].email],
)).rows;

async function cleanUp() {
  await pool.query(`DELETE FROM "MatrixShares" WHERE "name" LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM "SavedMatrixFilters" WHERE "name" LIKE $1`, [`${PREFIX}%`]);
}

async function share(name, recipient) {
  const res = await agent.post('/api/matrix/shares').set(as('sharer', ['RoleMiner'])).send({
    name,
    filter: FILTER,
    recipients: [{ userKey: PEOPLE[recipient].email, principalId: PEOPLE[recipient].oid, displayName: recipient }],
  });
  // RoleMiner may share out of the box (data.share).
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  savedFeatureFlag = process.env.FEATURE_MATRIX_SHARING;
  process.env.FEATURE_MATRIX_SHARING = 'true';
  ({ agent, pool } = await bootContractApp());
  await cleanUp();
  shareForRita = await share(`${PREFIX} team access`, 'rita');
  shareForSam = await share(`${PREFIX} app owners`, 'sam');
});

afterAll(async () => {
  await cleanUp();
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
  if (savedFeatureFlag === undefined) delete process.env.FEATURE_MATRIX_SHARING;
  else process.env.FEATURE_MATRIX_SHARING = savedFeatureFlag;
});

describe('a recipient without a role', () => {
  it('cannot open the share addressed to her — the no-role 403, before any share logic', async () => {
    const res = await resolve(as('rita', []), shareForRita);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ROLE');
    expect(res.body.name).toBeUndefined();
  });

  it('is not recorded as having opened it', async () => {
    expect(await visits(shareForRita, 'rita')).toEqual([]);
  });

  it('cannot load the matrix either', async () => {
    const res = await agent.post('/api/matrix/data').set(as('rita', [])).send({ filter: FILTER });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ROLE');
  });

  it('holding a role the mapping does not know is the same as none', async () => {
    const res = await resolve(as('rita', ['NotARole']), shareForRita);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ROLE');
  });
});

describe('the same recipient as Servicedesk', () => {
  let opened;

  it('opens the share addressed to her and gets the saved matrix', async () => {
    opened = await resolve(as('rita', ['Servicedesk']), shareForRita);
    expect(opened.status).toBe(200);
    expect(opened.body.id).toBe(shareForRita);
    expect(opened.body.name).toBe(`${PREFIX} team access`);
    expect(opened.body.filter).toMatchObject(FILTER);
  });

  it('is recorded as having opened it, once', async () => {
    expect(await visits(shareForRita, 'rita')).toEqual([{ accessCount: 1 }]);
  });

  it('can load the matrix the share describes', async () => {
    const res = await agent.post('/api/matrix/data').set(as('rita', ['Servicedesk'])).send({ filter: opened.body.filter });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('cannot open a share addressed to somebody else, and that attempt is not recorded', async () => {
    const res = await resolve(as('rita', ['Servicedesk']), shareForSam);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/shared with specific people/);
    expect(res.body.name).toBeUndefined();
    expect(await visits(shareForSam, 'rita')).toEqual([]);
  });

  it('…which its own recipient can (the refusal is about the guest list, not a broken share)', async () => {
    const res = await resolve(as('sam', ['Servicedesk']), shareForSam);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(shareForSam);
  });

  it('cannot see who a share is for, nor change it (that is data.share)', async () => {
    const list = await agent.get('/api/matrix/shares').set(as('rita', ['Servicedesk']));
    expect(list.status).toBe(403);
    expect(list.body.required).toEqual(['data.share']);
    const edit = await agent.put(`/api/matrix/shares/${shareForRita}/recipients`).set(as('rita', ['Servicedesk']))
      .send({ recipients: [PEOPLE.rita.email, PEOPLE.sam.email] });
    expect(edit.status).toBe(403);
    const after = await pool.query(`SELECT "userKey" FROM "MatrixShareRecipients" WHERE "shareId" = $1`, [shareForRita]);
    expect(after.rows.map((r) => r.userKey)).toEqual([PEOPLE.rita.email]);
  });

  it('loses the share as soon as the sharer revokes it', async () => {
    const revoke = await agent.post(`/api/matrix/shares/${shareForRita}/revoke`).set(as('sharer', ['RoleMiner']));
    expect(revoke.status).toBe(200);
    const res = await resolve(as('rita', ['Servicedesk']), shareForRita);
    expect(res.status).toBe(410);
    expect(await visits(shareForRita, 'rita')).toEqual([{ accessCount: 1 }]);
  });
});
