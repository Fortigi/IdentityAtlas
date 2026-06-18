/**
 * Tests for the Entra ID live-discovery handler (tools/crawlers/entra-id/discover.js),
 * loaded dynamically by POST /api/admin/crawlers/entra-id/discover (see
 * jobs.discover.test.js for the generic routing-layer tests). These tests call
 * the handler directly with a mocked db/getConfigSecret and a stubbed global fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from '../../../../tools/crawlers/entra-id/discover.js';

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
