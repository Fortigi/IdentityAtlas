// Who may use /mcp, and as whom.
//
// mcpAvailable: the endpoint (and its metadata) exists only while sign-in is on
// AND the mcpServer feature is switched on. Otherwise 404 — a switched-off
// feature does not exist on this install, whoever asks.
//
// mcpAuth: the caller must be a signed-in USER, acting through an AI client:
//   - an Entra access token for this API (audience = the MCP resource URL, the
//     api://<clientId> URI, or — v2 tokens — the bare client id),
//   - carrying the delegated Mcp.Read scope in `scp`. That excludes id_tokens and
//     app-only tokens (neither has `scp`), and the SPA's own token (scope
//     `access`): MCP access is something the user consented to separately.
//   - whose roles map to the `mcp.use` permission (the explicit "may use MCP"
//     switch per role, Admin → Authentication & roles).
// API keys (fgr_ / fgc_) are refused: they act for no one.
//
// What the assistant may then READ is decided per tool by the same permissions
// the UI uses (mcp/tools.js) — MCP adds a gate, it never widens one.

import { isAuthEnabled, getClientId } from '../config/authConfig.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { verifyEntraAccessToken, accessFromClaims } from '../middleware/auth.js';
import { MCP_SCOPE, challengeHeader, mcpResourceUrl } from './resource.js';

export const MCP_PERMISSION = 'mcp.use';

export async function mcpAvailable(req, res, next) {
  if (isAuthEnabled() && await isFeatureEnabled('mcpServer')) return next();
  res.status(404).json({ error: 'Not found' });
}

function refuse(req, res, status, error, message) {
  res.set('WWW-Authenticate', challengeHeader(req, error));
  res.status(status).json({ error: message });
}

export function hasPermission(permissions, permission) {
  return permissions.has('*') || permissions.has(permission);
}

export async function mcpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return refuse(req, res, 401, null, 'Sign in required');
  if (token.startsWith('fgr_') || token.startsWith('fgc_')) {
    return refuse(req, res, 401, 'invalid_token', 'API keys cannot be used here; sign in as a user');
  }

  let decoded;
  try {
    const clientId = getClientId();
    decoded = await verifyEntraAccessToken(token, [mcpResourceUrl(req), `api://${clientId}`, clientId]);
  } catch (err) {
    console.error('MCP token rejected:', err.message);
    return refuse(req, res, 401, 'invalid_token', 'Invalid or expired token');
  }

  const scopes = String(decoded.scp || '').split(' ');
  if (!scopes.includes(MCP_SCOPE)) {
    return refuse(req, res, 403, 'insufficient_scope', `The token does not carry the ${MCP_SCOPE} scope`);
  }

  const access = accessFromClaims(decoded);
  if (!access || !hasPermission(access.permissions, MCP_PERMISSION)) {
    return res.status(403).json({
      error: 'Your Identity Atlas role does not include "Use the MCP server". Ask an administrator to add it to your role.',
      required: [MCP_PERMISSION],
    });
  }

  req.user = decoded;
  req.user.roles = access.roles;
  req.user.permissions = access.permissions;
  next();
}
