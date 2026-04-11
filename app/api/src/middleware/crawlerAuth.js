import crypto from 'crypto';
import * as db from '../db/connection.js';

const useSql = process.env.USE_SQL === 'true';

// In-memory rate limit tracking: crawlerId -> { count, windowStart }
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000;

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
  return crypto.createHash('sha256').update(Buffer.concat([salt, Buffer.from(apiKey, 'utf8')])).digest();
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
  const computedHash = hashKey(apiKey, crawler.apiKeySalt);
  if (!crypto.timingSafeEqual(computedHash, crawler.apiKeyHash)) {
    await logAudit(crawler.id, 'auth_failed', req.originalUrl, 401, req.ip);
    return res.status(401).json({ error: 'Invalid API key' });
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
