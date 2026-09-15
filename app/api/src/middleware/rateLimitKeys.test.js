import { describe, it, expect } from 'vitest';
import { resolveTrustProxy, stripPort, principalRateLimitKey } from './rateLimitKeys.js';

describe('resolveTrustProxy', () => {
  it('is off by default so X-Forwarded-For cannot be spoofed on a direct deployment', () => {
    expect(resolveTrustProxy({})).toBe(false);
  });

  it('trusts exactly one hop behind a TLS terminator or with TRUST_PROXY=true', () => {
    expect(resolveTrustProxy({ BEHIND_TLS: 'true' })).toBe(1);
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(1);
    expect(resolveTrustProxy({ BEHIND_TLS: 'false', TRUST_PROXY: 'yes' })).toBe(false);
  });

  it('lets TRUST_PROXY_HOPS override, including switching it off with 0', () => {
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: '2', BEHIND_TLS: 'true' })).toBe(2);
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: ' 0 ', BEHIND_TLS: 'true' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: ' 3 ' })).toBe(3);
  });

  it('treats a malformed hop count as "trust nothing", never as true', () => {
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: 'true', BEHIND_TLS: 'true' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: '-1' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY_HOPS: '100' })).toBe(false);
  });
});

describe('stripPort', () => {
  it('removes a port appended to an IPv4 address', () => {
    expect(stripPort('203.0.113.7:51544')).toBe('203.0.113.7');
  });
  it('unwraps a bracketed IPv6 address with or without a port', () => {
    expect(stripPort('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(stripPort('[2001:db8::1]')).toBe('2001:db8::1');
  });
  it('leaves an empty or unterminated bracket as it was rather than inventing an address', () => {
    expect(stripPort('[]')).toBe('[]');
    expect(stripPort('[2001:db8::1')).toBe('[2001:db8::1');
  });
  it('leaves bare IPv6 and IPv4 addresses untouched', () => {
    expect(stripPort('2001:db8::1')).toBe('2001:db8::1');
    expect(stripPort('10.0.0.9')).toBe('10.0.0.9');
    expect(stripPort(undefined)).toBe('');
  });
});

describe('principalRateLimitKey', () => {
  it('prefers the signed-in user oid over everything else', () => {
    const req = { user: { oid: 'o-1', sub: 's-1' }, readToken: { id: 3 }, crawler: { id: 4 }, ip: '10.0.0.1' };
    expect(principalRateLimitKey(req)).toBe('user:o-1');
  });

  it('falls back to sub when a token has no oid', () => {
    expect(principalRateLimitKey({ user: { sub: 's-1' }, ip: '10.0.0.1' })).toBe('user:s-1');
  });

  it('keys a read API token and a crawler on their ids — including id 0', () => {
    expect(principalRateLimitKey({ readToken: { id: 0 }, ip: '10.0.0.1' })).toBe('token:0');
    expect(principalRateLimitKey({ crawler: { id: 7 }, ip: '10.0.0.1' })).toBe('crawler:7');
  });

  it('gives two users behind the same proxy address different buckets', () => {
    const a = principalRateLimitKey({ user: { oid: 'a' }, ip: '10.0.0.1' });
    const b = principalRateLimitKey({ user: { oid: 'b' }, ip: '10.0.0.1' });
    expect(a).not.toBe(b);
  });

  it('uses the port-stripped client address for anonymous callers', () => {
    expect(principalRateLimitKey({ ip: '203.0.113.7:51544' })).toBe('ip:203.0.113.7');
    expect(principalRateLimitKey({ ip: '203.0.113.7:40000' })).toBe(principalRateLimitKey({ ip: '203.0.113.7:51544' }));
  });

  it('groups IPv6 callers by /56 so rotating the interface id does not escape the limit', () => {
    const a = principalRateLimitKey({ ip: '2001:db8:0:1::1' });
    const b = principalRateLimitKey({ ip: '2001:db8:0:1::ffff' });
    expect(a).toBe(b);
  });
});
