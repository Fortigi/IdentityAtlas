// Shared SSRF address guard.
//
// Extracted from llm/scraper.js (which pins its own connections) so the crawler
// live-discovery handlers can reuse the same block-list: those handlers fetch an
// admin-supplied connector base URL with a bearer/basic credential, and a
// scheme-only check let an admin point one straight at a cloud metadata endpoint
// or an internal service (audit L-6). scraper.js re-exports the three primitives
// below for its existing callers and tests.
//
// Every address is sorted into one of three classes:
//   'public'    — routable on the internet; always allowed.
//   'private'   — loopback, RFC 1918, CGNAT, IPv6 unique-local / site-local. Never
//                 allowed by default; a caller can opt in (allowPrivateNetwork) for
//                 connectors that legitimately live on an on-prem network.
//   'forbidden' — link-local (cloud metadata), unspecified, multicast, reserved,
//                 documentation and tunnelling ranges. Never allowed, opt-in or not.
//
// IPv6 literals are expanded to their eight hextets before classification, so the
// many spellings of one address (compressed, bracketed, zone-suffixed, dotted or
// hex IPv4 tail) all land on the same rule. WHATWG `new URL()` re-serialises an
// IPv4-mapped literal into hex form, which a textual match on the dotted form
// missed (SEC-2026-09 H-03). The strict rule for IPv6 is: anything outside global
// unicast 2000::/3 is non-public, and addresses that embed an IPv4 address
// (IPv4-mapped, NAT64, 6to4) are classified by the IPv4 address they carry.
//
// This file has a PowerShell twin for the worker-side crawlers:
// tools/crawlers/shared/Test-FGPublicUrl.ps1. Keep the two rule sets in step.

import dns from 'node:dns';
import net from 'node:net';

// Class of an IPv4 dotted-quad. Anything that is not a valid dotted-quad is
// 'forbidden' (fail closed).
export function classifyIPv4(ip) {
  const parts = String(ip).split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'forbidden';
  const [a, b] = parts;
  if (a === 0) return 'forbidden';                        // 0.0.0.0/8 "this network"
  if (a === 169 && b === 254) return 'forbidden';         // link-local / cloud metadata
  if (a >= 224) return 'forbidden';                       // multicast / reserved
  if (a === 127) return 'private';                        // loopback
  if (a === 10) return 'private';                         // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return 'private';  // RFC 1918
  if (a === 192 && b === 168) return 'private';           // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64/10
  return 'public';
}

// True if an IPv4 dotted-quad is in a blocked (non-public) range.
export function isBlockedIPv4(ip) {
  return classifyIPv4(ip) !== 'public';
}

// Replace a dotted IPv4 tail ("::ffff:1.2.3.4") with its two hex groups.
function hexifyIPv4Tail(s) {
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (!tail.includes('.')) return s;
  const p = tail.split('.').map(Number);
  return `${s.slice(0, lastColon + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
}

// Expand an IPv6 literal — optionally bracketed and/or carrying a %zone — into an
// array of eight 16-bit integers. Returns null when it is not a valid IPv6 literal.
export function parseIPv6(ip) {
  let s = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  s = hexifyIPv4Tail(s);
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest === undefined ? null : (rest ? rest.split(':') : []);
  const groups = t === null ? h : [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => parseInt(g, 16));
}

// The IPv4 address carried in two hextets.
function embeddedIPv4(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

// ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0/96 (IPv4-mapped) and
// 64:ff9b::/96 (NAT64). Returns a class, or null when the address is none of them.
function classifyEmbeddingPrefix(g) {
  const upperZero = (n) => g.slice(0, n).every((x) => x === 0);
  if (upperZero(5) && g[5] === 0xffff) return classifyIPv4(embeddedIPv4(g[6], g[7]));
  if (upperZero(6)) {
    if (g[6] === 0 && g[7] === 1) return 'private';      // ::1 loopback
    return 'forbidden';                                   // :: and deprecated IPv4-compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return classifyIPv4(embeddedIPv4(g[6], g[7]));        // NAT64 well-known prefix
  }
  return null;
}

// Non-global-unicast space (outside 2000::/3).
function classifyNonGlobal(g) {
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';      // unique-local fc00::/7
  if ((g[0] & 0xffc0) === 0xfec0) return 'private';      // deprecated site-local fec0::/10
  return 'forbidden';                                     // link-local fe80::/10, multicast, reserved
}

// Class of an IPv6 literal (any spelling). Invalid input is 'forbidden'.
export function classifyIPv6(ip) {
  const g = parseIPv6(ip);
  if (!g) return 'forbidden';
  const embedded = classifyEmbeddingPrefix(g);
  if (embedded) return embedded;
  if ((g[0] & 0xe000) !== 0x2000) return classifyNonGlobal(g);
  if (g[0] === 0x2002) return classifyIPv4(embeddedIPv4(g[1], g[2])); // 6to4 2002::/16
  if (g[0] === 0x2001 && g[1] === 0) return 'forbidden';               // Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'forbidden';          // documentation 2001:db8::/32
  return 'public';
}

// Class of an IP literal of either family; anything else is 'forbidden'.
export function classifyAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return classifyIPv4(bare);
  if (bare.includes(':')) return classifyIPv6(bare);
  return 'forbidden';
}

// True if the given IP literal (v4 or v6) must not be connected to.
export function isBlockedAddress(ip) {
  return classifyAddress(ip) !== 'public';
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

// Throw when an address's class is not permitted. The error carries a `code` so a
// caller can add context (e.g. point the operator at the opt-in setting).
function assertAddressAllowed(address, allowPrivateNetwork) {
  const cls = classifyAddress(address);
  if (cls === 'public' || (cls === 'private' && allowPrivateNetwork)) return;
  if (cls === 'private') {
    throw Object.assign(new Error('URL host resolves to a private or loopback address'), { code: 'SSRF_PRIVATE_ADDRESS' });
  }
  throw Object.assign(
    new Error('URL host resolves to a link-local, metadata, or reserved address'),
    { code: 'SSRF_FORBIDDEN_ADDRESS' },
  );
}

// Validate an admin-supplied URL before fetching it: it must be http(s) (https
// only, when `requireHttps`) and its host must resolve only to public addresses —
// or, with `allowPrivateNetwork`, to public or private ones (link-local, metadata
// and reserved ranges stay blocked either way). A literal-IP host is checked
// directly; a hostname is resolved and every returned address is checked. Throws
// on rejection, returns the parsed URL on success.
//
// Callers that use the global fetch() (the crawler discover handlers) can't pin
// the connection the way scraper.js does, so a determined DNS-rebind still has a
// check→fetch window — but this closes the "point it straight at
// 169.254.169.254 / 127.0.0.1 / 10.x" hole, which is the realistic threat here.
// Pair it with `redirect: 'manual'` so a public URL cannot bounce the request on.
export async function assertPublicUrl(rawUrl, { allowPrivateNetwork = false, requireHttps = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:' && (requireHttps || u.protocol !== 'http:')) {
    throw Object.assign(new Error(requireHttps ? 'URL must use https' : 'URL must use http or https'), { code: 'SSRF_SCHEME' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    assertAddressAllowed(host, allowPrivateNetwork);
    return u;
  }
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`No address for ${host}`);
  for (const a of addresses) assertAddressAllowed(a.address, allowPrivateNetwork);
  return u;
}
