// Shared SSRF address guard.
//
// Extracted from llm/scraper.js (which pins its own connections) so the crawler
// live-discovery handlers can reuse the same block-list: those handlers fetch an
// admin-supplied connector base URL with a bearer/basic credential, and a
// scheme-only check let an admin point one straight at a cloud metadata endpoint
// or an internal service (audit L-6). scraper.js re-exports the three primitives
// below for its existing callers and tests.

import dns from 'node:dns';
import net from 'node:net';

// True if an IPv4 dotted-quad is in a blocked (non-public) range.
export function isBlockedIPv4(ip) {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 127) return true;                        // loopback
  if (a === 10) return true;                         // private
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 169 && b === 254) return true;           // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

// True if the given IP literal (v4 or v6) must not be connected to.
export function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedIPv4(ip);
  if (fam === 6) {
    const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (low === '::1' || low === '::') return true;          // loopback / unspecified
    if (low.startsWith('fe80')) return true;                 // link-local
    if (/^f[cd]/.test(low)) return true;                     // unique-local fc00::/7
    if (low.startsWith('ff')) return true;                   // multicast
    const mapped = low.match(/(?:::ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedIPv4(mapped[1]);             // IPv4-mapped IPv6
    return false;
  }
  return true; // not a valid IP literal → block defensively
}

// net.connect-compatible lookup that resolves the host, refuses if ANY resolved
// address is non-public, and returns a validated address to connect to. Because
// the connection uses exactly this resolution, an attacker can't rebind DNS
// between the check and the connect.
export function pinnedSafeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses || addresses.length === 0) return callback(new Error(`No address for ${hostname}`));
    for (const a of addresses) {
      if (isBlockedAddress(a.address)) {
        return callback(new Error(`Refusing to connect to non-public address ${a.address} for ${hostname}`));
      }
    }
    const wantFamily = options && options.family;
    const chosen = (wantFamily ? addresses.find((a) => a.family === wantFamily) : null) || addresses[0];
    callback(null, chosen.address, chosen.family);
  });
}

// Validate an admin-supplied URL before fetching it: it must be http(s) and its
// host must resolve only to public addresses. A literal-IP host is checked
// directly; a hostname is resolved and every returned address is checked. Throws
// on rejection, returns the parsed URL on success.
//
// Callers that use the global fetch() (the crawler discover handlers) can't pin
// the connection the way scraper.js does, so a determined DNS-rebind still has a
// check→fetch window — but this closes the "point it straight at
// 169.254.169.254 / 127.0.0.1 / 10.x" hole, which is the realistic threat here.
export async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const reject = () => { throw new Error('URL host resolves to a private, loopback, or link-local address'); };
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) reject();
    return u;
  }
  const addresses = await dns.promises.lookup(host, { all: true });
  if (!addresses.length) throw new Error(`No address for ${host}`);
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) reject();
  }
  return u;
}
