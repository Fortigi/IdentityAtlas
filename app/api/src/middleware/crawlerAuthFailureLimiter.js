// Pre-hash failure limiter for crawler API-key authentication
// (SEC-2026-09 M-04).
//
// Every unseen crawler key costs a DB lookup and, when the prefix matches, a
// deliberately expensive scrypt. The per-crawler request limit only runs after
// that work, so it cannot protect it. This limiter is consulted BEFORE the
// lookup: once a client has failed too often in the current window it is
// answered immediately, without touching the database or the hash.
//
// Two buckets per failure:
//   (client, key prefix) — stops hammering one crawler's prefix
//   (client)             — stops walking through prefixes
// A legitimate crawler never fails, so neither bucket affects it.

const DEFAULTS = {
  windowMs: 60_000,
  maxPerPrefix: 10,
  maxPerClient: 100,
  maxEntries: 10_000,
};

export function createFailureLimiter(options = {}) {
  const { windowMs, maxPerPrefix, maxPerClient, maxEntries } = { ...DEFAULTS, ...options };
  const now = options.now || Date.now;
  const buckets = new Map();

  function liveCount(key) {
    const entry = buckets.get(key);
    if (!entry || now() - entry.windowStart >= windowMs) return 0;
    return entry.count;
  }

  function bump(key) {
    const t = now();
    const entry = buckets.get(key);
    if (!entry || t - entry.windowStart >= windowMs) {
      buckets.set(key, { count: 1, windowStart: t });
    } else {
      entry.count++;
    }
  }

  function sweep() {
    if (buckets.size <= maxEntries) return;
    const t = now();
    for (const [k, v] of buckets) {
      if (t - v.windowStart >= windowMs) buckets.delete(k);
    }
    // Still flooded with live entries: start over rather than grow unbounded.
    if (buckets.size > maxEntries) buckets.clear();
  }

  return {
    isBlocked(client, prefix) {
      return liveCount(`c|${client}`) >= maxPerClient || liveCount(`p|${client}|${prefix}`) >= maxPerPrefix;
    },
    recordFailure(client, prefix) {
      bump(`c|${client}`);
      bump(`p|${client}|${prefix}`);
      sweep();
    },
    size() {
      return buckets.size;
    },
  };
}
