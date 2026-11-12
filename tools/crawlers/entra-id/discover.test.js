/**
 * Tests for the Entra ID live-discovery handler (./discover.js), loaded
 * dynamically by POST /api/admin/crawlers/entra-id/discover (see
 * app/api/src/routes/jobs.discover.test.js for the generic routing-layer
 * tests). These tests call the handler directly with a mocked
 * db/getConfigSecret and a stubbed global fetch. Runs under the API's vitest
 * via app/api/vitest.config.js's include glob — see tools/crawlers/CLAUDE.md
 * → "JS/UI Testing" → "Testing a discover.js handler".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler, { nextGraphLink, managedIdentityStatus, decodeTokenClaims, permissionsFromRoles } from './discover.js';

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

// Dispatches a stubbed fetch by URL substring match. `routes` is checked in
// order; the first match wins. Anything unmatched returns a 404-ish stub so
// the discovery handler's best-effort extension-enumeration calls (which all
// `.catch(() => {})` on failure) just no-op instead of throwing.
function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    for (const [match, response] of routes) {
      if (u.includes(match)) return response;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

const TOKEN_OK = ['/oauth2/v2.0/token', { ok: true, json: async () => ({ access_token: 'tok123' }) }];

describe('entra-id discover.js handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns 400 when type is missing or unrecognised', async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res, {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/type must be/);
  });

  describe("type: 'validate'", () => {
    it('returns 400 when tenantId/clientId/clientSecret are missing', async () => {
      const { req, res } = makeReqRes({ type: 'validate', config: { tenantId: 't' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/tenantId, clientId, and clientSecret/);
    });

    it('returns valid:false when token acquisition fails', async () => {
      stubFetch([
        ['/oauth2/v2.0/token', { ok: false, json: async () => ({ error_description: 'Invalid client secret provided.\r\nTrace: abc' }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'validate', config: { tenantId: 't', clientId: 'c', clientSecret: 'wrong' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(false);
      // First line only — trace/debug text after \r\n is stripped.
      expect(res.body.error).toBe('Invalid client secret provided.');
    });

    it('reports granted permissions, including a superset alias, and leaves the rest ungranted', async () => {
      stubFetch([
        TOKEN_OK,
        ['/v1.0/organization', { ok: true, json: async () => ({ value: [{ displayName: 'Contoso' }] }) }],
        ["/v1.0/servicePrincipals(appId=", { ok: true, json: async () => ({ id: 'sp-1' }) }],
        ['/appRoleAssignments', { ok: true, json: async () => ({ value: [
          { appRoleId: 'df021288-bdef-4463-88db-98f22de89214' }, // User.Read.All — direct
          { appRoleId: 'ef5f7d5c-338f-44b0-86c3-351f46c8bb5f' }, // AccessReview.ReadWrite.All — superset alias for AccessReview.Read.All
        ] }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'validate', config: { tenantId: 't', clientId: 'c', clientSecret: 's' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.organization).toBe('Contoso');
      expect(res.body.permissions['User.Read.All']).toBe(true);
      expect(res.body.permissions['AccessReview.Read.All']).toBe(true);
      expect(res.body.permissions['Group.Read.All']).toBe(false);
      expect(res.body.objectTypes.length).toBeGreaterThan(0);
      expect(res.body.permissionObjectMap['User.Read.All']).toContain('identity');
    });

    it('follows @odata.nextLink on Graph but never hands the bearer token to another host', async () => {
      const evil = 'https://graph.microsoft.com.attacker.example/v1.0/next';
      stubFetch([
        TOKEN_OK,
        ['/v1.0/organization', { ok: true, json: async () => ({ value: [] }) }],
        ["/v1.0/servicePrincipals(appId=", { ok: true, json: async () => ({ id: 'sp-1' }) }],
        ['page=2', { ok: true, json: async () => ({ value: [{ appRoleId: 'df021288-bdef-4463-88db-98f22de89214' }], '@odata.nextLink': evil }) }],
        ['/appRoleAssignments', { ok: true, json: async () => ({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/servicePrincipals/sp-1/appRoleAssignments?page=2' }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'validate', config: { tenantId: 't', clientId: 'c', clientSecret: 's' } });
      await handler(req, res, {});
      expect(res.body.permissions['User.Read.All']).toBe(true); // page 2 was read
      expect(fetch.mock.calls.map(([u]) => String(u))).not.toContain(evil);
    });

    it('nextGraphLink keeps only https Graph links', () => {
      expect(nextGraphLink('https://graph.microsoft.com/v1.0/x?$skiptoken=1')).toBe('https://graph.microsoft.com/v1.0/x?$skiptoken=1');
      for (const bad of ['http://graph.microsoft.com/v1.0/x', 'https://graph.microsoft.com.evil.example/', 'https://evil.example/https://graph.microsoft.com/', undefined, 42]) {
        expect(nextGraphLink(bad)).toBeNull();
      }
    });

    it('falls back to permissions all-false when the appRoleAssignments lookup fails', async () => {
      stubFetch([
        TOKEN_OK,
        ['/v1.0/organization', { ok: true, json: async () => ({ value: [{ displayName: 'Contoso' }] }) }],
        ["/v1.0/servicePrincipals(appId=", { ok: false, status: 500, json: async () => ({}) }],
      ]);
      const { req, res } = makeReqRes({ type: 'validate', config: { tenantId: 't', clientId: 'c', clientSecret: 's' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.permissions['User.Read.All']).toBe(false);
    });
  });

  describe('managed identity', () => {
    // An unsigned JWT with the given claims — the handler only decodes it.
    const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    const IDENTITY_URL = 'http://127.0.0.1:41000/msi/token';
    const withIdentity = () => {
      vi.stubEnv('IDENTITY_ENDPOINT', `${IDENTITY_URL}?x=1`);
      vi.stubEnv('IDENTITY_HEADER', 'hdr-secret');
      vi.stubEnv('IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID', ' crawler-id ');
    };
    const withoutIdentity = () => {
      vi.stubEnv('IDENTITY_ENDPOINT', '');
      vi.stubEnv('IDENTITY_HEADER', '');
      vi.stubEnv('IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID', '');
    };
    const identityCall = () => fetch.mock.calls.find(([u]) => String(u).startsWith(IDENTITY_URL));

    describe('managedIdentityStatus', () => {
      const full = { IDENTITY_ENDPOINT: 'http://x', IDENTITY_HEADER: 'h', IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID: ' id ' };

      it('is available only when the endpoint, its header and a crawler identity are all there', () => {
        expect(managedIdentityStatus(full)).toEqual({ available: true, clientId: 'id' });
      });

      it.each(Object.keys(full))('is unavailable without %s — and then names no identity', (missing) => {
        expect(managedIdentityStatus({ ...full, [missing]: '' })).toEqual({ available: false, clientId: null });
      });

      it('a web app that only has its Key Vault identity does not count', () => {
        expect(managedIdentityStatus({ IDENTITY_ENDPOINT: 'http://x', IDENTITY_HEADER: 'h' }).available).toBe(false);
      });
    });

    it('decodeTokenClaims reads the payload and returns {} for anything that is not a JWT', () => {
      expect(decodeTokenClaims(jwt({ tid: 'T', roles: ['a'] }))).toEqual({ tid: 'T', roles: ['a'] });
      for (const bad of ['tok123', '', undefined, 'a.b.c']) expect(decodeTokenClaims(bad)).toEqual({});
    });

    it('permissionsFromRoles marks what the token carries, counting a ReadWrite variant as granted', () => {
      const p = permissionsFromRoles(['User.Read.All', 'Group.ReadWrite.All', 'RoleManagement.ReadWrite.Directory', 'Mail.Send']);
      expect(p['User.Read.All']).toBe(true);
      expect(p['Group.Read.All']).toBe(true);
      expect(p['RoleManagement.Read.Directory']).toBe(true);
      expect(p['Directory.Read.All']).toBe(false);
      expect(p['Mail.Send']).toBeUndefined(); // only the permissions the crawler needs are reported
      expect(Object.values(permissionsFromRoles(undefined)).every((v) => v === false)).toBe(true);
      expect(Object.keys(permissionsFromRoles(undefined)).length).toBeGreaterThan(8);
    });

    it("type 'authMethods' reports whether this deployment has a crawler identity", async () => {
      withIdentity();
      let { req, res } = makeReqRes({ type: 'authMethods' });
      await handler(req, res, {});
      expect(res.body).toEqual({ managedIdentity: { available: true, clientId: 'crawler-id' } });

      withoutIdentity();
      ({ req, res } = makeReqRes({ type: 'authMethods' }));
      await handler(req, res, {});
      expect(res.body).toEqual({ managedIdentity: { available: false, clientId: null } });
    });

    it('validate signs in through the identity endpoint, as the deployment identity, without any secret', async () => {
      withIdentity();
      stubFetch([
        [IDENTITY_URL, { ok: true, json: async () => ({ access_token: jwt({ tid: 'tenant-9', roles: ['User.Read.All', 'AccessReview.ReadWrite.All'] }) }) }],
        ['/v1.0/organization', { ok: true, json: async () => ({ value: [{ displayName: 'Contoso' }] }) }],
      ]);
      // A client ID / secret in the request must be ignored, not used.
      const { req, res } = makeReqRes({ type: 'validate', config: { authMethod: 'ManagedIdentity', clientId: 'picked-by-caller', clientSecret: 's' } });
      await handler(req, res, {});

      expect(res.body.valid).toBe(true);
      expect(res.body.authMethod).toBe('ManagedIdentity');
      expect(res.body.tenantId).toBe('tenant-9');
      expect(res.body.organization).toBe('Contoso');
      expect(res.body.permissions['User.Read.All']).toBe(true);
      expect(res.body.permissions['AccessReview.Read.All']).toBe(true);
      expect(res.body.permissions['Group.Read.All']).toBe(false);
      expect(res.body.objectTypes.length).toBeGreaterThan(0);

      const [url, init] = identityCall();
      const u = new URL(url);
      expect(u.searchParams.get('client_id')).toBe('crawler-id');
      expect(u.searchParams.get('resource')).toBe('https://graph.microsoft.com');
      expect(u.searchParams.get('api-version')).toBe('2019-08-01');
      expect(u.searchParams.get('x')).toBe('1'); // the endpoint's own query survives
      expect(init.headers['X-IDENTITY-HEADER']).toBe('hdr-secret');
      // Never falls through to the client-secret flow or the role-assignment lookup.
      const urls = fetch.mock.calls.map(([x]) => String(x));
      expect(urls.some((x) => x.includes('login.microsoftonline.com'))).toBe(false);
      expect(urls.some((x) => x.includes('appRoleAssignments'))).toBe(false);
    });

    it('validate returns valid:false, without calling anything, when the deployment has no crawler identity', async () => {
      withoutIdentity();
      stubFetch([]);
      const { req, res } = makeReqRes({ type: 'validate', config: { authMethod: 'ManagedIdentity' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toMatch(/no managed identity for crawlers/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("validate surfaces the identity endpoint's own error", async () => {
      withIdentity();
      stubFetch([[IDENTITY_URL, { ok: false, status: 400, json: async () => ({ message: 'No User Assigned or Delegated Managed Identity found for specified ClientId' }) }]]);
      const { req, res } = makeReqRes({ type: 'validate', config: { authMethod: 'ManagedIdentity' } });
      await handler(req, res, {});
      expect(res.body).toEqual({ valid: false, error: 'No User Assigned or Delegated Managed Identity found for specified ClientId' });
    });

    it('discovers attributes with the identity for an inline managed-identity config', async () => {
      withIdentity();
      stubFetch([
        [IDENTITY_URL, { ok: true, json: async () => ({ access_token: 'mi-token' }) }],
        ['/beta/users?$top=1', { ok: true, json: async () => ({ value: [{ id: 'u1', displayName: 'A' }] }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'users', config: { authMethod: 'ManagedIdentity' } });
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.sampleId).toBe('u1');
      const sample = fetch.mock.calls.find(([u]) => String(u).includes('/beta/users?$top=1'));
      expect(sample[1].headers.Authorization).toBe('Bearer mi-token');
    });

    it('a stored managed-identity config never reads a secret left in the vault', async () => {
      withIdentity();
      stubFetch([
        [IDENTITY_URL, { ok: true, json: async () => ({ access_token: 'mi-token' }) }],
        ['/beta/groups?$top=1', { ok: true, json: async () => ({ value: [{ id: 'g1' }] }) }],
      ]);
      const getConfigSecret = vi.fn().mockResolvedValue('left-over-secret');
      const db = { queryOne: vi.fn().mockResolvedValue({ config: { authMethod: 'ManagedIdentity', tenantId: 't', clientId: 'old' } }) };
      const { req, res } = makeReqRes({ type: 'groups', configId: 7 });
      await handler(req, res, { db, getConfigSecret });
      expect(res.statusCode).toBe(200);
      expect(res.body.sampleId).toBe('g1');
      expect(getConfigSecret).not.toHaveBeenCalled();
      expect(fetch.mock.calls.map(([u]) => String(u)).some((u) => u.includes('login.microsoftonline.com'))).toBe(false);
    });
  });

  describe("type: 'users' | 'groups'", () => {
    it('returns 400 when neither configId nor config is provided', async () => {
      const { req, res } = makeReqRes({ type: 'users' });
      await handler(req, res, { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/configId or config required/);
    });

    it('returns 400 when configId is not a number', async () => {
      const { req, res } = makeReqRes({ type: 'users', configId: 'abc' });
      await handler(req, res, { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/number/);
    });

    it('returns 404 when no matching config row exists', async () => {
      const { req, res } = makeReqRes({ type: 'groups', configId: 99 });
      await handler(req, res, { db: { queryOne: vi.fn().mockResolvedValue(null) }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 400 when resolved credentials are incomplete', async () => {
      const { req, res } = makeReqRes({ type: 'users', config: { tenantId: 't' } });
      await handler(req, res, { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Credentials required/);
    });

    it('discovers attributes from inline credentials (fresh-wizard mode)', async () => {
      stubFetch([
        TOKEN_OK,
        ['$top=1&$select=', { ok: true, json: async () => ({ value: [{ id: 'sample-1', displayName: 'Alice', employeeId: 'E1' }] }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'users', config: { tenantId: 't', clientId: 'c', clientSecret: 's' } });
      await handler(req, res, { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(200);
      expect(res.body.type).toBe('users');
      expect(res.body.sampleId).toBe('sample-1');
      expect(res.body.attributes).toContain('displayName');
      expect(res.body.attributes).toContain('employeeId');
    });

    // Regression test for the bug this relocation fixes: clientSecret is
    // stripped from the stored config JSON on every save (it lives only in
    // the vault), so the configId path must resolve it via getConfigSecret
    // rather than reading cfg.clientSecret (which is always undefined for a
    // real saved config — the old /admin/discover-graph-attributes route did
    // exactly that and 400'd on every edit-mode discovery attempt).
    it('resolves clientSecret via getConfigSecret when editing without re-entering the secret', async () => {
      stubFetch([
        TOKEN_OK,
        ['$top=1&$select=', { ok: true, json: async () => ({ value: [{ id: 'sample-2', mail: 'a@b.com' }] }) }],
      ]);
      const queryOne = vi.fn().mockResolvedValue({ config: { tenantId: 'tenant-1', clientId: 'client-1' } });
      const getConfigSecret = vi.fn().mockResolvedValue('vaulted-secret');
      const { req, res } = makeReqRes({ type: 'groups', configId: 5 });
      await handler(req, res, { db: { queryOne }, getConfigSecret });
      expect(getConfigSecret).toHaveBeenCalledWith(5);
      expect(res.statusCode).toBe(200);
      expect(res.body.type).toBe('groups');
      expect(res.body.sampleId).toBe('sample-2');
    });

    it('parses config stored as a JSON string (PGlite path)', async () => {
      stubFetch([
        TOKEN_OK,
        ['$top=1&$select=', { ok: true, json: async () => ({ value: [{ id: 'sample-3' }] }) }],
      ]);
      const queryOne = vi.fn().mockResolvedValue({ config: JSON.stringify({ tenantId: 't', clientId: 'c', clientSecret: 's' }) });
      const { req, res } = makeReqRes({ type: 'users', configId: 7 });
      await handler(req, res, { db: { queryOne }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when the Graph API sample call fails', async () => {
      stubFetch([
        TOKEN_OK,
        ['$top=1&$select=', { ok: false, status: 403, json: async () => ({ error: { message: 'Forbidden' } }) }],
      ]);
      const { req, res } = makeReqRes({ type: 'users', config: { tenantId: 't', clientId: 'c', clientSecret: 's' } });
      await handler(req, res, { db: { queryOne: vi.fn() }, getConfigSecret: vi.fn() });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Forbidden/);
    });
  });
});
