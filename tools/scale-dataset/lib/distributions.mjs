// The shape of the fixture: power-law sizes, weighted picks, exact selections.

// Zipf weights w[r] = 1 / (r+1)^exponent for ranks 0..n-1.
export function zipfWeights(n, exponent) {
  const w = new Float64Array(n);
  for (let r = 0; r < n; r++) w[r] = 1 / Math.pow(r + 1, exponent);
  return w;
}

function cappedSum(weights, scale, cap) {
  let sum = 0;
  for (let r = 0; r < weights.length; r++) {
    const v = Math.floor(scale * weights[r]);
    sum += v < 1 ? 1 : (v > cap ? cap : v);
  }
  return sum;
}

// Per-rank membership counts following a power law, clamped to [1, cap], that sum
// to EXACTLY `total`. count(r) ≈ C / (r+1)^exponent; C is solved by bisection so
// the head is as heavy as the total allows. With 800k entitlements, 40M
// assignments, exponent 1 and a cap near the principal count, that puts a few
// dozen entitlements at six-figure membership and the median at single digits —
// the long tail real directories have. Returns a Uint32Array indexed by rank
// (rank 0 = largest).
export function powerLawCounts(n, total, exponent, cap) {
  if (n < 1) return new Uint32Array(0);
  if (total < n) throw new Error(`powerLawCounts: total ${total} < ${n} ranks (every rank holds at least one)`);
  if (total > n * cap) throw new Error(`powerLawCounts: total ${total} exceeds ${n} ranks × cap ${cap}`);
  const w = zipfWeights(n, exponent);
  let lo = 0;
  let hi = total / w[n - 1] + 1; // at this scale every rank is capped or saturated
  for (let i = 0; i < 200 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (cappedSum(w, mid, cap) <= total) lo = mid; else hi = mid;
  }
  const counts = new Uint32Array(n);
  let sum = 0;
  for (let r = 0; r < n; r++) {
    const v = Math.floor(lo * w[r]);
    counts[r] = v < 1 ? 1 : (v > cap ? cap : v);
    sum += counts[r];
  }
  // Bisection leaves a small residual from the floors; hand it out one each to the
  // largest ranks that still have room, which keeps the order non-increasing.
  for (let r = 0; sum < total; r = (r + 1) % n) {
    if (counts[r] < cap) { counts[r]++; sum++; }
  }
  return counts;
}

// Fisher–Yates over a typed array, in place.
export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Weighted picker over normalised cumulative weights (binary search).
export function weightedPicker(weights) {
  const cum = new Float64Array(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; cum[i] = acc; }
  return (u) => {
    const target = u * acc;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid] > target) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
}

// Selection sampling (Knuth, Algorithm S): walks 0..n-1 once and marks exactly
// `k` of them, uniformly. Streaming — the caller asks per index, nothing is held.
export function exactSelector(n, k, rng) {
  let chosen = 0;
  let seen = 0;
  return () => {
    const take = (n - seen) * rng.next() < (k - chosen);
    seen++;
    if (take) chosen++;
    return take;
  };
}

export function median(sortedDesc) {
  const n = sortedDesc.length;
  if (n === 0) return 0;
  const m = n >>> 1;
  return n % 2 ? sortedDesc[m] : (sortedDesc[m - 1] + sortedDesc[m]) / 2;
}
