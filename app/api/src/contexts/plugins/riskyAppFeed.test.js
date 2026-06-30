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
  it('fetches and parses into a Set of appIds', async () => {
    const f = vi.fn(async () => ({ ok: true, text: async () => CSV }));
    const s = await fetchMaliciousAppIds('http://feed', f);
    expect(s.size).toBe(3);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-ok response', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchMaliciousAppIds('http://feed', f)).rejects.toThrow(/503/);
  });
});
