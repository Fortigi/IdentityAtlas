// Unit tests for the request-origin guard (SEC-2026-09 H-07). Inputs are chosen
// so each case separates the intended rule from a near-miss: a dotted public
// name vs a single-label intranet name, a same-host Origin on a DIFFERENT port,
// an allowed origin that is also marked cross-site, and so on.

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeHost,
  buildHostPolicy,
  isHostAllowed,
  isSameHostOrigin,
  isCrossSiteWrite,
  createRequestOriginGuard,
  printableForLog,
} from './requestOriginGuard.js';

function fakeReq({ method = 'POST', path = '/api/admin/clean-database', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, path, get: (name) => lower[name.toLowerCase()] };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function runGuard(guard, reqOpts) {
  const req = fakeReq(reqOpts);
  const res = fakeRes();
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const quietLogger = () => ({ warn: vi.fn() });

describe('normalizeHost', () => {
  it('lower-cases, strips the port and a trailing dot', () => {
    expect(normalizeHost('Atlas.Example.COM.:3001')).toBe('atlas.example.com');
  });
  it('unwraps a bracketed IPv6 literal with a port', () => {
    expect(normalizeHost('[::1]:3001')).toBe('::1');
  });
  it('returns empty for a malformed bracket or a missing header', () => {
    expect(normalizeHost('[::1')).toBe('');
    expect(normalizeHost(undefined)).toBe('');
  });
  it('trims surrounding whitespace and leaves a port-less name whole', () => {
    expect(normalizeHost('  Web  ')).toBe('web');
    expect(normalizeHost('sidekick-1')).toBe('sidekick-1');
  });
});

describe('buildHostPolicy / isHostAllowed', () => {
  it('always allows loopback names and never an unlisted dotted public name', () => {
    const policy = buildHostPolicy({});
    expect(isHostAllowed('localhost', policy)).toBe(true);
    expect(isHostAllowed('rebind.attacker.example', policy)).toBe(false);
  });

  it('allows IP literals, single-label intranet names and .local names', () => {
    const policy = buildHostPolicy({});
    expect(isHostAllowed('192.168.1.10', policy)).toBe(true);
    expect(isHostAllowed('fe80::1', policy)).toBe(true);
    expect(isHostAllowed('web', policy)).toBe(true);
    expect(isHostAllowed('atlas.local', policy)).toBe(true);
    expect(isHostAllowed('atlas.local.attacker.example', policy)).toBe(false);
    expect(isHostAllowed('attacker.nolocal', policy)).toBe(false);
    expect(isHostAllowed('bad host', policy)).toBe(false);
    expect(isHostAllowed('bad host.local', policy)).toBe(false);
  });

  it('derives allowed hosts from ALLOWED_HOSTS, PUBLIC_BASE_URL, ALLOWED_ORIGINS and WEBSITE_HOSTNAME', () => {
    const policy = buildHostPolicy({
      ALLOWED_HOSTS: ' One.example.com , two.example.com:8443',
      PUBLIC_BASE_URL: 'https://public.example.com/',
      ALLOWED_ORIGINS: 'https://origin.example.com,*',
      WEBSITE_HOSTNAME: 'app.azurewebsites.net',
    });
    for (const h of ['one.example.com', 'two.example.com', 'public.example.com', 'origin.example.com', 'app.azurewebsites.net']) {
      expect(isHostAllowed(h, policy)).toBe(true);
    }
    expect(policy.origins.has('*')).toBe(false);
    expect(policy.hosts.has('')).toBe(false);
  });

  it('ignores an unparsable PUBLIC_BASE_URL instead of allowing everything', () => {
    const policy = buildHostPolicy({ PUBLIC_BASE_URL: 'not a url' });
    expect(isHostAllowed('not a url', policy)).toBe(false);
    expect(isHostAllowed('', policy)).toBe(false);
  });
});

describe('isSameHostOrigin', () => {
  it('matches only the exact host:port', () => {
    expect(isSameHostOrigin('http://localhost:3001', 'localhost:3001')).toBe(true);
    expect(isSameHostOrigin('http://localhost:8080', 'localhost:3001')).toBe(false);
  });
  it('never matches "null" or garbage', () => {
    expect(isSameHostOrigin('null', 'null')).toBe(false);
    expect(isSameHostOrigin('http://', '')).toBe(false);
    expect(isSameHostOrigin('file:///etc/hosts', '')).toBe(false);
  });
  it('compares the Host header case- and whitespace-insensitively', () => {
    expect(isSameHostOrigin('http://localhost:3001', ' LOCALHOST:3001 ')).toBe(true);
  });
});

describe('printableForLog', () => {
  it('replaces line breaks, spaces and non-ASCII so a host cannot forge a log line', () => {
    expect(printableForLog('evil\r\nFAKE entry é')).toBe('evil??FAKE?entry??');
    expect(printableForLog('atlas.example.com:3001')).toBe('atlas.example.com:3001');
  });
  it('keeps at most 100 characters', () => {
    expect(printableForLog('x'.repeat(150))).toBe('x'.repeat(100));
  });
});

describe('allowed origins are normalised', () => {
  it('matches a listed origin regardless of case, surrounding spaces or trailing slashes', () => {
    const policy = buildHostPolicy({ ALLOWED_ORIGINS: 'https://a.example.com, https://Partner.Example.com//' });
    const upperHeader = fakeReq({ headers: { 'sec-fetch-site': 'cross-site', origin: 'https://PARTNER.example.com' } });
    const plainHeader = fakeReq({ headers: { 'sec-fetch-site': 'cross-site', origin: 'https://partner.example.com' } });
    expect(isCrossSiteWrite(upperHeader, policy)).toBe(false);
    expect(isCrossSiteWrite(plainHeader, policy)).toBe(false);
  });
});

describe('isCrossSiteWrite', () => {
  const policy = buildHostPolicy({ ALLOWED_ORIGINS: 'https://partner.example.com' });

  it('never flags safe methods, even with cross-site headers', () => {
    const req = fakeReq({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
    expect(isCrossSiteWrite(req, policy)).toBe(false);
  });

  it('flags a cross-site POST marked by Sec-Fetch-Site', () => {
    expect(isCrossSiteWrite(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), policy)).toBe(true);
    expect(isCrossSiteWrite(fakeReq({ headers: { 'sec-fetch-site': 'same-site' } }), policy)).toBe(true);
  });

  it('accepts same-origin and user-initiated (none) fetches', () => {
    expect(isCrossSiteWrite(fakeReq({ headers: { 'sec-fetch-site': 'same-origin' } }), policy)).toBe(false);
    expect(isCrossSiteWrite(fakeReq({ headers: { 'sec-fetch-site': 'none' } }), policy)).toBe(false);
  });

  it('prefers Sec-Fetch-Site over an Origin that does not match a rewritten Host', () => {
    const req = fakeReq({ headers: { 'sec-fetch-site': 'same-origin', origin: 'https://atlas.example.com', host: 'web:3001' } });
    expect(isCrossSiteWrite(req, policy)).toBe(false);
  });

  it('accepts an explicitly allowed origin even when the browser marks it cross-site', () => {
    const req = fakeReq({ headers: { 'sec-fetch-site': 'cross-site', origin: 'https://partner.example.com/' } });
    expect(isCrossSiteWrite(req, policy)).toBe(false);
  });

  it('falls back to an Origin host:port compare when Sec-Fetch-Site is absent', () => {
    const same = fakeReq({ headers: { origin: 'http://localhost:3001', host: 'localhost:3001' } });
    const otherPort = fakeReq({ headers: { origin: 'http://localhost:8080', host: 'localhost:3001' } });
    const nullOrigin = fakeReq({ headers: { origin: 'null', host: 'localhost:3001' } });
    expect(isCrossSiteWrite(same, policy)).toBe(false);
    expect(isCrossSiteWrite(otherPort, policy)).toBe(true);
    expect(isCrossSiteWrite(nullOrigin, policy)).toBe(true);
  });

  it('treats X-Requested-With: IdentityAtlas as a same-app signal, but not another value', () => {
    const app = fakeReq({ headers: { 'x-requested-with': 'IdentityAtlas', 'sec-fetch-site': 'cross-site' } });
    const other = fakeReq({ headers: { 'x-requested-with': 'XMLHttpRequest', 'sec-fetch-site': 'cross-site' } });
    expect(isCrossSiteWrite(app, policy)).toBe(false);
    expect(isCrossSiteWrite(other, policy)).toBe(true);
  });

  it('lets a request with no browser provenance headers through (worker, Power Query, curl)', () => {
    expect(isCrossSiteWrite(fakeReq({ method: 'DELETE', headers: { host: 'localhost:3001' } }), policy)).toBe(false);
  });
});

describe('createRequestOriginGuard — auth OFF (enforced)', () => {
  const make = (env = {}) => {
    const logger = quietLogger();
    return { guard: createRequestOriginGuard({ env, authEnabled: () => false, logger }), logger };
  };

  it('answers 421 for an unlisted dotted host and logs the instruction once', () => {
    const { guard, logger } = make();
    const first = runGuard(guard, { method: 'GET', path: '/api/systems', headers: { host: 'rebind.attacker.example:3001' } });
    runGuard(guard, { method: 'GET', path: '/api/systems', headers: { host: 'rebind.attacker.example:3001' } });
    expect(first.res.statusCode).toBe(421);
    expect(first.nextCalled).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/^Rejected a request for host "rebind\.attacker\.example"/);
    expect(logger.warn.mock.calls[0][0]).toMatch(/ALLOWED_HOSTS/);
  });

  it('truncates an oversized host name in the log line', () => {
    const { guard, logger } = make();
    const longHost = `${'a'.repeat(150)}.attacker.example`;
    runGuard(guard, { method: 'GET', path: '/', headers: { host: longHost } });
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain(`"${'a'.repeat(100)}"`);
    expect(line).not.toContain(longHost);
  });

  it('passes the same host once ALLOWED_HOSTS lists it', () => {
    const { guard } = make({ ALLOWED_HOSTS: 'rebind.attacker.example' });
    const r = runGuard(guard, { method: 'GET', path: '/api/systems', headers: { host: 'rebind.attacker.example:3001' } });
    expect(r.nextCalled).toBe(true);
  });

  it('never blocks the health probe or the crawler data-plane on Host', () => {
    const { guard } = make();
    for (const path of ['/api/health', '/api/crawlers/jobs/claim', '/api/ingest/principals']) {
      const r = runGuard(guard, { method: 'GET', path, headers: { host: 'internal.probe.example' } });
      expect(r.nextCalled).toBe(true);
    }
    const lookalike = runGuard(guard, { method: 'GET', path: '/api/healthz', headers: { host: 'internal.probe.example' } });
    expect(lookalike.res.statusCode).toBe(421);
  });

  it('refuses a cross-site write with 403 on an allowed host', () => {
    const { guard } = make();
    const r = runGuard(guard, { headers: { host: 'localhost:3001', 'sec-fetch-site': 'cross-site' } });
    expect(r.res.statusCode).toBe(403);
    expect(r.nextCalled).toBe(false);
  });

  it('stops logging new hosts after the cap', () => {
    const { guard, logger } = make();
    for (let i = 0; i < 60; i++) {
      runGuard(guard, { method: 'GET', path: '/', headers: { host: `h${i}.attacker.example` } });
    }
    expect(logger.warn).toHaveBeenCalledTimes(50);
  });
});

describe('createRequestOriginGuard — auth ON (not enforced)', () => {
  it('lets an unlisted host and a cross-site write through, logging the host once', () => {
    const logger = quietLogger();
    const guard = createRequestOriginGuard({ env: {}, authEnabled: () => true, logger });
    const r = runGuard(guard, { headers: { host: 'atlas.corp.example', 'sec-fetch-site': 'cross-site' } });
    expect(r.nextCalled).toBe(true);
    expect(r.res.statusCode).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/^Received/);
  });
});
