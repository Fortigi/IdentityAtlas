// The cache in front of filter-value discovery.
//
// Discovering the distinct values a column can be filtered on means reading a
// whole table per column — seconds of work on a large tenant (measured: 2.2 s
// for Principals and 6.8 s for an 805 k-row Resources table). Every filter
// surface in the product is built from that answer, so it is cached.
//
// It lives in its own module, apart from the discovery it caches, for two
// reasons: the Identity side of discovery lives in routes/matrix/shared.js and
// needs the same behaviour without importing the Principal/Resource discovery
// with it, and a cache with this much policy in it deserves to be testable on
// its own.

// How long a discovered page counts as fresh, and how long past that it may
// still be handed out while a refresh runs behind it. See createValueCache.
export const COLUMN_CACHE_TTL = 5 * 60 * 1000;
export const STALE_GRACE = 4 * COLUMN_CACHE_TTL;

// How many distinct values we preload per column, and how many a value search
// returns. The preload is a hard payload cap: a column can have hundreds of
// thousands of distinct values (`description` in a real tenant) and shipping
// them all would blow up every filter-dropdown response.
export const DEFAULT_VALUE_PAGE_SIZE = 500;
export const MAX_VALUE_PAGE_SIZE = 5000;
export const VALUE_SEARCH_LIMIT = 50;

// The page size is a deployment setting (`MATRIX_VALUE_PAGE_SIZE`), not a
// constant, so the capped path can be exercised on a dataset that has nowhere
// near 500 distinct values. Set it to a handful on a test deployment and every
// column with more values than that is paged, flagged and searched exactly as
// `description` is in a tenant with tens of thousands of them — which is what
// makes #928 verifiable without first importing 500+ resources.
//
// Anything unparseable, zero or negative falls back to the default; the value
// is capped at MAX_VALUE_PAGE_SIZE so a typo can't turn every filter dropdown
// into a multi-megabyte response.
export function valuePageSize() {
  const raw = String(process.env.MATRIX_VALUE_PAGE_SIZE ?? '').trim();
  if (!raw) return DEFAULT_VALUE_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_VALUE_PAGE_SIZE;
  return Math.min(n, MAX_VALUE_PAGE_SIZE);
}

// One cached discovery result, served STALE WHILE IT REVALIDATES.
//
// With a plain expiry, every fifth minute one unlucky user waited for the
// whole discovery again — the TTL turned a cold cost into a recurring one.
// Past the TTL the cached page is handed out immediately and the refresh runs
// behind it, so only the very first caller after a process start ever waits.
// What that costs is freshness: a value ingested in the last few minutes can
// take one extra cycle to appear in a filter dropdown, which for a picker
// whose contents were already up to five minutes old is not a meaningful
// change.
//
// Stale is not served forever. If the refresh keeps failing the entry stops
// being trustworthy, so past STALE_GRACE the caller waits for a real answer
// (and gets the error) rather than being told stale values indefinitely.
//
// `pageSize` is part of the cached value, not just its key: a deployment that
// changes MATRIX_VALUE_PAGE_SIZE must not keep serving pages cut to the old
// size, not even as a stale stand-in.
export function createValueCache(label, load) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  let generation = 0;

  function refresh(pageSize) {
    if (inflight) return inflight;
    const startedAt = generation;
    inflight = (async () => {
      try {
        const result = { ...await load(pageSize), pageSize };
        // A clear() during the refresh means the caller wanted the cache gone;
        // repopulating it from a run that started before would resurrect it.
        if (generation === startedAt) { cached = result; cachedAt = Date.now(); }
        return result;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async get() {
      const pageSize = valuePageSize();
      const usable = cached && cached.pageSize === pageSize;
      const age = Date.now() - cachedAt;
      if (usable && age < COLUMN_CACHE_TTL) return cached;
      if (usable && age < STALE_GRACE) {
        refresh(pageSize).catch(err => console.error(`${label} value refresh failed:`, err.message));
        return cached;
      }
      return refresh(pageSize);
    },
    clear() { cached = null; cachedAt = 0; generation += 1; },
  };
}
