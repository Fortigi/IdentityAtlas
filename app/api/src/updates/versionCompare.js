// Compare Identity Atlas version strings. Two shapes occur in the wild:
//   - 4-segment numeric: releases `5.2.1.0`, edge builds `5.310.20260629.1221`
//   - prerelease suffix:  betas `5.3.0-beta.2`
//
// Numeric segments compare left-to-right; a release (no prerelease) outranks a
// prerelease of the same core; among prereleases the higher `-beta.N` wins.
// Pure + dependency-free so it's trivially unit-testable.

export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/^v/i, '');
  if (!cleaned) return null;
  const [core, pre] = cleaned.split('-');
  const nums = core.split('.').map((n) => parseInt(n, 10));
  if (nums.length === 0 || nums.some(Number.isNaN)) return null;
  let preNum = null;
  if (pre) {
    const m = pre.match(/(\d+)/);
    preNum = m ? parseInt(m[1], 10) : 0;
  }
  return { nums, pre: pre || null, preNum };
}

// -1 if a < b, 0 if equal, 1 if a > b. Unparseable inputs compare as equal (0)
// so a bad value never spuriously reports "an update is available".
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Same numeric core: a final release beats a prerelease.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre && pa.preNum !== pb.preNum) {
    return pa.preNum < pb.preNum ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}
