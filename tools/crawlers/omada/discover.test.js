/**
 * Tests for the Omada live-discovery handler (./discover.js), loaded
 * dynamically by POST /api/admin/crawlers/omada/discover (see
 * app/api/src/routes/jobs.discover.test.js for the generic routing-layer
 * tests). These tests call the handler directly with a mocked db and a
 * stubbed global fetch. Runs under the API's vitest via
 * app/api/vitest.config.js's include glob — see tools/crawlers/CLAUDE.md →
 * "JS/UI Testing" → "Testing a discover.js handler".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './discover.js';

// SSRF-guard stubs the route injects in production (app/api/src/lib/ssrfGuard.js).
const allowUrl = async () => {};
const blockUrl = async () => { throw new Error('URL host resolves to a private, loopback, or link-local address'); };

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

const SAMPLE_XML = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Identity">
        <Property Name="Id"/>
        <Property Name="Username"/>
        <NavigationProperty Name="Groups"/>
      </EntityType>
      <EntityContainer>
        <EntitySet Name="Users"/>
        <EntitySet Name="Roles"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('omada discover.js handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 400 when neither configId nor inline config is provided', async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/configId or config required/);
  });

  it('returns 400 when configId is not a number', async () => {
    const { req, res } = makeReqRes({ configId: 'abc' });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('returns 404 when no matching row exists', async () => {
    const { req, res } = makeReqRes({ configId: 99 });
    await handler(req, res, { db: { queryOne: vi.fn().mockResolvedValue(null) }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('parses entitySets and identityProperties from metadata XML', async () => {
    const queryOne = vi.fn().mockResolvedValue({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'FormCookie' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const { req, res } = makeReqRes({ configId: 1 });
    await handler(req, res, { db: { queryOne }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(200);
    expect(res.body.entitySets).toEqual(['Roles', 'Users']);
    expect(res.body.identityProperties).toEqual(['Groups', 'Id', 'Username']);
  });

  it('parses config stored as a JSON string (PGlite path)', async () => {
    const queryOne = vi.fn().mockResolvedValue({ config: JSON.stringify({ baseUrl: 'https://omada.example.com/odata/dataobjects' }) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const { req, res } = makeReqRes({ configId: 2 });
    await handler(req, res, { db: { queryOne }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(200);
  });

  it('accepts inline config object (new-crawler wizard mode, no configId)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const { req, res } = makeReqRes({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'FormCookie' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(200);
    expect(res.body.entitySets).toEqual(['Roles', 'Users']);
  });

  // SEC-2026-09 M-10: stored configs no longer carry the credential fields.
  it('edit mode merges vaulted credentials into the stored config before fetching $metadata', async () => {
    const queryOne = vi.fn().mockResolvedValue({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'ApiToken' } });
    const getConfigCredentials = vi.fn().mockResolvedValue({ apiToken: 'vaulted-token' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => SAMPLE_XML });
    vi.stubGlobal('fetch', fetchMock);

    const { req, res } = makeReqRes({ configId: 3 });
    await handler(req, res, { db: { queryOne }, getConfigCredentials, assertConnectorUrl: allowUrl });

    expect(getConfigCredentials).toHaveBeenCalledWith(3);
    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer vaulted-token' });
  });

  it('returns 400 when config has no baseUrl', async () => {
    const queryOne = vi.fn().mockResolvedValue({ config: { authMethod: 'FormCookie' } });
    const { req, res } = makeReqRes({ configId: 1 });
    await handler(req, res, { db: { queryOne }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/baseUrl/);
  });

  it('returns 502 when the Omada server returns a non-2xx status', async () => {
    const queryOne = vi.fn().mockResolvedValue({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const { req, res } = makeReqRes({ configId: 1 });
    await handler(req, res, { db: { queryOne }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/401/);
  });

  it('returns 400 when baseUrl uses a non-http/https scheme', async () => {
    const { req, res } = makeReqRes({ config: { baseUrl: 'ftp://evil.com/odata/dataobjects', authMethod: 'ApiToken', apiToken: 'tok' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/http/);
  });

  it('rejects a baseUrl that resolves to a private/metadata address before fetching (SSRF, L-6)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { req, res } = makeReqRes({ config: { baseUrl: 'http://169.254.169.254/odata/dataobjects', authMethod: 'ApiToken', apiToken: 'tok' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: blockUrl });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/rejected|private|loopback|link-local/i);
    // The credentialed request must never go out.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes the base URL origin AND the config to the guard, so the opt-in flags are honoured', async () => {
    const guard = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => SAMPLE_XML }));
    const config = { baseUrl: 'http://omada.corp.local:8080/odata/dataobjects', authMethod: 'FormCookie', allowPrivateNetwork: true, allowInsecureHttp: true };
    const { req, res } = makeReqRes({ config });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: guard });
    expect(guard).toHaveBeenCalledWith('http://omada.corp.local:8080', config, 'baseUrl');
    expect(res.statusCode).toBe(200);
  });

  // SEC-2026-09 M-02: a public base URL must not be able to bounce the
  // credentialed request on to an internal address.
  it('does not follow a redirect from the metadata endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 302, type: 'basic', text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
    const { req, res } = makeReqRes({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'ApiToken', apiToken: 'tok' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('manual');
    expect(res.statusCode).toBe(502);
  });

  // SEC-2026-09 I-05: error detail stays in the server log.
  it('returns a fixed message, not the transport error text, when the server is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.20.30.40:443')));
    const { req, res } = makeReqRes({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Could not reach the Omada $metadata endpoint' });
  });

  it('returns a fixed message, not the exception text, on an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => { throw new Error('socket hang up at 10.20.30.40'); } }));
    const { req, res } = makeReqRes({ config: { baseUrl: 'https://omada.example.com/odata/dataobjects' } });
    await handler(req, res, { db: { queryOne: vi.fn() }, assertConnectorUrl: allowUrl });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch Omada metadata' });
  });
});
