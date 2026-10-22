// Context-owner access, end to end through the real app.
//
// Real RS256 tokens (minted here against a fake JWKS, as jwtValidation.test.js
// does) go through the real authMiddleware, contextOwnerMode, allow-list and
// routers. Mocked: the auth configuration (so a test can set the role mapping
// and AUTH_REQUIRED_ROLES), who is an owner of what (auth/contextOwner.js —
// its SQL is the contract test's job), and the database.
//
// The switch itself is the real auth/contextOwnerSetting.js, flipped through
// the real admin route — so "an admin turns it on, an owner is then scoped" is
// one path, not two halves tested apart.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const TENANT = '00000000-0000-0000-0000-000000000000';
const CLIENT = '11111111-1111-1111-1111-111111111111';

const cfg = vi.hoisted(() => ({ publicKeyPem: '', enabled: true, requiredRoles: null }));
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => cfg.enabled,
  getJwksClient: () => ({ getSigningKey: (_k, cb) => cb(null, { getPublicKey: () => cfg.publicKeyPem }) }),
  getTenantId: () => TENANT,
  getClientId: () => CLIENT,
  getRequiredRoles: () => cfg.requiredRoles,
  getRolePermissions: () => ({ Admin: ['*'], Reader: ['data.read'], Empty: [] }),
  hasCustomRolePermissions: () => false,
  setRolePermissions: async () => ({}),
  loadAuthConfig: async () => {},
  reloadAuthConfig: async () => {},
  getAuthState: () => ({ enabled: cfg.enabled }),
}));

const owners = vi.hoisted(() => ({ resolveContextOwner: null, resolveReportContexts: null }));
vi.mock('../auth/contextOwner.js', () => ({
  resolveContextOwner: (...a) => owners.resolveContextOwner(...a),
  resolveReportContexts: (...a) => owners.resolveReportContexts(...a),
}));

vi.mock('../db/connection.js');
const { query, queryOne } = await import('../db/connection.js');
const { resetContextOwnerSettingForTests } = await import('../auth/contextOwnerSetting.js');
const { CONTEXT_OWNER_DENIED } = await import('../auth/contextOwnerScope.js');

const rsa = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
cfg.publicKeyPem = rsa.publicKey;

const { createApp } = await import('../app.js');
const app = createApp();

const OWNER_OID = '22222222-2222-4222-8222-222222222222';
const MINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const VARIANT = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const OWNER = {
  contexts: [{ id: MINE, displayName: 'Finance', role: 'Responsible', contextCategory: 'OrganizationalUnit', targetType: 'Identity' }],
  contextIds: new Set([MINE, VARIANT]),
};

const token = (roles = [], oid = OWNER_OID) => jwt.sign(
  { roles, tid: TENANT, oid }, rsa.privateKey,
  { algorithm: 'RS256', keyid: 'k1', audience: `api://${CLIENT}`, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, expiresIn: '5m' },
);
const as = (roles, oid) => ({ Authorization: `Bearer ${token(roles, oid)}` });
const ownerGet = (path) => request(app).get(path).set(as([]));
const admin = as(['Admin'], '33333333-3333-4333-8333-333333333333');
const setSwitch = (enabled) => request(app).put('/api/admin/context-owner-access').set(admin).send({ enabled });

const denied = (res) => res.status === 403 && res.body?.error === CONTEXT_OWNER_DENIED;

beforeEach(async () => {
  cfg.enabled = true;
  cfg.requiredRoles = null;
  delete process.env.USE_SQL;
  resetContextOwnerSettingForTests();
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  queryOne.mockResolvedValue(null);
  owners.resolveContextOwner = vi.fn(async (user) => (user.oid === OWNER_OID ? OWNER : null));
  owners.resolveReportContexts = vi.fn(async (_pool, wanted) => wanted);
});

describe('the admin switch', () => {
  it('is off by default, and an admin can turn it on and read it back', async () => {
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false });
    const put = await setSwitch(true);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true });
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: true });
  });

  it('needs admin.auth — a data.read user cannot read or change it', async () => {
    const reader = as(['Reader'], '44444444-4444-4444-8444-444444444444');
    expect((await request(app).get('/api/admin/context-owner-access').set(reader)).status).toBe(403);
    expect((await request(app).put('/api/admin/context-owner-access').set(reader).send({ enabled: true })).status).toBe(403);
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false });
  });

  it('refuses a value that is not a boolean', async () => {
    const res = await request(app).put('/api/admin/context-owner-access').set(admin).send({ enabled: 'true' });
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false });
  });

  it('a context owner cannot reach it either (it is not on their list)', async () => {
    await setSwitch(true);
    expect(denied(await ownerGet('/api/admin/context-owner-access'))).toBe(true);
    expect(denied(await request(app).put('/api/admin/context-owner-access').set(as([])).send({ enabled: false }))).toBe(true);
  });
});

