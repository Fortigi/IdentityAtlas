// Request-origin guard (SEC-2026-09 H-07): Host allow-list + cross-site write
// guard for deployments running with authentication OFF.
//
// With auth off every gate is a no-op, so two browser-borne weaknesses matter:
//
//   1. Cross-site request forgery. CORS only hides the *response*; a "simple"
//      cross-site POST (form / text/plain / multipart) still executes. So a
//      state-changing request that a browser marks as cross-site
//      (Sec-Fetch-Site) or that carries a foreign Origin is refused.
//      Non-browser clients (the PowerShell worker, Power Query, curl) send
//      neither header and keep working.
//
//   2. DNS rebinding. A hostile DNS name re-pointed at the app makes the
//      attacker's page "same-origin", which defeats (1). The browser still
//      sends the hostile name in the Host header, so requests whose Host is
//      not an allowed name are answered 421 Misdirected Request.
//
// Hosts that can never be a rebinding vector are always allowed: loopback,
// IP literals (a LAN user browsing to http://192.168.1.10:3001), single-label
// intranet names (`web`, `sidekick-1`) and mDNS `.local` names — an attacker
// can only rebind a DNS name they control, which is always a dotted public
// name. Dotted names must be listed: ALLOWED_HOSTS, the host of
// PUBLIC_BASE_URL, the hosts of ALLOWED_ORIGINS, or Azure's WEBSITE_HOSTNAME.
//
// When auth is ON neither check is enforced: a rebinding or cross-site page
// has no bearer token, so it gets nothing the auth gates would not refuse.
// Unknown hosts are then only logged once, so an operator can add them before
// ever switching auth off.

import { isIP } from 'net';
import { isAuthEnabled } from '../config/authConfig.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_APP_FETCH_SITES = new Set(['same-origin', 'none']);
export const SAME_APP_HEADER_VALUE = 'IdentityAtlas';

// Endpoints that must answer regardless of Host: the platform health probe,
// and the crawler data-plane, which always requires a crawler API key (in every
// auth mode), so a rebinding page gains nothing there.
const HOST_EXEMPT_PATHS = ['/api/health'];
const HOST_EXEMPT_PREFIXES = ['/api/crawlers/', '/api/ingest/'];
const SINGLE_LABEL_RE = /^[a-z0-9-]+$/;
const MDNS_RE = /^[a-z0-9.-]+\.local$/;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];
const MAX_WARNED_HOSTS = 50;

// "Example.COM:3001" → "example.com"; "[::1]:3001" → "::1"; trailing dot dropped.
export function normalizeHost(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(1, end);
  }
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  return host.replace(/\.$/, '');
}

function hostOfUrl(value) {
  try {
    return normalizeHost(new URL(value).host);
  } catch {
    return '';
  }
}

// "https://Atlas.example.com/" → "https://atlas.example.com"
// (A loop instead of a /\/+$/ regex: the Origin header is client-controlled.)
function normalizeOrigin(origin) {
  let end = origin.length;
  while (origin.endsWith('/', end)) end--;
  return origin.slice(0, end).toLowerCase();
}

function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Build the configured host + origin policy from the environment.
export function buildHostPolicy(env = process.env, extraOrigins = []) {
  const hosts = new Set(LOOPBACK_HOSTS);
  for (const h of splitList(env.ALLOWED_HOSTS)) hosts.add(normalizeHost(h));
  if (env.WEBSITE_HOSTNAME) hosts.add(normalizeHost(env.WEBSITE_HOSTNAME));
  if (env.PUBLIC_BASE_URL) hosts.add(hostOfUrl(env.PUBLIC_BASE_URL));

  const origins = new Set();
  for (const o of [...splitList(env.ALLOWED_ORIGINS), ...extraOrigins]) {
    if (o === '*') continue;
    hosts.add(hostOfUrl(o));
    origins.add(normalizeOrigin(o));
  }
  hosts.delete('');
  return { hosts, origins };
}

// True for hosts that cannot be used for DNS rebinding (see header comment).
function isInherentlySafeHost(host) {
  return isIP(host) !== 0 || SINGLE_LABEL_RE.test(host) || MDNS_RE.test(host);
}

// An empty host is never allowed: it is not in the set and matches no safe shape.
export function isHostAllowed(host, policy) {
  return policy.hosts.has(host) || isInherentlySafeHost(host);
}

function isListedOrigin(origin, policy) {
  return !!origin && policy.origins.has(normalizeOrigin(origin));
}

// Fallback for browsers that do not send Sec-Fetch-Site: the Origin must name
// exactly the host:port the request was sent to. `Origin: null` never matches.
export function isSameHostOrigin(origin, hostHeader) {
  let originHostPort;
  try {
    originHostPort = new URL(origin).host; // the URL parser already lower-cases the host
  } catch {
    return false;
  }
  return originHostPort !== '' && originHostPort === String(hostHeader || '').trim().toLowerCase();
}

// Decide whether a state-changing request is a browser cross-site request.
// Returns true when it must be refused.
export function isCrossSiteWrite(req, policy) {
  if (SAFE_METHODS.has(req.method)) return false;
  // A custom header cannot be attached cross-site without a CORS preflight,
  // which only allowed origins pass — so it positively identifies the app.
  if (req.get('x-requested-with') === SAME_APP_HEADER_VALUE) return false;

  const origin = req.get('origin');
  if (isListedOrigin(origin, policy)) return false;
  // Sec-Fetch-Site is set by the browser and cannot be forged by page script;
  // prefer it, because a proxy that rewrites Host would break an Origin compare.
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite !== undefined) return !SAME_APP_FETCH_SITES.has(fetchSite);
  if (origin !== undefined) return !isSameHostOrigin(origin, req.get('host'));
  return false; // no browser provenance headers → non-browser client
}

// A client-supplied host name, cut to 100 characters with anything outside
// printable ASCII (line breaks included) replaced, so it cannot forge log lines.
export function printableForLog(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 100)
    .replace(/[^\x21-\x7e]/g, '?');
}

function isHostExemptPath(path) {
  return HOST_EXEMPT_PATHS.includes(path) || HOST_EXEMPT_PREFIXES.some(p => path.startsWith(p));
}

export function createRequestOriginGuard({ env = process.env, extraOrigins = [], authEnabled = isAuthEnabled, logger = console } = {}) {
  const policy = buildHostPolicy(env, extraOrigins);
  const warnedHosts = new Set();

  function warnOnce(host, enforced) {
    if (warnedHosts.has(host) || warnedHosts.size >= MAX_WARNED_HOSTS) return;
    warnedHosts.add(host);
    const action = enforced ? 'Rejected' : 'Received';
    logger.warn(
      `${action} a request for host "${printableForLog(host)}", which is not an allowed host name. ` +
      'If this is how users reach Identity Atlas, add it to ALLOWED_HOSTS (comma-separated) ' +
      'or set PUBLIC_BASE_URL. This is enforced while authentication is disabled.'
    );
  }

  return function requestOriginGuard(req, res, next) {
    const enforced = !authEnabled();
    const host = normalizeHost(req.get('host'));
    if (!isHostExemptPath(req.path) && !isHostAllowed(host, policy)) {
      warnOnce(host, enforced);
      if (enforced) {
        return res.status(421).json({
          error: 'This host name is not allowed. Ask the administrator to add it to ALLOWED_HOSTS.',
        });
      }
    }
    if (enforced && isCrossSiteWrite(req, policy)) {
      return res.status(403).json({ error: 'Cross-site request refused' });
    }
    return next();
  };
}
