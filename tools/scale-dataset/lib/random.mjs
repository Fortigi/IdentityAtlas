// Seeded randomness and opaque ids for the scale test fixture.
//
// Everything the generator emits is a pure function of (parameters, seed). Each
// consumer asks for its own named stream (`stream(seed, 'users')`), so adding a
// draw to one file never shifts the values in another — a change to the user
// columns must not quietly re-shuffle every assignment.

// 32-bit string hash (FNV-1a) — turns a stream label into seed material.
export function hashLabel(label) {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// MurmurHash3's 32-bit finalizer. It is a BIJECTION on 32-bit integers, which is
// what makes the ids below unique without a lookup table: distinct inputs give
// distinct outputs, always.
export function fmix32(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// sfc32 — small, fast, well-distributed; returns floats in [0, 1).
function sfc32(a, b, c, d) {
  return function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

// A named, reproducible random stream: { next() → [0,1), int(n) → [0,n) }.
export function stream(seed, label) {
  const s = fmix32((seed >>> 0) ^ hashLabel(label));
  const next = sfc32(s, fmix32(s + 1), fmix32(s + 2), fmix32(s + 3));
  for (let i = 0; i < 12; i++) next(); // discard the warm-up outputs
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

// Opaque, globally unique external id: `<prefix>-<8 hex>`. fmix32 over
// (index XOR a per-kind key) is a bijection for a fixed seed, so two indices of
// one kind can never collide, and distinct prefixes keep kinds apart. Ids are
// NOT namespaced per system on purpose — see the README.
export function opaqueId(prefix, index, key) {
  return `${prefix}-${fmix32((index ^ key) >>> 0).toString(16).padStart(8, '0')}`;
}

export function idKey(seed, kind) {
  return fmix32((seed >>> 0) ^ hashLabel(`id:${kind}`));
}

export function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
