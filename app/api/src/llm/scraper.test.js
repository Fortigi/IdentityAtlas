// Tests for the SSRF-hardened URL scraper (security finding H-06).
// node:http/https and node:dns are mocked so everything is deterministic and
// no real network/DNS is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

// Mocked DNS: tests set `dnsResult` to control what a hostname resolves to.
const h = vi.hoisted(() => ({ dnsResult: null, dnsErr: null, responder: null, calls: [] }));

vi.mock('node:dns', () => ({
  default: {
    lookup: (hostname, _opts, cb) => {
      if (h.dnsErr) return cb(h.dnsErr);
      cb(null, h.dnsResult || [{ address: '93.184.216.34', family: 4 }]);
    },
  },
}));

// Mocked http(s).request: returns a fake req; on end(), invokes the callback
// with the response produced by h.responder(urlObj, opts) (lets tests drive
// status/headers/body and multi-hop redirects).
function makeRequestMock() {
  return (urlObj, opts, cb) => {
    h.calls.push({ url: urlObj.href ?? String(urlObj), headers: opts.headers });
    const req = new EventEmitter();
    req.end = () => { Promise.resolve().then(() => cb(h.responder(urlObj, opts, h.calls.length))); };
    req.destroy = () => {};
    return req;
  };
}
vi.mock('node:https', () => ({ request: makeRequestMock() }));
vi.mock('node:http', () => ({ request: makeRequestMock() }));

const { scrapeOne, buildLLMContextFromScrapes, isBlockedIPv4, isBlockedAddress, validateScrapeUrl, pinnedSafeLookup, isRedirectResponse, isSupportedContentType, extractText } = await import('./scraper.js');

function res({ statusCode = 200, headers = { 'content-type': 'text/html' }, body = '' }) {
  const r = Readable.from([Buffer.from(body, 'utf8')]);
  r.statusCode = statusCode;
  r.headers = headers;
  return r;
}

beforeEach(() => {
  h.dnsResult = null; h.dnsErr = null; h.responder = null; h.calls = [];
});

describe('address classifier', () => {
  it('blocks loopback / private / link-local / CGNAT / multicast IPv4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0']) {
      expect(isBlockedIPv4(ip), ip).toBe(true);
    }
  });
  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1']) expect(isBlockedIPv4(ip), ip).toBe(false);
  });
  it('blocks loopback / link-local / ULA / IPv4-mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false); // public v6
  });
});

describe('validateScrapeUrl', () => {
  it('rejects non-http(s) protocols', () => {
    expect(() => validateScrapeUrl('file:///etc/passwd')).toThrow(/http/i);
    expect(() => validateScrapeUrl('ftp://host/x')).toThrow(/http/i);
  });
  it('rejects literal private/loopback/metadata IP hosts', () => {
    for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://[::1]/']) {
      expect(() => validateScrapeUrl(u), u).toThrow(/private|loopback|link-local/i);
    }
  });
  it('accepts public hosts', () => {
    expect(validateScrapeUrl('https://example.com/x').hostname).toBe('example.com');
  });
});

