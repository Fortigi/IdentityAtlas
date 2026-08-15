import crypto from 'crypto';
import * as db from '../db/connection.js';
import {
  DENIAL,
  parseBearerKey,
  legacyHashDenial,
  enabledDenial,
  expiryDenial,
  effectiveRateLimit,
} from './crawlerAuth.helpers.js';

const useSql = process.env.USE_SQL === 'true';

// In-memory rate limit tracking: crawlerId -> { count, windowStart }
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000;

// Auth result cache: avoids running the expensive scrypt on every request.
// Key: `${crawlerId}:${apiKey}`. TTL: 60 seconds.
// On key rotation the new apiKey string is different → cache miss → re-verify.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

function getCachedAuth(crawlerId, apiKey) {
  const entry = authCache.get(`${crawlerId}:${apiKey}`);
  return (entry && Date.now() < entry.expires) ? entry.valid : null;
}

function setCachedAuth(crawlerId, apiKey, valid) {
  authCache.set(`${crawlerId}:${apiKey}`, { valid, expires: Date.now() + AUTH_CACHE_TTL_MS });
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

// Look up a crawler row by API-key prefix. Returns the row or null when no
// crawler matches. DB errors propagate to the caller.
async function findCrawlerByPrefix(prefix) {
  const r = await db.query(
    `SELECT id, "displayName", "apiKeyHash", "apiKeySalt", "systemIds", "permissions",
            "enabled", "expiresAt", "rateLimit"
       FROM "Crawlers"
      WHERE "apiKeyPrefix" = $1`,
    [prefix]
  );
  return r.rows.length ? r.rows[0] : null;
}

// Verify the presented key against the stored scrypt hash, using the auth cache
// to skip scrypt when a recent result exists. Returns a denial descriptor when
// the key is invalid, or null when it verifies.
function verifyKeyDenial(crawler, apiKey) {
  const cached = getCachedAuth(crawler.id, apiKey);
  if (cached === false) return DENIAL.invalidKey;
  if (cached === true) return null;

  const computedHash = hashKey(apiKey, crawler.apiKeySalt);
  const valid = crypto.timingSafeEqual(computedHash, crawler.apiKeyHash);
  setCachedAuth(crawler.id, apiKey, valid);
  return valid ? null : DENIAL.invalidKey;
}

function rateLimitDenial(crawler) {
  const limit = effectiveRateLimit(crawler.rateLimit, crawler.displayName);
  return checkRateLimit(crawler.id, limit) ? null : DENIAL.rateLimited;
}

// Run every post-lookup authorization check in order, short-circuiting on the
// first failure so each check's side effects (scrypt/cache, rate-limit counter)
// fire only when reached — matching the original sequential guard clauses.
function authorizeCrawler(crawler, apiKey) {
  return (
    legacyHashDenial(crawler.apiKeyHash) ||
    verifyKeyDenial(crawler, apiKey) ||
    enabledDenial(crawler.enabled) ||
    expiryDenial(crawler.expiresAt) ||
    rateLimitDenial(crawler)
  );
}

// Audit (when the denial carries an action) then send the rejection response.
async function denyRequest(req, res, crawlerId, denial) {
  if (denial.action) {
    await logAudit(crawlerId, denial.action, req.originalUrl, denial.status, req.ip);
  }
  return res.status(denial.status).json({ error: denial.error });
}

function attachCrawler(req, crawler) {
  // jsonb columns come back as JS arrays/objects already
  const systemIds = Array.isArray(crawler.systemIds) ? crawler.systemIds : null;
  const permissions = Array.isArray(crawler.permissions) ? crawler.permissions : ['ingest'];
  req.crawler = {
    id: crawler.id,
    displayName: crawler.displayName,
    systemIds,
    permissions,
  };
}

// Update lastUsedAt (fire-and-forget)
function touchLastUsed(crawlerId) {
  db.query(
    `UPDATE "Crawlers" SET "lastUsedAt" = (now() AT TIME ZONE 'utc') WHERE id = $1`,
    [crawlerId]
  ).catch(() => {});
}

export async function crawlerAuthMiddleware(req, res, next) {
  if (!useSql) {
    return res.status(503).json({ error: 'SQL not configured' });
  }

  const parsed = parseBearerKey(req.headers.authorization);
  if (!parsed) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }

  let crawler;
  try {
    crawler = await findCrawlerByPrefix(parsed.prefix);
  } catch (err) {
    console.error('Crawler auth DB error:', err.message);
    return res.status(500).json({ error: 'Authentication service error' });
  }
  if (!crawler) {
    return denyRequest(req, res, 0, DENIAL.invalidKey);
  }

  const denial = authorizeCrawler(crawler, parsed.apiKey);
  if (denial) {
    return denyRequest(req, res, crawler.id, denial);
  }

  attachCrawler(req, crawler);
  touchLastUsed(crawler.id);
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
