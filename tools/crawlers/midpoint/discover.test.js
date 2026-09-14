/**
 * Tests for the midPoint live-discovery handler (./discover.js), loaded
 * dynamically by POST /api/admin/crawlers/midpoint/discover. These call the
 * handler directly with a mocked db / vault / SSRF guard and a stubbed global
 * fetch. Runs under the API's vitest — see tools/crawlers/CLAUDE.md → "JS/UI
 * Testing". Focus: the URL guard contract (SEC-2026-09 M-02 / M-03) — which URLs
 * are vetted, with which config, and that nothing is sent before they are.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './discover.js';
import { makeReqRes, ok, stubFetch } from '../shared/discoverTestKit.js';

const BASE = 'https://mp.example.com/midpoint';
const ARCHETYPES = { object: { object: [{ oid: 'a1', name: { orig: 'Business role' }, assignment: [{ assignmentRelation: [{ holderType: ['c:RoleType'] }] }] }] } };
const HAPPY_ROUTES = [
  ['/archetypes/search', ok(ARCHETYPES)],
  ['/roles/search', ok({ object: { object: [{ oid: 'r1', subtype: ['app'] }] } })],
  ['/orgs/search', ok({ object: { object: [] } })],
  ['/users/search', ok({ object: { object: [] } })],
];
const allow = () => vi.fn(async () => {});
const deps = (over = {}) => ({ db: { queryOne: vi.fn() }, getConfigSecret: vi.fn(), assertConnectorUrl: allow(), ...over });

describe('midpoint discover.js handler — URL guard', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('vets the base URL with the config (so its opt-in flags apply) and then discovers', async () => {
    stubFetch(HAPPY_ROUTES);
    const guard = allow();
    const config = { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 'tok', allowPrivateNetwork: true };
    const { req, res } = makeReqRes({ config });
    await handler(req, res, deps({ assertConnectorUrl: guard }));
    expect(guard).toHaveBeenCalledWith(BASE, config, 'baseUrl');
    expect(res.statusCode).toBe(200);
    expect(res.body.archetypes).toEqual([{ oid: 'a1', name: 'Business role', identifier: '' }]);
    expect(res.body.roleSubtypes).toEqual(['app']);
  });

  it('rejects a base URL the guard refuses, without any request going out', async () => {
    stubFetch(HAPPY_ROUTES);
    const guard = vi.fn(async () => { throw new Error('baseUrl rejected: URL must use https'); });
    const { req, res } = makeReqRes({ config: { baseUrl: 'http://mp.example.com/midpoint', authMethod: 'ApiToken', apiToken: 'tok' } });
    await handler(req, res, deps({ assertConnectorUrl: guard }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('baseUrl rejected: URL must use https');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('vets the OAuth2 ROPC token endpoint before posting the client secret and password to it', async () => {
    stubFetch([['https://idp.internal/token', ok({ access_token: 'x' })], ...HAPPY_ROUTES]);
    const guard = vi.fn(async (_url, _cfg, label) => {
      if (label === 'tokenEndpoint') throw new Error('tokenEndpoint rejected: URL host resolves to a private or loopback address');
    });
    const { req, res } = makeReqRes({ config: {
      baseUrl: BASE, authMethod: 'OAuth2ROPC', tokenEndpoint: 'https://idp.internal/token',
      clientId: 'c', clientSecret: 's', username: 'u', password: 'p',
    } });
    await handler(req, res, deps({ assertConnectorUrl: guard }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/^tokenEndpoint rejected/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the vaulted secret for a stored OAuth2 config and still vets the token endpoint', async () => {
    stubFetch([['https://idp.example.com/token', ok({ access_token: 'bearer-1' })], ...HAPPY_ROUTES]);
    const guard = allow();
    const stored = { baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp.example.com/token', clientId: 'c' };
    const db = { queryOne: vi.fn().mockResolvedValue({ config: stored }) };
    const getConfigSecret = vi.fn().mockResolvedValue('from-vault');
    const { req, res } = makeReqRes({ configId: 4 });
    await handler(req, res, deps({ db, getConfigSecret, assertConnectorUrl: guard }));
    expect(guard.mock.calls.map(c => c[2])).toEqual(['baseUrl', 'tokenEndpoint']);
    const [, tokenOpts] = fetch.mock.calls.find(([u]) => String(u).includes('/token'));
    expect(tokenOpts.body).toContain('client_secret=from-vault');
    expect(tokenOpts.redirect).toBe('manual');
    const [, searchOpts] = fetch.mock.calls.find(([u]) => String(u).includes('/archetypes/search'));
    expect(searchOpts.headers.Authorization).toBe('Bearer bearer-1');
    expect(res.statusCode).toBe(200);
  });

  it('reports a redirect instead of following it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch([['/archetypes/search', { ok: false, status: 301, json: async () => ({}) }], ...HAPPY_ROUTES]);
    const { req, res } = makeReqRes({ config: { baseUrl: BASE, authMethod: 'ApiToken', apiToken: 'tok' } });
    await handler(req, res, deps());
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain('redirect (HTTP 301)');
    const [, opts] = fetch.mock.calls[0];
    expect(opts.redirect).toBe('manual');
  });
});
