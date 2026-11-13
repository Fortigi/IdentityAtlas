// Proxy-aware client identity for rate limiters and audit rows
// (SEC-2026-09 M-09).
//
// Behind Azure App Service or any reverse proxy every request arrives from the
// proxy's address, so limiters keyed on the socket address put the whole
// organisation in one bucket and audit rows record the proxy. Express resolves
// the real client from X-Forwarded-For only when 'trust proxy' says how many
// hops to trust — and trusting blindly (`true`) would let any client spoof it.
//
// resolveTrustProxy() turns the environment into that setting:
//   TRUST_PROXY_HOPS=<n>  explicit hop count (0 = off)
//   TRUST_PROXY=true      one trusted proxy (the same flag that already lets the
//                         workbook export honour X-Forwarded-Host/Proto)
//   BEHIND_TLS=true       one trusted proxy (the TLS terminator in front)
//   otherwise             off — the socket address is the client

import { ipKeyGenerator } from 'express-rate-limit';

const HOPS_RE = /^\d{1,2}$/;

export function resolveTrustProxy(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS === undefined ? '' : String(env.TRUST_PROXY_HOPS).trim();
  if (raw !== '') {
    if (!HOPS_RE.test(raw)) return false; // malformed → safest: trust nothing
    const hops = parseInt(raw, 10);
    return hops > 0 ? hops : false;
  }
  if (env.TRUST_PROXY === 'true' || env.BEHIND_TLS === 'true') return 1;
  return false;
}

// Some proxies (Azure App Service) append the client port to the forwarded
// address ("203.0.113.7:51544"). Left in, every request would get its own
// bucket. Strip it for IPv4 and bracketed IPv6.
export function stripPort(address) {
  const ip = String(address || '');
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    return end > 1 ? ip.slice(1, end) : ip;
  }
  const colon = ip.indexOf(':');
  // Exactly one colon after a dotted address = IPv4:port. Bare IPv6 has several.
  if (colon !== -1 && colon === ip.lastIndexOf(':') && ip.slice(0, colon).includes('.')) {
    return ip.slice(0, colon);
  }
  return ip;
}

// A request that carries X-Forwarded-For while no proxy is trusted came through
// a reverse proxy nobody told us about (security review Nov 2026, F-35). Every
// client behind it then has the proxy's address, so an address-keyed limiter puts
// them all in one bucket: the pre-authentication failure limiter, which counts
// only failed requests, would let one anonymous client lock everyone out with a
// loop of bad credentials. For such requests that limiter is skipped, and the
// operator is told once what to set.
//
// The trade-off, stated: a client that connects directly can add the header too
// and so step around that one limiter. It loses nothing else — the per-caller
// limits after sign-in, the crawler-key failure limiter in front of the hash, and
// the public endpoint limits all still apply. Locking out a whole organisation
// is the worse failure.
export const UNCONFIGURED_PROXY_WARNING =
  'WARNING: requests arrive through a reverse proxy (X-Forwarded-For is set), but no proxy is trusted, so every client shares the proxy address for rate limiting and audit logs. Set TRUST_PROXY_HOPS to the number of proxies in front of Identity Atlas (or BEHIND_TLS=true for one TLS proxy).';

export function createUnconfiguredProxyCheck(trustProxy, warn = console.warn) {
  if (trustProxy !== false) return () => false;
  let warned = false;
  return (req) => {
    if (!req.headers?.['x-forwarded-for']) return false;
    if (!warned) {
      warned = true;
      warn(UNCONFIGURED_PROXY_WARNING);
    }
    return true;
  };
}

// Key a limiter on the verified caller when one is known (a signed-in user, a
// read API token, a crawler key), else on the client address. Keys are
// namespaced so an IP can never collide with a principal id.
export function principalRateLimitKey(req) {
  const userId = req.user?.oid || req.user?.sub;
  if (userId) return `user:${userId}`;
  if (req.readToken?.id !== undefined) return `token:${req.readToken.id}`;
  if (req.crawler?.id !== undefined) return `crawler:${req.crawler.id}`;
  return `ip:${ipKeyGenerator(stripPort(req.ip))}`;
}
