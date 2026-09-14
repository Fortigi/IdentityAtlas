import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns';
import { connectorUrlPolicy, assertConnectorUrl, checkCrawlerConfigUrls } from './urlPolicy.js';

// The real manifests are used on purpose: which fields count as URLs is declared
// in crawler.json, and that declaration is part of what is under test.
afterEach(() => vi.restoreAllMocks());

const dnsError = (code) => Object.assign(new Error(`getaddrinfo ${code} host`), { code });

describe('connectorUrlPolicy', () => {
  it('defaults to https-only and public-only', () => {
    expect(connectorUrlPolicy({})).toEqual({ allowPrivateNetwork: false, requireHttps: true });
    expect(connectorUrlPolicy(null)).toEqual({ allowPrivateNetwork: false, requireHttps: true });
  });

  it('opts in only on a literal true — a truthy string does not count', () => {
    expect(connectorUrlPolicy({ allowPrivateNetwork: true, allowInsecureHttp: true })).toEqual({ allowPrivateNetwork: true, requireHttps: false });
    expect(connectorUrlPolicy({ allowPrivateNetwork: 'true', allowInsecureHttp: 1 })).toEqual({ allowPrivateNetwork: false, requireHttps: true });
  });
});

describe('assertConnectorUrl', () => {
  it('labels the field and adds the matching opt-in hint', async () => {
    await expect(assertConnectorUrl('http://8.8.8.8/', {}, 'baseUrl'))
      .rejects.toThrow('baseUrl rejected: URL must use https — enable "Allow insecure HTTP" on this crawler to permit http');
    await expect(assertConnectorUrl('https://172.16.0.1/', {}, 'tokenEndpoint'))
      .rejects.toThrow('tokenEndpoint rejected: URL host resolves to a private or loopback address — enable "Allow private network" on this crawler if it is an on-premises system');
  });

  it('offers no opt-in for a metadata address, and keeps the guard error code', async () => {
    const err = await assertConnectorUrl('https://169.254.169.254/', { allowPrivateNetwork: true }, 'baseUrl').catch(e => e);
    expect(err.message).toBe('baseUrl rejected: URL host resolves to a link-local, metadata, or reserved address');
    expect(err.code).toBe('SSRF_FORBIDDEN_ADDRESS');
  });

  it('returns the parsed URL when the policy allows it', async () => {
    const u = await assertConnectorUrl('http://10.2.3.4:8080/midpoint', { allowPrivateNetwork: true, allowInsecureHttp: true });
    expect(u.port).toBe('8080');
  });
});

describe('checkCrawlerConfigUrls', () => {
  it('checks every declared URL field and reports the first failure', async () => {
    const msg = await checkCrawlerConfigUrls('midpoint', { baseUrl: 'https://8.8.8.8/midpoint', tokenEndpoint: 'https://127.0.0.1/token' });
    expect(msg).toMatch(/^tokenEndpoint rejected: .*loopback/);
  });

  it('skips absent and blank fields, and passes a clean config', async () => {
    expect(await checkCrawlerConfigUrls('omada', { baseUrl: 'https://8.8.8.8/odata/dataobjects', tokenEndpoint: '  ' })).toBeNull();
    expect(await checkCrawlerConfigUrls('omada', null)).toBeNull();
  });

  it('ignores types that declare no URL fields, whatever their config holds', async () => {
    expect(await checkCrawlerConfigUrls('csv', { baseUrl: 'http://169.254.169.254/' })).toBeNull();
    expect(await checkCrawlerConfigUrls('no-such-type', { baseUrl: 'http://169.254.169.254/' })).toBeNull();
  });

  it('lets a hostname that does not resolve from the API through (the worker re-checks)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(dnsError('ENOTFOUND'));
    expect(await checkCrawlerConfigUrls('scim', { baseUrl: 'https://scim.example.invalid/v2' })).toBeNull();
  });

  it('still refuses an unresolvable hostname on http — the scheme check needs no DNS', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup').mockRejectedValue(dnsError('ENOTFOUND'));
    expect(await checkCrawlerConfigUrls('scim', { baseUrl: 'http://scim.example.invalid/v2' })).toMatch(/must use https/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.9.8.7', family: 4 }]);
    expect(await checkCrawlerConfigUrls('odata', { baseUrl: 'https://intranet.example/odata' })).toMatch(/^baseUrl rejected: .*private/);
  });

  it('surfaces a DNS failure that is not a plain "not found"', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(dnsError('EBADNAME'));
    expect(await checkCrawlerConfigUrls('odata', { baseUrl: 'https://bad..name/odata' })).toMatch(/^baseUrl rejected: getaddrinfo EBADNAME/);
  });

  it('refuses a malformed URL', async () => {
    expect(await checkCrawlerConfigUrls('odata', { baseUrl: 'not a url' })).toBe('baseUrl rejected: Invalid URL');
  });
});
