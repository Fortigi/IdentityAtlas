// Pure, dependency-free helpers for crawlerAuthMiddleware.
//
// Each `*Denial` helper returns a denial descriptor { status, error, action }
// (action = the CrawlerAuditLog action to record, or null for no audit) when a
// request should be rejected, or null when the check passes. The middleware
// short-circuits on the first denial, so ordering here mirrors the original
// sequential guard clauses.

export const DENIAL = {
  invalidKey: { status: 401, error: 'Invalid API key', action: 'auth_failed' },
  legacyHash: {
    status: 401,
    error: 'API key must be rotated (security upgrade required — use Admin → Crawlers → Reset Key)',
    action: 'auth_legacy_hash',
  },
  disabled: { status: 403, error: 'Crawler is disabled', action: 'auth_disabled' },
  expired: { status: 401, error: 'API key has expired', action: 'auth_expired' },
  rateLimited: { status: 429, error: 'Rate limit exceeded', action: 'rate_limited' },
};

// Parse a crawler API key out of the Authorization header.
// Returns { apiKey, prefix } for a valid `Bearer fgc_…` header, else null.
export function parseBearerKey(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer fgc_')) {
    return null;
  }
  const apiKey = authHeader.slice(7);
  return { apiKey, prefix: apiKey.slice(0, 8) };
}

// Legacy SHA-256 hashes are 32 bytes — require rotation before auth succeeds.
export function legacyHashDenial(apiKeyHash) {
  return (apiKeyHash && apiKeyHash.length === 32) ? DENIAL.legacyHash : null;
}

export function enabledDenial(enabled) {
  return enabled ? null : DENIAL.disabled;
}

export function expiryDenial(expiresAt) {
  return (expiresAt && new Date(expiresAt) < new Date()) ? DENIAL.expired : null;
}

// The built-in worker (created by bootstrap) needs a very high limit because
// the CSV crawler makes many small batches (one per system × entity type).
// Override the DB value for the built-in worker; external crawlers keep their
// configured limit (default 100) to prevent accidental DoS.
export function effectiveRateLimit(rateLimit, displayName) {
  const limit = rateLimit || 100;
  return displayName === 'Built-in Worker' ? Math.max(limit, 2000) : limit;
}
