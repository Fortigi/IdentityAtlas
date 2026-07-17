import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns';
import { assertPublicUrl } from './ssrfGuard.js';

// isBlockedIPv4 / isBlockedAddress / pinnedSafeLookup are exercised via
// llm/scraper.test.js (which imports them from scraper.js's re-export); this
// file covers the connector-facing assertPublicUrl added for audit L-6.
afterEach(() => vi.restoreAllMocks());

describe('assertPublicUrl', () => {
  it('rejects a malformed URL and any non-http(s) scheme', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/invalid url/i);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow(/http/i);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/i);
  });

  it('rejects a literal private/loopback/link-local IP host without a DNS lookup', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/', 'https://[::1]/']) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/private|loopback|link-local/i);
    }
    expect(lookup).not.toHaveBeenCalled(); // literal IPs are checked directly
  });

  it('accepts a literal public IP host', async () => {
    const u = await assertPublicUrl('https://8.8.8.8/');
    expect(u.hostname).toBe('8.8.8.8');
  });

  it('resolves a hostname and rejects when any resolved address is non-public', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicUrl('https://internal.evil.example/')).rejects.toThrow(/private|loopback|link-local/i);
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const u = await assertPublicUrl('https://example.com/path');
    expect(u.hostname).toBe('example.com');
  });

  it('rejects when a hostname resolves to no addresses', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([]);
    await expect(assertPublicUrl('https://nowhere.example/')).rejects.toThrow(/no address/i);
  });
});
