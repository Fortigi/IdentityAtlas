/**
 * Tests for the midPoint live-discovery handler (./discover.js) — the edit-mode
 * credential path. Stored configs no longer carry password / apiToken /
 * clientSecret (they are vaulted per config, SEC-2026-09 M-10), so edit mode
 * must pull them from the vault through the injected getConfigCredentials.
 * Runs under the API's vitest (app/api/vitest.config.js include glob).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './discover.js';
import { makeReqRes, ok, stubFetch } from '../shared/discoverTestKit.js';

const BASE = 'https://midpoint.example.com/midpoint';
const allowUrl = vi.fn().mockResolvedValue(undefined);
const EMPTY_SEARCH = ok({ object: { object: [] } });

function authHeaderSent() {
  const call = fetch.mock.calls.find(([u]) => String(u).includes('/archetypes/search'));
  return call[1].headers.Authorization;
}

describe('midpoint discover.js — edit mode credentials', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('merges vaulted credentials into the stored config (BasicAuth password)', async () => {
    stubFetch([['/search', EMPTY_SEARCH]]);
    const db = { queryOne: vi.fn().mockResolvedValue({ config: { baseUrl: BASE, authMethod: 'BasicAuth', username: 'administrator' } }) };
    const getConfigCredentials = vi.fn().mockResolvedValue({ password: 'vaulted-pw' });
    const { req, res } = makeReqRes({ configId: 4 });

    await handler(req, res, { db, getConfigSecret: vi.fn(), getConfigCredentials, assertPublicUrl: allowUrl });

    expect(getConfigCredentials).toHaveBeenCalledWith(4);
    expect(res.statusCode).toBe(200);
    expect(authHeaderSent()).toBe('Basic ' + Buffer.from('administrator:vaulted-pw').toString('base64'));
  });

  it('without getConfigCredentials, still resolves an OAuth2 clientSecret via getConfigSecret', async () => {
    stubFetch([['https://idp/token', ok({ access_token: 'at' })], ['/search', EMPTY_SEARCH]]);
    const db = { queryOne: vi.fn().mockResolvedValue({ config: { baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp/token', clientId: 'c' } }) };
    const getConfigSecret = vi.fn().mockResolvedValue('vaulted-secret');
    const { req, res } = makeReqRes({ configId: 5 });

    await handler(req, res, { db, getConfigSecret, assertPublicUrl: allowUrl });

    expect(getConfigSecret).toHaveBeenCalledWith(5);
    const [, tokenOpts] = fetch.mock.calls.find(([u]) => String(u).includes('https://idp/token'));
    expect(String(tokenOpts.body)).toContain('client_secret=vaulted-secret');
    expect(authHeaderSent()).toBe('Bearer at');
  });
});
