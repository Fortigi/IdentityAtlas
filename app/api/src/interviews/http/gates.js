// Identity Atlas Interviews — the gates every interview route passes.
//
// Order matters and matches the other experimental areas: the permission is checked
// first (403), then the feature (404 while off), so a caller without the permission
// learns nothing about whether the feature exists.
//
//   READ  — data.read: the same people who can already see these names in the matrix
//   WRITE — data.write.contexts, reused for the MVP exactly as org truth does; a
//           dedicated `data.write.interviews` is the productisation step
//
// Read API keys (fgr_) are refused on every interview route, GETs included: what is
// said in an interview is personal data, and a long-lived BI token is the wrong key for it.

import rateLimit from 'express-rate-limit';
import { requirePermission, rejectReadTokens } from '../../middleware/auth.js';
import { requireFeature } from '../../featureFlags.js';
import { principalRateLimitKey } from '../../middleware/rateLimitKeys.js';
import { query } from '../../db/connection.js';
import { isUuid } from '../contracts.js';
import { loadInterview, ownerKeyOf } from '../store.js';

export const READ_GATE = [requirePermission('data.read'), rejectReadTokens, requireFeature('interviews')];
export const WRITE_GATE = [requirePermission('data.write.contexts'), rejectReadTokens, requireFeature('interviews')];

// Live lookups while recording: the client debounces and caches, so a steady
// conversation needs a handful a minute. 120 leaves room for a burst of names and
// still stops a client from walking the directory one name at a time.
export const SEARCH_PER_MINUTE = 120;

export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: SEARCH_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: principalRateLimitKey,
  message: { error: 'Too many lookups — slow down and try again in a minute' },
});

export function fail(res, route, err) {
  console.error(`interviews ${route} failed:`, err.message);
  res.status(500).json({ error: 'Request failed' });
}

/**
 * Loads the interview named by :id into req.interview — only for its owner. Another
 * caller's interview answers 404, not 403: it does not exist for them. An interview
 * past its retention date is gone for every read; deleting it is still allowed.
 */
export function ownedInterview({ allowExpired = false } = {}) {
  return async (req, res, next) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(403).json({ error: 'Your sign-in carries no object id' });
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Interview not found' });
    try {
      const row = await loadInterview(query, req.params.id);
      if (!row || row.ownerKey !== owner || (row.expired && !allowExpired)) {
        return res.status(404).json({ error: 'Interview not found' });
      }
      req.interview = row;
      req.owner = owner;
      next();
    } catch (err) {
      fail(res, 'load', err);
    }
  };
}
