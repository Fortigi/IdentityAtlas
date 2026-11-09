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
// The resource URL is built from the trusted public base URL (PUBLIC_BASE_URL
// first, never an unverified forwarded header): it is what a token's audience
// is checked against.
//
// Entra specifics, all handled in the Entra app registration (see
// docs/integrations/mcp.md): the client sends the resource URL as RFC 8707
// `resource`, so `<base>/mcp` must also be an Application ID URI of the API
// app; the scope is then `<base>/mcp/Mcp.Read`.

import { resolvePublicBaseUrl } from '../export/exportBaseUrl.js';
import { getTenantId } from '../config/authConfig.js';

export const MCP_PATH = '/mcp';
export const METADATA_PATH = '/.well-known/oauth-protected-resource';
// The delegated scope the API app exposes for MCP clients. A token must carry it
// (in `scp`): that is what makes it a user's consent to MCP access, not just any
// token for the API.
export const MCP_SCOPE = 'Mcp.Read';

export function mcpResourceUrl(req, env = process.env) {
  return `${resolvePublicBaseUrl(req, env)}${MCP_PATH}`;
}

export function scopeFor(resource) {
  return `${resource}/${MCP_SCOPE}`;
}

export function protectedResourceMetadata(req, env = process.env) {
  const resource = mcpResourceUrl(req, env);
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
export function challengeHeader(req, error, env = process.env) {
  const base = resolvePublicBaseUrl(req, env);
  const parts = [
    `resource_metadata="${base}${METADATA_PATH}${MCP_PATH}"`,
    `scope="${scopeFor(`${base}${MCP_PATH}`)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
