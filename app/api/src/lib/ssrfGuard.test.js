import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns';
import { assertPublicUrl, classifyAddress, parseIPv6, isBlockedAddress } from './ssrfGuard.js';

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

// SEC-2026-09 H-03: every test below goes through assertPublicUrl with a real URL
// string, because WHATWG URL parsing re-serialises the host (an IPv4-mapped literal
// comes out in hex form, a decimal/hex IPv4 host comes out dotted) — a unit test on
// the bare address would not exercise the spelling the guard actually receives.
describe('assertPublicUrl — alternative IP literal spellings', () => {
  const noDns = () => vi.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('DNS must not be used for a literal'));

  it.each([
    ['IPv4-mapped metadata address', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['IPv4-mapped loopback with a port', 'http://[::ffff:127.0.0.1]:3001/api/health'],
    ['IPv4-mapped, fully expanded hex form', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/'],
    ['NAT64 prefix embedding the metadata address', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['IPv4-compatible (deprecated) embedding', 'http://[::a9fe:a9fe]/'],
    ['6to4 embedding the metadata address', 'http://[2002:a9fe:a9fe::]/'],
    ['Teredo', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'],
    ['site-local', 'http://[fec0::1]/'],
    ['unique-local', 'http://[fd00:ec2::254]/'],
    ['link-local', 'http://[fe80::1]/'],
    ['unspecified', 'http://[::]/'],
    ['decimal IPv4 host', 'http://2130706433/'],
    ['hex/short IPv4 host', 'http://0x7f.1/'],
    ['octal IPv4 host', 'http://0251.0376.0251.0376/'],
  ])('rejects %s', async (_name, url) => {
    noDns();
    await expect(assertPublicUrl(url)).rejects.toThrow(/private|loopback|link-local|metadata|reserved/i);
  });

  it('keeps a public IPv6 literal and a 6to4 address embedding a public IPv4 allowed', async () => {
    noDns();
    expect((await assertPublicUrl('https://[2606:4700:4700::1111]/')).hostname).toBe('[2606:4700:4700::1111]');
    expect((await assertPublicUrl('https://[2002:808:808::]/')).hostname).toBe('[2002:808:808::]');
    expect((await assertPublicUrl('https://[64:ff9b::808:808]/')).hostname).toBe('[64:ff9b::808:808]');
  });

  it('rejects a hostname whose resolution includes an IPv4-mapped private address', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:a00:5', family: 6 },
    ]);
    await expect(assertPublicUrl('https://mixed.example/')).rejects.toThrow(/private/i);
  });
});

describe('assertPublicUrl — policy options', () => {
  it('requireHttps rejects http but still accepts https', async () => {
    await expect(assertPublicUrl('http://8.8.8.8/', { requireHttps: true })).rejects.toThrow(/must use https/i);
    expect((await assertPublicUrl('https://8.8.8.8/', { requireHttps: true })).protocol).toBe('https:');
  });

  it('allowPrivateNetwork admits private and loopback addresses (any spelling)', async () => {
    const opts = { allowPrivateNetwork: true };
    for (const url of ['http://10.1.2.3/', 'http://[::ffff:192.168.1.10]/', 'http://127.0.0.1:8080/', 'http://[fd12::3]/', 'http://[::1]/']) {
      expect((await assertPublicUrl(url, opts)).href, url).toBe(new URL(url).href);
    }
  });

  it('allowPrivateNetwork never admits link-local, metadata, or unspecified addresses', async () => {
    const opts = { allowPrivateNetwork: true };
    for (const url of ['http://169.254.169.254/', 'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://[::]/']) {
      await expect(assertPublicUrl(url, opts), url).rejects.toMatchObject({ code: 'SSRF_FORBIDDEN_ADDRESS' });
    }
  });

  it('tags a private-address refusal distinctly from a forbidden one', async () => {
    await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toMatchObject({ code: 'SSRF_PRIVATE_ADDRESS' });
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toMatchObject({ code: 'SSRF_FORBIDDEN_ADDRESS' });
  });
});

describe('classifyAddress / parseIPv6', () => {
  it('expands compressed, bracketed, zoned and dotted-tail IPv6 spellings to the same hextets', () => {
    const want = [0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe];
    for (const s of ['::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]', '0:0:0:0:0:FFFF:A9FE:A9FE', '::ffff:a9fe:a9fe%eth0']) {
      expect(parseIPv6(s), s).toEqual(want);
    }
    expect(parseIPv6('not-an-ip')).toBeNull();
    expect(parseIPv6('1.2.3.4')).toBeNull();
  });

  it('classifies each range at its boundary', () => {
    const cases = {
      '172.15.255.255': 'public', '172.16.0.0': 'private', '172.31.255.255': 'private', '172.32.0.0': 'public',
      '100.63.255.255': 'public', '100.64.0.0': 'private', '100.127.255.255': 'private', '100.128.0.0': 'public',
      '223.255.255.255': 'public', '224.0.0.0': 'forbidden', '169.253.0.1': 'public', '169.254.0.1': 'forbidden',
      '::1': 'private', '::2': 'forbidden', '1fff:ffff::1': 'forbidden', '2000::1': 'public', '3fff::1': 'public',
      '4000::1': 'forbidden', 'fbff::1': 'forbidden', 'fc00::1': 'private', 'fdff::1': 'private', 'fe7f::1': 'forbidden',
      'febf::1': 'forbidden', 'fec0::1': 'private', 'feff::1': 'private', 'ff02::1': 'forbidden',
      '2001:db8::1': 'forbidden', '2001:1::1': 'public', '2002:a00:1::': 'private', '64:ff9b::a00:1': 'private',
      '64:ff9b:1::a00:1': 'forbidden', 'example.com': 'forbidden', '': 'forbidden',
    };
    for (const [ip, cls] of Object.entries(cases)) expect(classifyAddress(ip), ip).toBe(cls);
  });

  it('isBlockedAddress blocks everything that is not public', () => {
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });
});
