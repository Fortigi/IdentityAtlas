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

const owners = vi.hoisted(() => ({ resolveContextOwner: null, resolveReportContexts: null, descendantsInScope: null }));
vi.mock('../auth/contextOwner.js', () => ({
  resolveContextOwner: (...a) => owners.resolveContextOwner(...a),
  resolveReportContexts: (...a) => owners.resolveReportContexts(...a),
  descendantsInScope: (...a) => owners.descendantsInScope(...a),
}));

const members = vi.hoisted(() => ({ findContextMember: null }));
vi.mock('../contexts/memberReferences.js', () => ({
  findContextMember: (...a) => members.findContextMember(...a),
  loadMemberReferences: async () => ({ memberType: 'Principal', groups: [] }),
}));

vi.mock('../db/connection.js');
const { query, queryOne } = await import('../db/connection.js');
const { resetContextOwnerSettingForTests } = await import('../auth/contextOwnerSetting.js');
const { CONTEXT_OWNER_DENIED } = await import('../auth/contextOwnerScope.js');
const { NO_ROLE_CODE } = await import('./auth.js');
const { sweepRoutes, PUBLIC_ROUTES, NEVER_DATA, OWN_AUTH } = await import('../../test-utils/routeSweep.js');
const { clearOwnerAccessCache } = await import('../auth/ownerAccess/index.js');
const { TIER_SQL } = await import('../auth/ownerAccess/tiers.js');

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
const noRole = (res) => res.status === 403 && res.body?.code === NO_ROLE_CODE;
// What an owner may load whatever their scope (auth/contextOwnerScope.js): the
// app shell, and the business-role catalogue — cut to the roles they may open
// (see "reaches the business-role catalogue" below).
const OWNER_SHELL = new Set(['GET /preferences', 'GET /attribute-labels', 'GET /access-package-groups']);

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
  // MINE's sub-units are all in scope; the VARIANT has one that is not (a
  // variant does not bring its own sub-units into the scope).
  owners.descendantsInScope = vi.fn(async (_pool, ids, contextIds) =>
    ids.every(id => (id === VARIANT ? ['aaaaaaaa-0000-4000-8000-0000000000ff'] : []).every(c => contextIds.has(c))));
  members.findContextMember = vi.fn(async () => null);
});

describe('the admin switch', () => {
  it('is off by default, and an admin can turn it on and read it back', async () => {
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false, mcp: false });
    const put = await setSwitch(true);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true, mcp: false });
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: true, mcp: false });
  });

  it('needs admin.auth — a data.read user cannot read or change it', async () => {
    const reader = as(['Reader'], '44444444-4444-4444-8444-444444444444');
    expect((await request(app).get('/api/admin/context-owner-access').set(reader)).status).toBe(403);
    expect((await request(app).put('/api/admin/context-owner-access').set(reader).send({ enabled: true })).status).toBe(403);
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false, mcp: false });
  });

  it('refuses a value that is not a boolean', async () => {
    const res = await request(app).put('/api/admin/context-owner-access').set(admin).send({ enabled: 'true' });
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/admin/context-owner-access').set(admin)).body).toEqual({ enabled: false, mcp: false });
  });

  it('a context owner cannot reach it either (it is not on their list)', async () => {
    await setSwitch(true);
    expect(denied(await ownerGet('/api/admin/context-owner-access'))).toBe(true);
    expect(denied(await request(app).put('/api/admin/context-owner-access').set(as([])).send({ enabled: false }))).toBe(true);
  });
});

