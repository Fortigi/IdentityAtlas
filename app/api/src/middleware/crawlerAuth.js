import crypto from 'crypto';
import * as db from '../db/connection.js';

const useSql = process.env.USE_SQL === 'true';

// In-memory rate limit tracking: crawlerId -> { count, windowStart }
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000;

// Auth result cache: avoids running the expensive scrypt on every request.
// TTL: 60 seconds. On key rotation the new apiKey string hashes differently →
// cache miss → re-verify.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

// Cache key: `${crawlerId}:${HMAC(apiKey)}`. We derive the key with a keyed HMAC
// (not a bare SHA of the credential — CodeQL rightly flags a bare hash of a
// credential as insufficient password hashing) so the PLAINTEXT crawler key is
// never retained in memory — it would otherwise sit in the Map's keys for the
// whole TTL, exposed to a heap dump. The HMAC secret is process-ephemeral: the
// cache is a per-process in-memory Map, so a fresh random secret per process is
// sufficient (and a cache key captured from one process can't be replayed
// against another). This is a fast keyed MAC — the cache exists to skip the
// *expensive* scrypt in hashKey(), not to avoid a hash — so it doesn't defeat
// the cache. Exported for unit testing.
const AUTH_CACHE_HMAC_SECRET = crypto.randomBytes(32);
export function authCacheKey(crawlerId, apiKey) {
  return `${crawlerId}:${crypto.createHmac('sha256', AUTH_CACHE_HMAC_SECRET).update(String(apiKey)).digest('hex')}`;
}

function getCachedAuth(crawlerId, apiKey) {
  const entry = authCache.get(authCacheKey(crawlerId, apiKey));
  return (entry && Date.now() < entry.expires) ? entry.valid : null;
}

function setCachedAuth(crawlerId, apiKey, valid) {
  authCache.set(authCacheKey(crawlerId, apiKey), { valid, expires: Date.now() + AUTH_CACHE_TTL_MS });
  if (authCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of authCache) { if (now >= v.expires) authCache.delete(k); }
  }
}

function checkRateLimit(crawlerId, limit) {
  const now = Date.now();
  const entry = rateLimits.get(crawlerId);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimits.set(crawlerId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

function hashKey(apiKey, salt) {
  return crypto.scryptSync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
}

async function logAudit(crawlerId, action, endpoint, statusCode, ipAddress) {
  try {
    await db.query(
      `INSERT INTO "CrawlerAuditLog" ("crawlerId", "action", "endpoint", "statusCode", "ipAddress")
       VALUES ($1, $2, $3, $4, $5)`,
      [crawlerId, action, endpoint, statusCode, (ipAddress || '').slice(0, 45)]
    );
  } catch {
    // Audit log failure should not block the request
  }
}

export async function crawlerAuthMiddleware(req, res, next) {
  if (!useSql) {
    return res.status(503).json({ error: 'SQL not configured' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer fgc_')) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }

  const apiKey = authHeader.slice(7);
  const prefix = apiKey.slice(0, 8);

  // Look up crawler by prefix
  let crawler;
  try {
    const r = await db.query(
      `SELECT id, "displayName", "apiKeyHash", "apiKeySalt", "systemIds", "permissions",
              "enabled", "expiresAt", "rateLimit"
         FROM "Crawlers"
        WHERE "apiKeyPrefix" = $1`,
      [prefix]
    );

    if (r.rows.length === 0) {
      await logAudit(0, 'auth_failed', req.originalUrl, 401, req.ip);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    crawler = r.rows[0];
  } catch (err) {
    console.error('Crawler auth DB error:', err.message);
    return res.status(500).json({ error: 'Authentication service error' });
  }

  // Verify hash. apiKeyHash and apiKeySalt come back as Node Buffers from pg.
  // Detect legacy SHA-256 hashes (32 bytes) — require rotation before auth succeeds.
  if (crawler.apiKeyHash && crawler.apiKeyHash.length === 32) {
    await logAudit(crawler.id, 'auth_legacy_hash', req.originalUrl, 401, req.ip);
    return res.status(401).json({ error: 'API key must be rotated (security upgrade required — use Admin → Crawlers → Reset Key)' });
  }
  // Check cache before running expensive scrypt
  const cached = getCachedAuth(crawler.id, apiKey);
  if (cached === false) {
    await logAudit(crawler.id, 'auth_failed', req.originalUrl, 401, req.ip);
    return res.status(401).json({ error: 'Invalid API key' });
  }
  if (cached !== true) {
    const computedHash = hashKey(apiKey, crawler.apiKeySalt);
    const valid = crypto.timingSafeEqual(computedHash, crawler.apiKeyHash);
    setCachedAuth(crawler.id, apiKey, valid);
    if (!valid) {
      await logAudit(crawler.id, 'auth_failed', req.originalUrl, 401, req.ip);
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  if (!crawler.enabled) {
    await logAudit(crawler.id, 'auth_disabled', req.originalUrl, 403, req.ip);
    return res.status(403).json({ error: 'Crawler is disabled' });
  }

  if (crawler.expiresAt && new Date(crawler.expiresAt) < new Date()) {
    await logAudit(crawler.id, 'auth_expired', req.originalUrl, 401, req.ip);
    return res.status(401).json({ error: 'API key has expired' });
  }

  // The built-in worker (created by bootstrap) needs a very high limit because
  // the CSV crawler makes many small batches (one per system × entity type).
  // Override the DB value for the built-in worker; external crawlers keep their
  // configured limit (default 100) to prevent accidental DoS.
  let effectiveLimit = crawler.rateLimit || 100;
  if (crawler.displayName === 'Built-in Worker') effectiveLimit = Math.max(effectiveLimit, 2000);
  if (!checkRateLimit(crawler.id, effectiveLimit)) {
    await logAudit(crawler.id, 'rate_limited', req.originalUrl, 429, req.ip);
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // jsonb columns come back as JS arrays/objects already
  const systemIds = Array.isArray(crawler.systemIds) ? crawler.systemIds : null;
  const permissions = Array.isArray(crawler.permissions) ? crawler.permissions : ['ingest'];

  req.crawler = {
    id: crawler.id,
    displayName: crawler.displayName,
    systemIds,
    permissions,
  };

  // Update lastUsedAt (fire-and-forget)
  db.query(
    `UPDATE "Crawlers" SET "lastUsedAt" = (now() AT TIME ZONE 'utc') WHERE id = $1`,
    [crawler.id]
  ).catch(() => {});

  next();
}

export function crawlerHasSystemAccess(req, systemId) {
  if (!req.crawler) return false;
  if (!req.crawler.systemIds) return true;
  return req.crawler.systemIds.includes(systemId);
}

export function crawlerHasPermission(req, permission) {
  if (!req.crawler) return false;
  return req.crawler.permissions.includes(permission);
}