describe('pinnedSafeLookup (DNS-rebinding guard)', () => {
  it('refuses if ANY resolved address is non-public', async () => {
    h.dnsResult = [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    const err = await new Promise((resolve) => pinnedSafeLookup('evil.example', {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/non-public/);
  });
  it('returns a validated address when all are public', async () => {
    h.dnsResult = [{ address: '93.184.216.34', family: 4 }];
    const out = await new Promise((resolve) => pinnedSafeLookup('example.com', {}, (e, addr, fam) => resolve({ e, addr, fam })));
    expect(out.e).toBeFalsy();
    expect(out.addr).toBe('93.184.216.34');
    expect(out.fam).toBe(4);
  });
});

describe('scrapeOne — request/response handling', () => {
  it('rejects a malformed URL', async () => {
    const r = await scrapeOne('not a url');
    expect(r.ok).toBe(false);
  });

  it('blocks a literal private IP without making a request', async () => {
    const r = await scrapeOne('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private|loopback|link-local/i);
    expect(h.calls).toHaveLength(0); // never attempted a connection
  });

  it('strips HTML and returns text', async () => {
    h.responder = () => res({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<h1>Hello</h1><script>alert(1)</script><p>World</p>' });
    const r = await scrapeOne('https://example.com');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Hello');
    expect(r.text).toContain('World');
    expect(r.text).not.toContain('alert');
  });

  it('attaches Basic / Bearer auth to the request', async () => {
    h.responder = () => res({ headers: { 'content-type': 'text/plain' }, body: 'ok' });
    await scrapeOne('https://wiki/internal', { username: 'user', password: 'pass' });
    expect(Buffer.from(h.calls[0].headers.Authorization.slice(6), 'base64').toString()).toBe('user:pass');
    h.calls = [];
    await scrapeOne('https://api/v1', { bearer: 'token123' });
    expect(h.calls[0].headers.Authorization).toBe('Bearer token123');
  });

  it('reports HTTP errors without throwing', async () => {
    h.responder = () => res({ statusCode: 403 });
    const r = await scrapeOne('https://x.example');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 403/);
  });

  it('rejects unsupported content types', async () => {
    h.responder = () => res({ headers: { 'content-type': 'image/png' }, body: 'bin' });
    const r = await scrapeOne('https://x.example/img.png');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unsupported content-type/);
  });

  it('follows a redirect but BLOCKS one pointing at a private address', async () => {
    h.responder = (urlObj, _o, n) =>
      n === 1
        ? res({ statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
        : res({ body: 'should not get here' });
    const r = await scrapeOne('https://public.example/start');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Blocked redirect/);
    expect(h.calls).toHaveLength(1); // never connected to the metadata host
  });

  it('does NOT forward the Authorization header across a cross-origin redirect', async () => {
    h.responder = (urlObj, _o, n) =>
      n === 1
        ? res({ statusCode: 302, headers: { location: 'https://other.example/landing' } })
        : res({ headers: { 'content-type': 'text/plain' }, body: 'ok' });
    const r = await scrapeOne('https://first.example/x', { bearer: 'secret-token' });
    expect(r.ok).toBe(true);
    expect(h.calls[0].headers.Authorization).toBe('Bearer secret-token'); // sent to original origin
    expect(h.calls[1].headers.Authorization).toBeUndefined();             // NOT sent to the redirect target
  });
});

describe('isRedirectResponse', () => {
  it('is true only for a redirect code carrying a Location header', () => {
    for (const code of [301, 302, 303, 307, 308]) {
      expect(isRedirectResponse({ statusCode: code, headers: { location: '/next' } }), String(code)).toBe(true);
    }
  });
  it('is false for a redirect code without a Location header', () => {
    expect(isRedirectResponse({ statusCode: 302, headers: {} })).toBe(false);
  });
  it('is false for a non-redirect status code', () => {
    expect(isRedirectResponse({ statusCode: 200, headers: { location: '/next' } })).toBe(false);
  });
});

describe('isSupportedContentType', () => {
  it('accepts text/*, html, xml and json', () => {
    for (const ct of ['text/plain', 'text/html', 'application/xhtml+xml', 'application/json']) {
      expect(isSupportedContentType(ct), ct).toBe(true);
    }
  });
  it('rejects binary/image content types', () => {
    for (const ct of ['image/png', 'application/octet-stream', 'audio/mpeg']) {
      expect(isSupportedContentType(ct), ct).toBe(false);
    }
  });
});

describe('extractText', () => {
  it('strips tags for html/xml bodies', () => {
    expect(extractText('text/html', '<p>Hi</p><script>x</script>')).toBe('Hi');
    expect(extractText('application/xml', '<a>  A  </a>')).toBe('A');
  });
  it('only collapses whitespace for non-markup bodies', () => {
    expect(extractText('text/plain', '  a\n\n b  ')).toBe('a b');
    expect(extractText('application/json', '{ "k":  1 }')).toBe('{ "k": 1 }');
  });
});

describe('buildLLMContextFromScrapes', () => {
  it('joins successful scrapes with source delimiters', () => {
    const ctx = buildLLMContextFromScrapes([
      { url: 'a', ok: true, text: 'first' },
      { url: 'b', ok: false, error: 'fail' },
      { url: 'c', ok: true, text: 'second' },
    ]);
    expect(ctx).toContain('--- SOURCE: a ---');
    expect(ctx).toContain('first');
    expect(ctx).toContain('second');
    expect(ctx).not.toContain('fail');
  });
  it('returns empty string when nothing is OK', () => {
    expect(buildLLMContextFromScrapes([])).toBe('');
    expect(buildLLMContextFromScrapes([{ url: 'a', ok: false }])).toBe('');
  });
});
