// Where the MCP endpoint lives and how an AI client learns to sign in to it.
//
// The flow (MCP authorization spec + RFC 9728), as Claude, ChatGPT and Copilot
// follow it:
//   1. The client POSTs to /mcp without a token and gets a 401 whose
//      WWW-Authenticate header points at our protected-resource metadata.
//   2. That metadata names Entra ID (this deployment's tenant) as the
//      authorization server and the one scope to ask for.
//   3. The client signs the user in at Entra and calls /mcp with the user's
//      access token, which mcp/auth.js verifies.
//
// The resource URL is built from PUBLIC_BASE_URL and from nothing else: it is
// what a token's audience is checked against. It used to fall back to the
// request's Host header (security review Nov 2026, F-08). Then anyone in the
// tenant who registers an app whose identifier URI matches a Host they send
// could present a token for THAT app, carrying app roles they assigned
// themselves, and it verified. A header the caller writes cannot decide which
// audience is accepted, so without PUBLIC_BASE_URL the endpoint does not run
// (mcp/auth.js answers 503 and the admin card says why).
//
// Entra specifics, all handled in the Entra app registration (see
// docs/integrations/mcp.md): the client sends the resource URL as RFC 8707
// `resource`, so `<base>/mcp` must also be an Application ID URI of the API
// app; the scope is then `<base>/mcp/Mcp.Read`.

import { getTenantId } from '../config/authConfig.js';

export const MCP_PATH = '/mcp';
export const METADATA_PATH = '/.well-known/oauth-protected-resource';
// The delegated scope the API app exposes for MCP clients. A token must carry it
// (in `scp`): that is what makes it a user's consent to MCP access, not just any
// token for the API.
export const MCP_SCOPE = 'Mcp.Read';

// The operator-set public address (scheme + host [+ path prefix], no trailing
// slash), or null when PUBLIC_BASE_URL is unset or is not a plain http(s) URL.
// Credentials, a query or a fragment are refused rather than stripped: a value
// like that is a mistake, and guessing what was meant would pick an audience.
export function mcpBaseUrl(env = process.env) {
  const raw = String(env.PUBLIC_BASE_URL || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  let end = raw.length;
  while (raw.endsWith('/', end)) end--;
  return raw.slice(0, end);
}

// The MCP resource URL, or null while the endpoint is not configured.
export function mcpResourceUrl(env = process.env) {
  const base = mcpBaseUrl(env);
  return base ? `${base}${MCP_PATH}` : null;
}

export function scopeFor(resource) {
  return `${resource}/${MCP_SCOPE}`;
}

// Only called once mcpAvailable has confirmed the base URL is configured.
export function protectedResourceMetadata(env = process.env) {
  const resource = mcpResourceUrl(env);
  return {
    resource,
    authorization_servers: [`https://login.microsoftonline.com/${getTenantId()}/v2.0`],
    scopes_supported: [scopeFor(resource)],
    bearer_methods_supported: ['header'],
    resource_name: 'Identity Atlas',
  };
}

// The 401/403 challenge. `error` is an RFC 6750 code (invalid_token,
// insufficient_scope) or omitted when no token was sent at all.
export function challengeHeader(error, env = process.env) {
  const base = mcpBaseUrl(env);
  const parts = [
    `resource_metadata="${base}${METADATA_PATH}${MCP_PATH}"`,
    `scope="${scopeFor(`${base}${MCP_PATH}`)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
