/**
 * Tests for the SCIM live-discovery handler (./discover.js), loaded dynamically
 * by POST /api/admin/crawlers/scim/discover (see app/api/src/routes/
 * jobs.discover.test.js for the generic routing-layer tests). These call the
 * handler directly with a mocked db/getConfigSecret and a stubbed global fetch.
 * Runs under the API's vitest — see tools/crawlers/CLAUDE.md → "JS/UI Testing".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler, { schemaAttributeNames, attributesForResourceType } from './discover.js';

const BASE = 'https://scim.example.com/scim/v2';

function makeReqRes(body) {
  const req = { body };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

const USER_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:User',
  name: 'User',
  attributes: [
    { name: 'userName', type: 'string' },
    { name: 'department', type: 'string' },
    { name: 'costCenter', type: 'string' },
    { name: 'emails', type: 'complex', multiValued: true },
    { name: 'name', type: 'complex', subAttributes: [{ name: 'givenName', type: 'string' }, { name: 'familyName', type: 'string' }] },
  ],
};
const GROUP_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  name: 'Group',
  attributes: [
    { name: 'displayName', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'members', type: 'complex', multiValued: true },
  ],
};
const RESOURCE_TYPES = {
  Resources: [
    { id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA.id },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA.id },
    { id: 'Device', name: 'Device', endpoint: '/Devices', schema: 'urn:example:Device' },
  ],
};

// Dispatch a stubbed fetch by URL substring; first match wins.
function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    for (const [match, response] of routes) {
      if (u.includes(match)) return response;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const HAPPY_ROUTES = [
  ['/ResourceTypes', ok(RESOURCE_TYPES)],
  ['/Schemas', ok({ Resources: [USER_SCHEMA, GROUP_SCHEMA] })],
  ['/ServiceProviderConfig', ok({ filter: { supported: true }, patch: { supported: false } })],
];

const deps = { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn(), assertPublicUrl: vi.fn().mockResolvedValue(undefined) };

describe('scim discover.js — pure schema helpers', () => {
  it('lists simple attributes and flattens complex sub-attributes, dropping core + multi-valued ones', () => {
    const names = schemaAttributeNames(USER_SCHEMA, ['id', 'userName', 'emails', 'name']);
    // userName + emails are core-excluded, emails is also multiValued, `name` is
    // core-excluded so its sub-attributes never appear.
    expect(names).toEqual(['costCenter', 'department']);
  });

  it('flattens a complex attribute that is NOT core-excluded into parent.child names', () => {
    const names = schemaAttributeNames(USER_SCHEMA, ['id', 'userName', 'emails']);
    expect(names).toEqual(['costCenter', 'department', 'name.familyName', 'name.givenName']);
  });

  it('returns an empty list for a schema with no attributes', () => {
    expect(schemaAttributeNames({ id: 'x' }, [])).toEqual([]);
    expect(schemaAttributeNames(null, [])).toEqual([]);
  });

  it('only merges the schemas a resource type actually declares', () => {
    const rt = { schema: GROUP_SCHEMA.id };
    const names = attributesForResourceType(rt, [USER_SCHEMA, GROUP_SCHEMA], ['id', 'displayName', 'members']);
    expect(names).toEqual(['description']);
    expect(names).not.toContain('department');
  });

  it('merges schema extensions on top of the base schema', () => {
    const ext = { id: 'urn:ext:Enterprise', name: 'EnterpriseUser', attributes: [{ name: 'employeeNumber', type: 'string' }] };
    const rt = { schema: USER_SCHEMA.id, schemaExtensions: [{ schema: ext.id }] };
    const names = attributesForResourceType(rt, [USER_SCHEMA, ext], ['id', 'userName', 'emails', 'name']);
    expect(names).toEqual(['costCenter', 'department', 'employeeNumber']);
  });
});

describe('scim discover.js handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 400 when neither configId nor config is supplied', async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/configId or config required/);
  });

  it('returns 400 when the config has no baseUrl', async () => {
    const { req, res } = makeReqRes({ config: { authMethod: 'ApiToken', apiToken: 't' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No baseUrl/);
  });

  it('returns 400 with the missing-credential reason before making any request', async () => {
    stubFetch(HAPPY_ROUTES);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'BasicAuth', username: 'u' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/username and password are required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a base URL the SSRF guard refuses, without fetching it', async () => {
    stubFetch(HAPPY_ROUTES);
    const { req, res } = makeReqRes({ config: { baseUrl: 'http://169.254.169.254/scim', authMethod: 'ApiToken', apiToken: 't' } });
    await handler(req, res, { ...deps, assertPublicUrl: vi.fn().mockRejectedValue(new Error('link-local address')) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/link-local address/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns resource types (flagged syncable) and per-object attribute lists', async () => {
    stubFetch(HAPPY_ROUTES);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body.resourceTypes.map(r => [r.name, r.syncable])).toEqual([['User', true], ['Group', true], ['Device', false]]);
    expect(res.body.userAttributes).toEqual(['costCenter', 'department']);
    expect(res.body.groupAttributes).toEqual(['description']);
    expect(res.body.supportsFilter).toBe(true);
    expect(res.body.supportsPatch).toBe(false);
  });

  it('sends the bearer token and asks for scim+json', async () => {
    stubFetch(HAPPY_ROUTES);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 'tok123' } });
    await handler(req, res, deps);
    const [, opts] = fetch.mock.calls.find(([u]) => String(u).includes('/ResourceTypes'));
    expect(opts.headers.Authorization).toBe('Bearer tok123');
    expect(opts.headers.Accept).toBe('application/scim+json');
  });

  it('sends a Basic header built from username:password', async () => {
    stubFetch(HAPPY_ROUTES);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'BasicAuth', username: 'alice', password: 'pw' } });
    await handler(req, res, deps);
    const [, opts] = fetch.mock.calls.find(([u]) => String(u).includes('/ResourceTypes'));
    expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('alice:pw').toString('base64'));
  });

  it('exchanges OAuth2 client credentials for a bearer token first', async () => {
    stubFetch([['https://idp/token', ok({ access_token: 'oauthtok' })], ...HAPPY_ROUTES]);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp/token', clientId: 'c', clientSecret: 's', scope: 'scim:read' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(200);
    const [, tokenOpts] = fetch.mock.calls.find(([u]) => String(u).includes('https://idp/token'));
    expect(tokenOpts.body).toContain('grant_type=client_credentials');
    expect(tokenOpts.body).toContain('scope=scim%3Aread');
    const [, rtOpts] = fetch.mock.calls.find(([u]) => String(u).includes('/ResourceTypes'));
    expect(rtOpts.headers.Authorization).toBe('Bearer oauthtok');
  });

  it('surfaces a 401 from the endpoint as a 502 with the status, never the credential', async () => {
    stubFetch([['/ResourceTypes', { ok: false, status: 401, json: async () => ({}) }]]);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 'supersecret' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/HTTP 401/);
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
  });

  it('still returns resource types when /Schemas is unavailable (best-effort)', async () => {
    stubFetch([['/ResourceTypes', ok(RESOURCE_TYPES)], ['/Schemas', { ok: false, status: 501, json: async () => ({}) }]]);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't' } });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body.resourceTypes).toHaveLength(3);
    expect(res.body.userAttributes).toEqual([]);
  });

  it('falls back to matching schemas by name when /ResourceTypes names no schema', async () => {
    stubFetch([
      ['/ResourceTypes', ok({ Resources: [{ id: 'User', name: 'User', endpoint: '/Users' }] })],
      ['/Schemas', ok({ Resources: [USER_SCHEMA, GROUP_SCHEMA] })],
    ]);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't' } });
    await handler(req, res, deps);
    expect(res.body.userAttributes).toEqual(['costCenter', 'department']);
  });

  it('edit mode loads the stored config and resolves the vaulted clientSecret', async () => {
    stubFetch([['https://idp/token', ok({ access_token: 'vaulted' })], ...HAPPY_ROUTES]);
    const db = { queryOne: vi.fn().mockResolvedValue({ config: { baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp/token', clientId: 'c' } }) };
    const getConfigSecret = vi.fn().mockResolvedValue('secret-from-vault');
    const { req, res } = makeReqRes({ configId: 7 });
    await handler(req, res, { ...deps, db, getConfigSecret });
    expect(getConfigSecret).toHaveBeenCalledWith(7);
    const [, tokenOpts] = fetch.mock.calls.find(([u]) => String(u).includes('https://idp/token'));
    expect(tokenOpts.body).toContain('client_secret=secret-from-vault');
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for an unknown configId', async () => {
    const db = { queryOne: vi.fn().mockResolvedValue(null) };
    const { req, res } = makeReqRes({ configId: 99 });
    await handler(req, res, { ...deps, db });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a non-numeric configId', async () => {
    const { req, res } = makeReqRes({ configId: 'abc' });
    await handler(req, res, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/configId must be a number/);
  });
});
