import crypto from 'crypto';
import { promisify } from 'util';
import * as db from '../db/connection.js';
import { createFailureLimiter } from './crawlerAuthFailureLimiter.js';
import { stripPort } from './rateLimitKeys.js';
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
// Key: `${crawlerId}:<digest of apiKey>`, so the plaintext key is never retained
// in memory as a Map key (SEC-2026-09 I-03). TTL: 60 seconds.
// On key rotation the new apiKey string is different → cache miss → re-verify.
//
// The digest is a deliberately cheap scrypt under a per-process random salt:
// it is an in-memory lookup key for a 256-bit random API key, not a stored
// verifier (that is the full-cost scrypt hash in Crawlers), so it only has to
// be one-way and unlinkable across processes, and it must stay far cheaper than
// the verification it lets us skip (~0.2 ms vs ~26 ms).
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_SALT = crypto.randomBytes(16);
const AUTH_CACHE_DIGEST = { N: 1024, r: 1, p: 1 };

export function authCacheKey(crawlerId, apiKey) {
  return `${crawlerId}:${crypto.scryptSync(String(apiKey), AUTH_CACHE_SALT, 32, AUTH_CACHE_DIGEST).toString('hex')}`;
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

// Async scrypt (SEC-2026-09 M-04): the synchronous variant blocked the event
// loop for every unseen key, so a stream of invalid keys stalled every request.
const scryptAsync = promisify(crypto.scrypt);
function hashKey(apiKey, salt) {
  return scryptAsync(apiKey, salt, 64, { N: 16384, r: 8, p: 1 });
}

// Consulted before the prefix lookup and the hash — see crawlerAuthFailureLimiter.js.
const failureLimiter = createFailureLimiter();

// Denials that do not prove possession of the key count as failed attempts.
function isKeyFailure(denial) {
  return denial === DENIAL.invalidKey || denial === DENIAL.legacyHash;
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
            "enabled", "expiresAt", "rateLimit", "isBuiltIn"
       FROM "Crawlers"
      WHERE "apiKeyPrefix" = $1`,
    [prefix]
  );
  return r.rows.length ? r.rows[0] : null;
}

// Verify the presented key against the stored scrypt hash, using the auth cache
// to skip scrypt when a recent result exists. Returns a denial descriptor when
// the key is invalid, or null when it verifies.
async function verifyKeyDenial(crawler, apiKey) {
  const cached = getCachedAuth(crawler.id, apiKey);
  if (cached === false) return DENIAL.invalidKey;
  if (cached === true) return null;

  const computedHash = await hashKey(apiKey, crawler.apiKeySalt);
  const valid = crypto.timingSafeEqual(computedHash, crawler.apiKeyHash);
  setCachedAuth(crawler.id, apiKey, valid);
  return valid ? null : DENIAL.invalidKey;
}

function rateLimitDenial(crawler) {
  const limit = effectiveRateLimit(crawler.rateLimit, crawler.isBuiltIn);
  return checkRateLimit(crawler.id, limit) ? null : DENIAL.rateLimited;
}

// Run every post-lookup authorization check in order, short-circuiting on the
// first failure so each check's side effects (scrypt/cache, rate-limit counter)
// fire only when reached — matching the original sequential guard clauses.
async function authorizeCrawler(crawler, apiKey) {
  return (
    legacyHashDenial(crawler.apiKeyHash) ||
    (await verifyKeyDenial(crawler, apiKey)) ||
    enabledDenial(crawler.enabled) ||
    expiryDenial(crawler.expiresAt) ||
    rateLimitDenial(crawler)
  );
}

// Audit (when the denial carries an action) then send the rejection response.
async function denyRequest(req, res, crawlerId, denial) {
  if (isKeyFailure(denial)) {
    failureLimiter.recordFailure(stripPort(req.ip), parseBearerKey(req.headers.authorization)?.prefix);
  }
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
  // Already authenticated earlier in this request's middleware chain (the
  // middleware is mounted more than once) — don't look up, hash or count again.
  if (req.crawler) return next();
  if (!useSql) {
    return res.status(503).json({ error: 'SQL not configured' });
  }

  const parsed = parseBearerKey(req.headers.authorization);
  if (!parsed) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  if (failureLimiter.isBlocked(stripPort(req.ip), parsed.prefix)) {
    return res.status(429).json({ error: 'Too many failed authentication attempts, please retry later' });
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

  const denial = await authorizeCrawler(crawler, parsed.apiKey);
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
