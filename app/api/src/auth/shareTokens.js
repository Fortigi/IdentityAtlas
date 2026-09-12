// Share-link tokens (`fgs_…`) — the lookup key for a shared matrix (#1166).
//
// Deliberately NOT an API credential: a share token authorizes nothing. The
// recipient signs in with their own Entra account and reads under their own
// JWT; the token only resolves which snapshot to show and stamps usage. That
// is why it never reaches middleware/auth.js and why `fgr_` read keys (which
// ARE credentials) can't be reused here.
//
// Storage follows the ReadApiKeys pattern — only the SHA-256 hash is kept, and
// `hashToken` is imported from readTokens.js rather than re-implemented. Plain
// SHA-256 (no salt) is sound for the same reason it is there: the plaintext is
// 32 random bytes of url-safe base64, so there is no dictionary to attack.

import crypto from 'crypto';
import { hashToken } from './readTokens.js';

export const SHARE_TOKEN_PREFIX = 'fgs_';
const TOKEN_RANDOM_BYTES = 32;

export { hashToken };

// A new plaintext share token. The caller shows it to the sharer exactly once
// and persists only the hash.
export function generateShareToken() {
  return `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

// True when a value has the shape of a share token. Used to reject junk before
// it reaches a database lookup.
export function isShareTokenFormat(token) {
  return typeof token === 'string'
    && token.startsWith(SHARE_TOKEN_PREFIX)
    && token.length > SHARE_TOKEN_PREFIX.length;
}
