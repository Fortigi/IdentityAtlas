// A small least-recently-used cache for resolved effective-access results.
//
// Extracted from engine.js so it can be tested and measured directly. Inside the engine it
// was reachable only through resolve(), which needs a database and enough distinct keys to
// force an eviction -- so nothing exercised the recency or eviction behaviour at all, and a
// broken cache is silent in both directions: it either serves an access decision that is no
// longer true, or never evicts and grows without bound.
//
// P1 placeholder for the `lru-cache` package (spec D3/D8 prescribe a byte-bounded cache); the
// correctness-relevant behaviour -- keying on dataVersion so a completed sync invalidates
// every entry -- is identical. Swap the implementation when the dependency is wired; callers
// don't change.
export function createLru(max) {
  const map = new Map(); // insertion-ordered → front = oldest
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v); // move to most-recent
      return v;
    },
    set(key, v) {
      if (map.has(key)) map.delete(key);
      map.set(key, v);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}
