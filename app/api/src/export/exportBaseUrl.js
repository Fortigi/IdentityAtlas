// Resolve the absolute API base URL that gets baked into the downloadable
// Power Query workbook (routes/dataExport.js).
//
// SECURITY (finding M-09): the workbook also embeds a live `fgr_` read token in
// its Settings sheet. Every Power Query refresh sends that token to whatever
// `BaseUrl` the file contains. If the base URL were derived from an
// attacker-influenced request header (X-Forwarded-Host / Host poisoning, a
// poisoned shared cache, or request smuggling), an analyst opening the workbook
// would POST their valid token to the attacker's host — token exfiltration.
//
// So the base URL must come from a server-trusted source, in this order:
//
//   1. PUBLIC_BASE_URL — authoritative, operator-set. Use this for ANY
//      deployment reached through a proxy / tunnel / Azure Front Door. It is
//      never influenced by the request, so it's always safe.
//   2. X-Forwarded-* headers — honoured ONLY when TRUST_PROXY=true, i.e. the
//      operator has declared a trusted reverse proxy sits in front and
//      overwrites these headers. Off by default → spoofed headers are ignored.
//   3. The direct request host (Host header + protocol). The scheme is taken
//      from the existing BEHIND_TLS signal when set, so a TLS-terminating proxy
//      that preserves Host still produces https:// URLs without trusting any
//      attacker-controllable header.
//
// The resolved host is finally validated to be a bare host[:port]; anything
// containing whitespace, CR/LF, commas, or path/userinfo characters (the shapes
// header smuggling injects) is rejected rather than baked into the workbook.

// eslint-disable-next-line security/detect-unsafe-regex -- static pattern, disjoint character class, no backtracking ambiguity
const HOST_RE = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;

export function resolveExportBaseUrl(req, env = process.env) {
  const configured = env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.trim();
  if (configured) {
    return `${configured.replace(/\/+$/, '')}/api`;
  }

  // Scheme: trust the server-side BEHIND_TLS flag first (same flag that drives
  // HSTS/CSP upgrade), then a trusted forwarded proto, else the connection.
  let proto = env.BEHIND_TLS === 'true' ? 'https' : req.protocol;
  let host = req.get('host');

  if (env.TRUST_PROXY === 'true') {
    const fwdHost = firstValue(req.get('x-forwarded-host'));
    const fwdProto = firstValue(req.get('x-forwarded-proto'));
    if (fwdHost) host = fwdHost;
    if (fwdProto) proto = fwdProto;
  }

  proto = proto === 'https' ? 'https' : 'http';

  if (!host || !HOST_RE.test(host)) {
    throw new Error('Cannot resolve a safe export base URL host');
  }

  return `${proto}://${host}/api`;
}

// X-Forwarded-* may legitimately be a comma-separated chain ("client, proxy1").
// Take only the first hop and trim it.
function firstValue(headerValue) {
  if (!headerValue) return '';
  return String(headerValue).split(',')[0].trim();
}
