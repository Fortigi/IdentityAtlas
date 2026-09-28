// Unit tests for the scale fixture's building blocks: seeded randomness, ids, the
// power-law distribution, selection, and parameter resolution. Run by the API
// Vitest suite (see app/api/vitest.config.js).
import { describe, it, expect } from 'vitest';
import { fmix32, stream, opaqueId, idKey, gcd, hashLabel } from './lib/random.mjs';
import { powerLawCounts, exactSelector, weightedPicker, shuffleInPlace, median, zipfWeights } from './lib/distributions.mjs';
import { resolveParams, DEFAULTS } from './lib/params.mjs';
import { coprimeStride, planLayerSizes, planManagers, managerStats, ORG_LAYER_SPANS } from './lib/plan.mjs';
import { nearCollision, collisionSource, connectorCatalog, entitlementValue } from './lib/names.mjs';

describe('random', () => {
  it('fmix32 is a bijection: 300k consecutive inputs give 300k distinct outputs', () => {
    const seen = new Set();
    for (let i = 0; i < 300000; i++) seen.add(fmix32(i));
    expect(seen.size).toBe(300000);
  });

  it('opaque ids are unique across a full-scale entitlement range and carry their prefix', () => {
    const key = idKey(DEFAULTS.seed, 'entitlement');
    const seen = new Set();
    for (let i = 0; i < 810000; i++) seen.add(opaqueId('E', i, key));
    expect(seen.size).toBe(810000);
    expect(opaqueId('E', 0, key)).toMatch(/^E-[0-9a-f]{8}$/);
  });

  it('ids differ per kind key, so the same index in two kinds never collides on the hex part', () => {
    expect(idKey(1, 'principal')).not.toBe(idKey(1, 'entitlement'));
    expect(idKey(1, 'principal')).not.toBe(idKey(2, 'principal'));
  });

  it('a named stream is reproducible and independent of other labels and seeds', () => {
    const draw = (seed, label) => { const r = stream(seed, label); return [r.next(), r.next(), r.int(1000)]; };
    expect(draw(5, 'users')).toEqual(draw(5, 'users'));
    expect(draw(5, 'users')).not.toEqual(draw(5, 'resources'));
    expect(draw(5, 'users')).not.toEqual(draw(6, 'users'));
  });

  it('stream values stay in [0,1) and int(n) in [0,n)', () => {
    const r = stream(1, 'range');
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v >= 0 && v < 1).toBe(true);
      const k = r.int(7);
      expect(k >= 0 && k < 7 && Number.isInteger(k)).toBe(true);
    }
  });

  it('hashLabel and gcd', () => {
    expect(hashLabel('a')).not.toBe(hashLabel('b'));
    expect(gcd(180000, 7)).toBe(1);
    expect(gcd(180000, 48)).toBe(48);
  });
});

describe('powerLawCounts — the assignment skew', () => {
  // The real target: 800k entitlements, 40M assignments, cap = 95% of 180k principals.
  const cap = Math.floor(180000 * 0.95);
  const counts = powerLawCounts(800000, 40000000, 1.0, cap);
  const sorted = Array.from(counts);

  it('sums to exactly the requested total', () => {
    expect(sorted.reduce((s, v) => s + v, 0)).toBe(40000000);
  });

  it('has a single-digit median and a handful of six-figure entitlements', () => {
    const m = median(sorted);
    expect(m).toBeGreaterThanOrEqual(1);
    expect(m).toBeLessThan(10);
    const sixFigure = sorted.filter(c => c >= 100000).length;
    expect(sixFigure).toBeGreaterThanOrEqual(5);
    expect(sixFigure).toBeLessThanOrEqual(100);
  });

  it('never exceeds the cap, ends in a tail of a handful each, and is non-increasing by rank', () => {
    expect(sorted[0]).toBe(cap);
    // count ≈ C/(r+1): with exponent 1 the last rank holds C/800000 ≈ 4.
    expect(sorted.at(-1)).toBeGreaterThanOrEqual(1);
    expect(sorted.at(-1)).toBeLessThanOrEqual(5);
    for (let r = 1; r < sorted.length; r++) if (sorted[r] > sorted[r - 1]) throw new Error(`rank ${r} rises`);
  });

  it('a steeper exponent concentrates more of the total in the head', () => {
    const top100 = (c) => Array.from(c).slice(0, 100).reduce((s, v) => s + v, 0);
    const flat = powerLawCounts(10000, 200000, 0.6, 5000);
    const steep = powerLawCounts(10000, 200000, 1.4, 5000);
    expect(top100(steep)).toBeGreaterThan(top100(flat));
    expect(median(Array.from(steep))).toBeLessThan(median(Array.from(flat)));
  });

  it('exponent 0 is uniform (every rank within one of the others)', () => {
    const c = powerLawCounts(7, 23, 0, 10);
    expect(Array.from(c).reduce((s, v) => s + v, 0)).toBe(23);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
  });

  it('refuses totals it cannot honour', () => {
    expect(() => powerLawCounts(10, 9, 1, 5)).toThrow(/at least one/);
    expect(() => powerLawCounts(10, 51, 1, 5)).toThrow(/exceeds/);
    expect(powerLawCounts(0, 0, 1, 5).length).toBe(0);
  });
});