describe('switch off — an owner is just a caller without a role', () => {
  it('a roleless owner is refused like anyone without a role, and nobody is resolved', async () => {
    // Before F-01 they read everything here: switching owner access OFF widened it.
    expect(noRole(await ownerGet('/api/contexts'))).toBe(true);
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

  it('is refused with "no role" after the owner check finds nothing (F-01)', async () => {
    expect(noRole(await request(app).get('/api/contexts').set(stranger()))).toBe(true);
    expect(owners.resolveContextOwner).toHaveBeenCalled();
  });

  it('still gets auth-me, with nothing granted', async () => {
    const res = await request(app).get('/api/auth-me').set(stranger());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ permissions: [], hasWildcard: false, contextOwner: null });
  });

  it('keeps the AUTH_REQUIRED_ROLES 403', async () => {
    cfg.requiredRoles = ['IdentityAtlas.Read'];
    const res = await request(app).get('/api/contexts').set(stranger());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('a role that maps to data.read but is not a required role grants nothing, and auth-me says so', async () => {
    cfg.requiredRoles = ['IdentityAtlas.Read'];
    const reader = as(['Reader'], '66666666-6666-4666-8666-666666666666');
    expect((await request(app).get('/api/contexts').set(reader)).status).toBe(403);
    const me = await request(app).get('/api/auth-me').set(reader);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual([]);
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

  it('runs the unit report for their own unit, with its sub-units too, and refuses another unit', async () => {
    const unitPath = (qs) => `/api/reports/unit-members/export?format=xlsx&${qs}`;
    expect(denied(await ownerGet(unitPath(`contexts=${MINE}`)))).toBe(false);
    expect(owners.resolveReportContexts.mock.calls[0][1]).toEqual([MINE]);
    expect(owners.descendantsInScope).not.toHaveBeenCalled();
    expect(denied(await ownerGet(unitPath(`contexts=${MINE}&includeSubUnits=true`)))).toBe(false);
    expect(owners.descendantsInScope.mock.calls[0][1]).toEqual([MINE]);
    expect(denied(await ownerGet(unitPath(`contexts=${OTHER}`)))).toBe(true);
    expect(owners.resolveReportContexts).toHaveBeenCalledTimes(2);
  });

  it('refuses the unit report with sub-units of a variant whose sub-units are not in scope', async () => {
    const unitPath = `/api/reports/unit-members/export?format=xlsx&contexts=${VARIANT}&includeSubUnits=true`;
    expect(denied(await ownerGet(unitPath))).toBe(true);
    expect(denied(await ownerGet(`/api/reports/unit-members/export?format=xlsx&contexts=${VARIANT}`))).toBe(false);
  });

  it('is refused for any other report, even with their own context', async () => {
    expect(denied(await ownerGet(`/api/reports/stale-accounts/export?format=csv&contexts=${MINE}`))).toBe(true);
    expect(denied(await ownerGet(`/api/reports/application-access-review/rows?contexts=${MINE}`))).toBe(true);
  });
});

describe('switch on — the references of a member', () => {
  beforeEach(async () => { await setSwitch(true); });
  const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000004';
  const refs = (ctx) => `/api/contexts/${ctx}/members/${MEMBER}/references`;

  it('reaches them for a member of their own context, checked against THAT context', async () => {
    members.findContextMember = vi.fn(async () => ({ memberType: 'Principal' }));
    const res = await ownerGet(refs(MINE));
    expect(denied(res)).toBe(false);
    expect(members.findContextMember).toHaveBeenCalledTimes(1);
    expect(members.findContextMember.mock.calls[0].slice(1)).toEqual([MINE, MEMBER]);
  });

  it('is refused for an id that is not a member of their context (e.g. one taken from another context)', async () => {
    expect(denied(await ownerGet(refs(MINE)))).toBe(true);
    expect(members.findContextMember.mock.calls[0].slice(1)).toEqual([MINE, MEMBER]);
  });

  it('is refused for a context outside the scope, without looking the member up', async () => {
    members.findContextMember = vi.fn(async () => ({ memberType: 'Principal' }));
    expect(denied(await ownerGet(refs(OTHER)))).toBe(true);
    expect(members.findContextMember).not.toHaveBeenCalled();
  });

  it('fails closed when the member check errors', async () => {
    members.findContextMember = vi.fn(async () => { throw new Error('db down'); });
    expect((await ownerGet(refs(MINE))).status).toBe(500);
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

describe('switch on — exploring the team (detail pages, API-scoped)', () => {
  const TEAM_USER = 'cccccccc-0000-4000-8000-000000000001';
  const OUTSIDER = 'cccccccc-0000-4000-8000-000000000002';
  const HELD_GROUP = 'dddddddd-0000-4000-8000-000000000001';
  const OUTSIDER_GROUP = 'dddddddd-0000-4000-8000-000000000002';

  // The tier statements answer from these sets; every other statement as before.
  beforeEach(async () => {
    clearOwnerAccessCache();
    query.mockImplementation(async (sql, params) => {
      const ids = params?.[1] || [];
      if (sql === TIER_SQL.principal) return { rows: ids.filter(i => i === TEAM_USER).map(id => ({ id, tier: 'team' })) };
      if (sql === TIER_SQL.resource) return { rows: ids.filter(i => i === HELD_GROUP).map(id => ({ id, tier: 'held' })) };
      return { rows: [], rowCount: 0 };
    });
    await setSwitch(true);
  });

  it.each([
    `/api/user/${TEAM_USER}`,
    `/api/user/${TEAM_USER}/memberships`,
    `/api/user/${TEAM_USER}/timeline?sinceDays=90`,
    `/api/user/${TEAM_USER}/diff?at=2026-01-01`,
    `/api/org-chart/user/${TEAM_USER}/manager`,
    `/api/risk-scores/users/${TEAM_USER}`,
    `/api/resources/${HELD_GROUP}`,
    `/api/resources/${HELD_GROUP}/assignments`,
    `/api/group/${HELD_GROUP}/members`,
  ])('opens GET %s — a team member, or a resource the team holds', async (path) => {
    expect(denied(await ownerGet(path))).toBe(false);
  });

  it.each([
    `/api/user/${OUTSIDER}`,
    `/api/user/${OUTSIDER}/memberships`,
    `/api/identities/by-user/${OUTSIDER}`,
    `/api/resources/${OUTSIDER_GROUP}`,
    `/api/resources/${OUTSIDER_GROUP}/timeline`,
    `/api/user/${HELD_GROUP}`,          // a held resource's id is no principal
    `/api/resources/${TEAM_USER}`,      // and a team member's id no resource
  ])('refuses GET %s — an outsider, a resource held only by outsiders', async (path) => {
    expect(denied(await ownerGet(path))).toBe(true);
  });

  it('asks the data for the object named in the path, in its own kind', async () => {
    await ownerGet(`/api/resources/${HELD_GROUP}/business-roles`);
    const tierCalls = query.mock.calls.filter(([sql]) => sql === TIER_SQL.resource);
    expect(tierCalls).toHaveLength(1);
    expect(tierCalls[0][1]).toEqual([[MINE, VARIANT], [HELD_GROUP]]);
  });

  it.each([
    ['put', `/api/risk-scores/users/${TEAM_USER}/override`],
    ['delete', `/api/risk-scores/users/${TEAM_USER}/override`],
    ['put', `/api/identities/${TEAM_USER}/members/${TEAM_USER}/override`],
  ])('never writes on an openable object: %s %s', async (method, path) => {
    expect(denied(await request(app)[method](path).set(as([])).send({ action: 'confirmed' }))).toBe(true);
  });

  it('fails closed when the tier check errors', async () => {
    query.mockImplementation(async (sql) => {
      if (sql === TIER_SQL.principal) throw new Error('db down');
      return { rows: [] };
    });
    const res = await ownerGet(`/api/user/${TEAM_USER}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authentication service error');
  });

  it('an ordinary reader is not classified at all — not one tier query', async () => {
    await request(app).get(`/api/user/${OUTSIDER}`).set(as(['Reader'], OWNER_OID));
    expect(query.mock.calls.filter(([sql]) => Object.values(TIER_SQL).includes(sql))).toEqual([]);
  });
});

describe('switch on — the team matrix', () => {
  const OTHER_TEAM = 'aaaaaaaa-0000-4000-8000-000000000009';
  beforeEach(async () => {
    query.mockImplementation(async (sql, params) => {
      if (/FROM "Contexts" WHERE id = ANY/.test(sql)) {
        const types = { [MINE]: 'Identity', [VARIANT]: 'Resource', [OTHER_TEAM]: 'Identity' };
        return { rows: (params[0] || []).filter(i => types[i]).map(id => ({ id, targetType: types[id] })) };
      }
      return { rows: [], rowCount: 0 };
    });
    await setSwitch(true);
  });
  const post = (filter) => request(app).post('/api/matrix/data').set(as([])).send({ filter });
  const unit = (id, extra = {}) => ({ kind: 'context', contextId: id, ...extra });

  it('runs the org roll-up rooted at their own unit, checking its subtree', async () => {
    const res = await post({ subject: { include: [unit(MINE, { includeChildren: true })] }, sortHierarchy: { contextId: MINE }, rollupExpanded: [] });
    expect(denied(res)).toBe(false);
    expect(owners.descendantsInScope.mock.calls[0][1]).toEqual([MINE]);
  });

  it('runs for their own unit with its sub-units (all in scope)', async () => {
    const res = await post({ subject: { include: [unit(MINE, { includeChildren: true })] } });
    expect(denied(res)).toBe(false);
    expect(owners.descendantsInScope.mock.calls[0][1]).toEqual([MINE]);
  });

  it('runs for their own unit of people', async () => {
    const res = await post({ rowType: 'principal', orientation: 'rows-as-subjects', subject: { include: [unit(MINE)], exclude: [] } });
    expect(denied(res)).toBe(false);
    expect(res.status).toBe(200);
  });

  it.each([
    ['no subject at all', { subject: { include: [] } }],
    ['another unit', { subject: { include: [unit(OTHER_TEAM)] } }],
    ['an org roll-up rooted at another unit', { subject: { include: [unit(MINE)] }, rollupKind: 'context', rollupContextId: OTHER_TEAM }],
    ['the hierarchy sort rooted at another unit', { subject: { include: [unit(MINE)] }, sortHierarchy: { contextId: OTHER_TEAM } }],
    ['an org roll-up rooted at a variant whose sub-units are not in scope', { subject: { include: [unit(MINE)] }, sortHierarchy: { contextId: VARIANT } }],
    ['a variant with its children (its sub-units are not in scope)', { subject: { include: [unit(MINE), unit(VARIANT, { includeChildren: true })] } }],
    ['only their unit of resources', { subject: { include: [unit(VARIANT)] } }],
  ])('is refused: %s', async (_label, filter) => {
    expect(denied(await post(filter))).toBe(true);
  });

  it('no other matrix call is open to them', async () => {
    for (const path of ['/api/matrix/preview', '/api/matrix/inheritance-path', '/api/matrix/hierarchy-paths']) {
      expect(denied(await request(app).post(path).set(as([])).send({}))).toBe(true);
    }
    expect(denied(await ownerGet('/api/user-columns'))).toBe(true);
    expect(denied(await ownerGet('/api/access-package-resources'))).toBe(true);
  });

  it('reaches the business-role catalogue, cut to the roles they may open', async () => {
    const res = await ownerGet('/api/access-package-groups');
    expect(denied(res)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Whole-app sweeps (security review Nov 2026, F-01) ───────────────────────
// Every route of the real app, called as one caller. A route added tomorrow is
// swept too. Paths carry an all-zero uuid, which is in nobody's scope, so an
// owner's own context pages are not in this sweep — the tests above cover them.
describe('whole-app sweep — who reaches what without a role', () => {
  const PUBLIC = new Set([...PUBLIC_ROUTES.keys(), ...NEVER_DATA]);
  // MCP answers 404 while its feature flag is off, as it is in this suite.
  const refusedAs = (check) => (res, r) => (OWN_AUTH.has(r.key) ? [401, 403, 404].includes(res.status) : check(res));

  it('switch off: an owner is refused everywhere, like any caller without a role', async () => {
    const leaked = await sweepRoutes(app, { headers: as([]), skip: PUBLIC, refused: refusedAs(noRole) });
    expect(leaked).toEqual([]);
  });

  it('switch on: a caller who owns nothing is refused everywhere', async () => {
    await setSwitch(true);
    const stranger = as([], '55555555-5555-4555-8555-555555555555');
    const leaked = await sweepRoutes(app, { headers: stranger, skip: PUBLIC, refused: refusedAs(noRole) });
    expect(leaked).toEqual([]);
  });

  it('switch on: an owner reaches only their allow-list, and nothing outside their scope', async () => {
    await setSwitch(true);
    const leaked = await sweepRoutes(app, {
      headers: as([]),
      skip: new Set([...PUBLIC, ...OWNER_SHELL]),
      refused: refusedAs((res) => res.status === 403 || res.status === 404),
    });
    expect(leaked).toEqual([]);
  });
});