describe('switch off — nothing changes', () => {
  it('a roleless owner still reads everything, as today, and nobody is resolved', async () => {
    const res = await ownerGet('/api/contexts');
    expect(res.status).not.toBe(403);
    expect(owners.resolveContextOwner).not.toHaveBeenCalled();
  });

  it('AUTH_REQUIRED_ROLES still refuses a roleless owner', async () => {
    cfg.requiredRoles = ['IdentityAtlas.Read'];
    const res = await ownerGet(`/api/contexts/${MINE}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('auth-me says contextOwner: null', async () => {
    expect((await ownerGet('/api/auth-me')).body.contextOwner).toBeNull();
  });
});

describe('switch on — a roleless caller who holds no context role', () => {
  beforeEach(async () => { await setSwitch(true); });
  const stranger = () => as([], '55555555-5555-4555-8555-555555555555');

  it('keeps today\'s roleless read access', async () => {
    const res = await request(app).get('/api/contexts').set(stranger());
    expect(res.status).not.toBe(403);
    expect(owners.resolveContextOwner).toHaveBeenCalled();
  });

  it('keeps today\'s AUTH_REQUIRED_ROLES 403', async () => {
    cfg.requiredRoles = ['IdentityAtlas.Read'];
    const res = await request(app).get('/api/contexts').set(stranger());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('gets contextOwner: null from auth-me', async () => {
    expect((await request(app).get('/api/auth-me').set(stranger())).body.contextOwner).toBeNull();
  });
});

describe('switch on — a context owner', () => {
  beforeEach(async () => { await setSwitch(true); });

  it('auth-me lists their contexts, the scope including variants, and no permissions', async () => {
    const res = await ownerGet('/api/auth-me');
    expect(res.status).toBe(200);
    expect(res.body.contextOwner).toEqual({ contexts: OWNER.contexts, contextIds: [MINE, VARIANT] });
    expect(res.body.permissions).toEqual([]);
    expect(res.body.hasWildcard).toBe(false);
  });

  it.each([
    `/api/contexts/${MINE}`,
    `/api/contexts/${MINE}/members?limit=50&offset=0`,
    `/api/contexts/${MINE}/roles`,
    `/api/contexts/${MINE}/relationships`,
    `/api/contexts/${MINE}/timeline?sinceDays=90`,
    `/api/contexts/${VARIANT}`,
    `/api/risk-scores/contexts/${MINE}`,
    '/api/preferences',
    '/api/attribute-labels',
  ])('reaches GET %s', async (path) => {
    expect(denied(await ownerGet(path))).toBe(false);
  });

  it('an allowed read is answered by its own route, not just "not refused"', async () => {
    // Without a database the relationships route answers 200 [] itself.
    const res = await ownerGet(`/api/contexts/${MINE}/relationships`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    `/api/contexts/${OTHER}`,
    `/api/contexts/${OTHER}/members`,
    `/api/contexts/${MINE}/roles/suggestion`,
    `/api/risk-scores/contexts/${OTHER}`,
    '/api/contexts',
    '/api/contexts/tree',
    '/api/matrix/data',
    '/api/users',
    '/api/permissions',
    '/api/reports',
    '/api/admin/roles',
    '/api/admin/auth-settings',
  ])('is refused GET %s', async (path) => {
    expect(denied(await ownerGet(path))).toBe(true);
  });

  it('matches the path case-insensitively, as Express routes it', async () => {
    expect(denied(await ownerGet(`/API/Contexts/${OTHER.toUpperCase()}`))).toBe(true);
    expect(denied(await ownerGet(`/API/Contexts/${MINE.toUpperCase()}`))).toBe(false);
  });

  it.each([
    ['put', `/api/contexts/${MINE}/roles`, { role: 'Accountable', principalId: OWNER_OID }],
    ['delete', `/api/contexts/${MINE}/roles/${OTHER}`, undefined],
    ['post', `/api/contexts/${MINE}/members`, { ids: [OTHER] }],
    ['patch', `/api/contexts/${MINE}`, { displayName: 'x' }],
    ['put', '/api/preferences', { visibleTabs: [] }],
  ])('is refused %s %s — owners never write', async (method, path, body) => {
    const res = await request(app)[method](path).set(as([])).send(body);
    expect(denied(res)).toBe(true);
  });

  it('decides once per request although authMiddleware runs at every mount', async () => {
    await ownerGet(`/api/contexts/${MINE}`);
    // setSwitch() in beforeEach is the admin's request: it never reaches the resolver.
    expect(owners.resolveContextOwner).toHaveBeenCalledTimes(1);
  });

  it('is scoped the same way when their mapped role grants nothing ("Empty" → [])', async () => {
    expect(denied(await request(app).get('/api/users').set(as(['Empty'])))).toBe(true);
  });

  it('with AUTH_REQUIRED_ROLES set, is let in to their own context instead of the 403', async () => {
    cfg.requiredRoles = ['IdentityAtlas.Read'];
    expect(denied(await ownerGet(`/api/contexts/${MINE}`))).toBe(false);
    expect((await ownerGet(`/api/contexts/${MINE}`)).status).not.toBe(403);
    expect(denied(await ownerGet('/api/users'))).toBe(true);
  });

  it('fails closed (500, not the roleless read-everything path) when resolving fails', async () => {
    owners.resolveContextOwner = vi.fn(async () => { throw new Error('db down'); });
    const res = await ownerGet('/api/users');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authentication service error');
  });
});

describe('switch on — the report download', () => {
  beforeEach(async () => { await setSwitch(true); });
  const exportPath = (qs) => `/api/reports/application-access-review/export?format=xlsx&${qs}`;

  it('runs for a variant of their context and checks what it resolves to', async () => {
    const res = await ownerGet(exportPath(`contexts=${VARIANT}`));
    expect(denied(res)).toBe(false);
    expect(owners.resolveReportContexts).toHaveBeenCalledTimes(1);
    expect(owners.resolveReportContexts.mock.calls[0][1]).toEqual([VARIANT]);
  });

  it('is refused when an in-scope id also resolves to a context outside the scope', async () => {
    // e.g. another context whose NAME is that id — the report matches names too.
    owners.resolveReportContexts = vi.fn(async () => [VARIANT, OTHER]);
    expect(denied(await ownerGet(exportPath(`contexts=${VARIANT}`)))).toBe(true);
  });

  it.each([
    [`contexts=${OTHER}`, 'an out-of-scope id'],
    [`contexts=${MINE},${OTHER}`, 'a mix of in- and out-of-scope ids'],
    [`contexts=${MINE}&contexts=${OTHER}`, 'a repeated parameter with one out of scope'],
    ['contexts=Finance', 'a context name (even of their own context)'],
    [`applications=${MINE}`, 'the older applications alias'],
    [`contexts=${MINE}&applications=${OTHER}`, 'the alias beside an in-scope value'],
    ['', 'no context at all'],
  ])('is refused for %s (%s)', async (qs) => {
    expect(denied(await ownerGet(exportPath(qs)))).toBe(true);
    expect(owners.resolveReportContexts).not.toHaveBeenCalled();
  });

  it('runs the unit report for their own unit, and refuses it with sub-units or for another unit', async () => {
    const unitPath = (qs) => `/api/reports/unit-members/export?format=xlsx&${qs}`;
    expect(denied(await ownerGet(unitPath(`contexts=${MINE}`)))).toBe(false);
    expect(owners.resolveReportContexts.mock.calls[0][1]).toEqual([MINE]);
    expect(denied(await ownerGet(unitPath(`contexts=${MINE}&includeSubUnits=true`)))).toBe(true);
    expect(denied(await ownerGet(unitPath(`contexts=${OTHER}`)))).toBe(true);
    expect(owners.resolveReportContexts).toHaveBeenCalledTimes(1);
  });

  it('is refused for any other report, even with their own context', async () => {
    expect(denied(await ownerGet(`/api/reports/stale-accounts/export?format=csv&contexts=${MINE}`))).toBe(true);
    expect(denied(await ownerGet(`/api/reports/application-access-review/rows?contexts=${MINE}`))).toBe(true);
  });
});

describe('unaffected callers', () => {
  beforeEach(async () => { await setSwitch(true); });

  it('a caller with real permissions is never resolved and is not scoped', async () => {
    const res = await request(app).get('/api/contexts').set(as(['Reader'], OWNER_OID));
    expect(denied(res)).toBe(false);
    expect(owners.resolveContextOwner).not.toHaveBeenCalled();
    expect((await request(app).get('/api/auth-me').set(as(['Reader'], OWNER_OID))).body.contextOwner).toBeNull();
  });

  it('with auth disabled nobody is resolved or scoped', async () => {
    cfg.enabled = false;
    const res = await request(app).get('/api/contexts');
    expect(denied(res)).toBe(false);
    expect(owners.resolveContextOwner).not.toHaveBeenCalled();
    expect((await request(app).get('/api/auth-me')).body.contextOwner).toBeNull();
  });
});
