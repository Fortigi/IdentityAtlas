import { describe, it, expect, vi } from 'vitest';
import { parseAppIdsCsv, fetchMaliciousAppIds } from './riskyAppFeed.js';

// Mirrors the real OAuthSentry header + a quoted-comma field + an id-less row.
const CSV = `appname,appid,metadata_category,metadata_severity,metadata_comment,metadata_reference,service
0365 Access | Mail Client,FC5D3843-D0E8-4C3F-B0EE-6D407F667751,malicious,critical,x,y,entra
Adobe,5037c1a6-7cfc-48b5-b887-f2a045937081,malicious,critical,x,y,entra
"App, Inc",aaaa1111-0000-0000-0000-000000000000,malicious,high,x,y,entra
,,malicious,low,x,y,entra`;

describe('parseAppIdsCsv', () => {
  it('extracts the appid column, lower-cased', () => {
    const s = parseAppIdsCsv(CSV);
    expect(s.has('fc5d3843-d0e8-4c3f-b0ee-6d407f667751')).toBe(true); // upper-case in source, lowered here
    expect(s.has('5037c1a6-7cfc-48b5-b887-f2a045937081')).toBe(true);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseAppIdsCsv(CSV).has('aaaa1111-0000-0000-0000-000000000000')).toBe(true);
  });

  it('skips rows without an appid', () => {
    expect(parseAppIdsCsv(CSV).has('')).toBe(false);
    expect(parseAppIdsCsv(CSV).size).toBe(3);
  });

  it('returns empty for junk / missing appid column / empty input', () => {
    expect(parseAppIdsCsv('').size).toBe(0);
    expect(parseAppIdsCsv('foo,bar\n1,2').size).toBe(0); // no 'appid' header
    expect(parseAppIdsCsv(null).size).toBe(0);
  });
});

describe('fetchMaliciousAppIds', () => {
  const allow = vi.fn(async () => {});

  it('fetches and parses into a Set of appIds, without following redirects', async () => {
    const f = vi.fn(async () => new Response(CSV));
    const s = await fetchMaliciousAppIds('https://feed.example/x.csv', f, { assertUrl: allow });
    expect(s.size).toBe(3);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][1].redirect).toBe('manual');
  });

  it('throws on a non-ok response', async () => {
    const f = vi.fn(async () => new Response('', { status: 503 }));
    await expect(fetchMaliciousAppIds('https://feed.example/x.csv', f, { assertUrl: allow })).rejects.toThrow(/returned 503/);
  });

  // SEC-2026-09 M-12: the feed URL is an admin-editable parameter.
  it('validates the URL as https-only and public BEFORE fetching, and does not fetch a refused URL', async () => {
    const f = vi.fn();
    const assertUrl = vi.fn(async () => { throw new Error('URL host resolves to a private or loopback address'); });
    await expect(fetchMaliciousAppIds('https://10.0.0.5/feed.csv', f, { assertUrl })).rejects.toThrow(/private/);
    expect(assertUrl).toHaveBeenCalledWith('https://10.0.0.5/feed.csv', { requireHttps: true });
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the real SSRF guard by default: a metadata-address or non-https feed URL is never fetched', async () => {
    const f = vi.fn();
    await expect(fetchMaliciousAppIds('https://169.254.169.254/feed.csv', f)).rejects.toThrow(/link-local|metadata/);
    await expect(fetchMaliciousAppIds('http://8.8.8.8/feed.csv', f)).rejects.toThrow(/https/);
    await expect(fetchMaliciousAppIds('data:text/csv,appid%0Ax', f)).rejects.toThrow(/https/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a redirect instead of following it', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } }));
    await expect(fetchMaliciousAppIds('https://feed.example/x.csv', f, { assertUrl: allow })).rejects.toThrow('OAuthSentry feed redirected (HTTP 302); redirects are not followed');
  });

  it('stops reading a body larger than the byte cap', async () => {
    const f = vi.fn(async () => new Response(CSV));
    const opts = { assertUrl: allow, maxBytes: CSV.length - 1 };
    await expect(fetchMaliciousAppIds('https://feed.example/x.csv', f, opts)).rejects.toThrow(/exceeded .*-byte cap/);
    const exact = { assertUrl: allow, maxBytes: Buffer.byteLength(CSV) };
    expect((await fetchMaliciousAppIds('https://feed.example/x.csv', vi.fn(async () => new Response(CSV)), exact)).size).toBe(3);
  });
});