describe('selection and picking', () => {
  it('exactSelector marks exactly k of n', () => {
    for (const [n, k] of [[180000, 45000], [10, 0], [10, 10], [1, 1], [997, 3]]) {
      const take = exactSelector(n, k, stream(3, `sel-${n}-${k}`));
      let chosen = 0;
      for (let i = 0; i < n; i++) if (take()) chosen++;
      expect(chosen).toBe(k);
    }
  });

  it('weightedPicker follows the weights', () => {
    const pick = weightedPicker([1, 3]);
    let zeros = 0;
    for (let i = 0; i < 1000; i++) if (pick(i / 1000) === 0) zeros++;
    expect(zeros).toBe(250);
    const only = weightedPicker([0, 5, 0]);
    expect([0, 0.3, 0.999].map(only)).toEqual([1, 1, 1]);
  });

  it('zipfWeights decreases as 1/r^a', () => {
    const w = zipfWeights(3, 2);
    expect(Array.from(w)).toEqual([1, 0.25, 1 / 9]);
  });

  it('shuffleInPlace permutes without losing values', () => {
    const a = Uint32Array.from({ length: 1000 }, (_, i) => i);
    shuffleInPlace(a, stream(1, 'shuffle'));
    expect(Array.from(a).sort((x, y) => x - y)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(a[0] === 0 && a[1] === 1 && a[2] === 2).toBe(false);
  });

  it('median of odd and even lists', () => {
    expect(median([9, 5, 1])).toBe(5);
    expect(median([9, 7, 3, 1])).toBe(5);
    expect(median([])).toBe(0);
  });

  it('coprimeStride walks every principal exactly once', () => {
    for (const n of [180000, 1800, 12, 2, 1]) {
      const s = coprimeStride(n, stream(9, `stride-${n}`));
      expect(gcd(s, n)).toBe(1);
      const seen = new Set();
      let p = 0;
      for (let j = 0; j < n; j++) { seen.add(p); p = (p + s) % n; }
      expect(seen.size).toBe(n);
    }
  });
});

describe('the manager hierarchy', () => {
  const sizes = [1, 2, 3, 10, 100, 900, 180000];

  it('layer sizes sum to the population and never leave a base narrower than its managers', () => {
    for (const n of sizes) {
      const layers = planLayerSizes(n);
      expect(layers.reduce((s, v) => s + v, 0)).toBe(n);
      expect(layers[0]).toBe(1);
      if (layers.length > 1) expect(layers.at(-1)).toBeGreaterThanOrEqual(layers.at(-2));
    }
  });

  it('is a pyramid: every layer wider than the one above it', () => {
    const layers = planLayerSizes(180000);
    for (let k = 1; k < layers.length; k++) expect(layers[k]).toBeGreaterThan(layers[k - 1]);
    expect(layers.length).toBe(ORG_LAYER_SPANS.length + 2);   // top + spans + base
  });

  it('nobody manages themselves and no chain loops — at every size', () => {
    for (const n of sizes) {
      const m = planManagers(n, 0.04, stream(5, `mgr-${n}`));
      expect(m.length).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(m[i]).not.toBe(i);
        // A manager at a lower index is what makes a loop impossible; assert the
        // invariant itself, not just the absence of the shortest loop.
        expect(m[i]).toBeLessThan(i);
        expect(m[i]).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it('walking up from anybody terminates', () => {
    const n = 5000;
    const m = planManagers(n, 0.04, stream(5, 'walk'));
    for (let i = 0; i < n; i++) {
      let steps = 0;
      for (let cur = i; m[cur] >= 0; cur = m[cur]) {
        if (++steps > n) throw new Error(`cycle reached from ${i}`);
      }
      expect(steps).toBeLessThan(20);
    }
  });

  it('is shaped like an organisation, not a flat fan-out', () => {
    const m = planManagers(180000, 0.04, stream(5, 'shape'));
    const s = managerStats(m);
    // Most people manage nobody.
    expect(s.managers / 180000).toBeLessThan(0.1);
    // A handful of levels, not two and not forty.
    expect(s.levels).toBeGreaterThanOrEqual(5);
    expect(s.levels).toBeLessThanOrEqual(9);
    // A few carry a large team while the typical one carries a handful: a
    // uniform fan-out would put max and median within a factor of two.
    expect(s.maxDirectReports).toBeGreaterThan(4 * s.medianDirectReports);
    expect(s.medianDirectReports).toBeGreaterThanOrEqual(5);
    expect(s.medianDirectReports).toBeLessThanOrEqual(20);
  });

  it('leaves a share with no manager at all, so both halves of "has a manager" exist', () => {
    const n = 20000;
    const withNone = (share) => managerStats(planManagers(n, share, stream(5, 'none'))).principalsWithoutManager;
    // The top of the tree accounts for exactly one; the rest is the share.
    expect(withNone(0)).toBe(1);
    expect(withNone(0.04)).toBeGreaterThan(0.03 * n);
    expect(withNone(0.04)).toBeLessThan(0.05 * n);
    expect(withNone(0.5)).toBeGreaterThan(withNone(0.04));
  });

  it('clearing a manager never orphans a subtree — only the base layer loses one', () => {
    const n = 20000;
    const m = planManagers(n, 0.25, stream(5, 'orphan'));
    const hasReports = new Set();
    for (let i = 0; i < n; i++) if (m[i] >= 0) hasReports.add(m[i]);
    // Nobody who manages somebody was left without a manager, except the person
    // at the top — otherwise a quarter of the org chart would hang off no root.
    expect([...hasReports].filter(i => i !== 0 && m[i] === -1)).toEqual([]);
    expect(hasReports.size).toBeGreaterThan(0);
  });

  it('is reproducible from the seed and changes with it', () => {
    const a = planManagers(3000, 0.04, stream(7, 'repro'));
    const b = planManagers(3000, 0.04, stream(7, 'repro'));
    const c = planManagers(3000, 0.04, stream(8, 'repro'));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('managerStats counts what it says: reports, managers and depth', () => {
    // 0 at the top, 1 and 2 report to 0, 3 reports to 1, 4 reports to nobody.
    const s = managerStats(Int32Array.from([-1, 0, 0, 1, -1]));
    expect(s).toEqual({
      principalsWithManager: 3, principalsWithoutManager: 2, managers: 2,
      maxDirectReports: 2, medianDirectReports: 1.5, levels: 3,
    });
  });
});

describe('names', () => {
  it('near-collisions differ from the original but match it case-insensitively after trimming', () => {
    for (const name of ['Ana B. Cohen', 'CN=GRP-AP-READ-X,OU=Groups,DC=corp', 'ERP01_AP_READ_X', 'lower only']) {
      for (let v = 0; v < 3; v++) {
        const c = nearCollision(name, v);
        expect(c).not.toBe(name);
        expect(c.trimEnd().toLowerCase()).toBe(name.toLowerCase());
      }
    }
  });

  it('collisionSource points at an EARLIER row, at roughly the configured share', () => {
    let hits = 0;
    for (let i = 0; i < 100000; i++) {
      const src = collisionSource(i, 42, 0.01);
      if (src >= 0) { hits++; expect(src).toBeLessThan(i); }
    }
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
    expect(collisionSource(0, 42, 1)).toBe(-1);
    expect(collisionSource(5, 42, 0)).toBe(-1);
  });

  it('the largest connector is always directory-style, and directory values are DNs with commas', () => {
    const cat = connectorCatalog(40, 0, stream(1, 'c'));
    expect(cat[0].directory).toBe(true);
    expect(cat.slice(1).some(c => c.directory)).toBe(false);
    const dn = entitlementValue(3, 99, cat[0]);
    expect(dn).toMatch(/^CN=[^,]+,OU=[^,]+,OU=[^,]+,DC=corp,DC=example,DC=com$/);
    expect(entitlementValue(3, 99, cat[1])).not.toContain(',');
  });
});

describe('resolveParams', () => {
  it('scales volumes but keeps the shape ratios and the connector count', () => {
    const p = resolveParams({ scale: 0.01 });
    expect(p.principals).toBe(1800);
    expect(p.enabledPrincipals).toBe(450);
    expect(p.entitlements).toBe(8000);
    expect(p.entitlementAssignments).toBe(400000);
    expect(p.roleAssignments).toBe(10000);
    expect(p.logicalApplications).toBe(15);
    expect(p.connectors).toBe(40);
    expect(p.holderCap).toBe(1710);
  });

  it('full scale matches the target volumes', () => {
    const p = resolveParams();
    expect([p.principals, p.enabledPrincipals, p.entitlements, p.roles, p.entitlementAssignments, p.roleAssignments])
      .toEqual([180000, 45000, 800000, 10000, 40000000, 1000000]);
  });

  it('keeps tiny runs feasible', () => {
    const p = resolveParams({ scale: 1, entitlements: 3, principals: 2, entitlementAssignments: 1, roleAssignments: 999999 });
    expect(p.connectors).toBe(3);
    expect(p.entitlementAssignments).toBe(3);            // at least one holder each
    expect(p.roleAssignments).toBe(p.roles * p.holderCap); // at most cap each
  });

  it('rejects invalid input', () => {
    expect(() => resolveParams({ scale: 0 })).toThrow(/scale/);
    expect(() => resolveParams({ seed: 1.5 })).toThrow(/seed/);
    expect(() => resolveParams({ enabledShare: 1.2 })).toThrow(/enabledShare/);
    expect(() => resolveParams({ connectors: 300 })).toThrow(/255/);
  });
});
