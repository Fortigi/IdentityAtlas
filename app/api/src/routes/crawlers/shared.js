// Shared config + key helpers for the crawler endpoints.
//
// Extracted from routes/crawlers.js (audit finding C1) so the admin and
// self-service sub-routers share one definition of the API-key generation /
// hashing. No behaviour change — pure code move.

import crypto from 'crypto';

export const useSql = process.env.USE_SQL === 'true';

const KEY_PREFIX = 'fgc_';
const KEY_RANDOM_BYTES = 32;

export function generateApiKey() {
  const random = crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
  return `${KEY_PREFIX}${random}`;
}

// scrypt with OWASP-recommended params. dkLen=64 distinguishes the output from
// old 32-byte SHA-256 hashes so crawlerAuth.js can detect legacy keys and ask
// the admin to rotate them.
export function hashKey(apiKey, salt) {
  return crypto.scryptSync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
}
