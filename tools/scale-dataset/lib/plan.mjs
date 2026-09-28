// The plan: every structural decision about the fixture, made once, up front, in
// small typed arrays (one slot per entitlement / role / principal — never one per
// assignment). The emitters then stream the files from it. At full scale the plan
// is a few tens of MB; the 41M assignment rows are derived on the fly.

import { stream, idKey, gcd } from './random.mjs';
import { zipfWeights, powerLawCounts, shuffleInPlace, weightedPicker, exactSelector, median } from './distributions.mjs';
import { connectorCatalog } from './names.mjs';

export const IDENTITY_STORE = Object.freeze({ name: 'Identity Store', type: 'IGA', code: 'IGA00' });

// Each logical application has a home connector and a few secondary ones. Built
// so every connector is somebody's home when there are enough applications.
function planApplications(p, connectorPick, rng) {
  const homes = new Uint32Array(p.logicalApplications);
  const secondaries = [];
  for (let a = 0; a < p.logicalApplications; a++) {
    const home = a < p.connectors ? a : connectorPick(rng.next());
    homes[a] = home;
    // 0..max secondaries: most applications span systems, some stay in one.
    const wanted = p.connectors > 1 ? rng.int(p.maxSecondaryConnectors + 1) : 0;
    const set = new Set();
    for (let tries = 0; set.size < wanted && tries < wanted * 20; tries++) {
      const c = connectorPick(rng.next());
      if (c !== home) set.add(c);
    }
    secondaries.push([...set]);
  }
  return { homes, secondaries };
}

// connector → { apps, pick } for apps homed there / listing it as secondary.
function indexApplications(p, apps, appWeights) {
  const home = Array.from({ length: p.connectors }, () => []);
  const secondary = Array.from({ length: p.connectors }, () => []);
  for (let a = 0; a < p.logicalApplications; a++) {
    home[apps.homes[a]].push(a);
    for (const c of apps.secondaries[a]) secondary[c].push(a);
  }
  const withPicker = (list) => ({ list, pick: weightedPicker(list.map(a => appWeights[a])) });
  return { home: home.map(withPicker), secondary: secondary.map(withPicker) };
}

function chooseApplication(c, u, cross, idx, anyApp) {
  const home = idx.home[c];
  const sec = idx.secondary[c];
  const useSecondary = (cross && sec.list.length > 0) || home.list.length === 0;
  if (useSecondary && sec.list.length > 0) return sec.list[sec.pick(u)];
  if (home.list.length > 0) return home.list[home.pick(u)];
  return anyApp(u);
}

function planEntitlements(p, connectorPick, apps, rng) {
  const appWeights = zipfWeights(p.logicalApplications, p.applicationSkew);
  const idx = indexApplications(p, apps, appWeights);
  const anyApp = weightedPicker(appWeights);
  const connector = new Uint8Array(p.entitlements);
  const app = new Uint32Array(p.entitlements);
  for (let e = 0; e < p.entitlements; e++) {
    const c = connectorPick(rng.next());
    connector[e] = c;
    app[e] = chooseApplication(c, rng.next(), rng.next() < p.crossSystemShare, idx, anyApp);
  }
  return { connector, app };
}

function planHolderCounts(n, total, skew, cap, rng) {
  return shuffleInPlace(powerLawCounts(n, total, skew, cap), rng);
}

function planPrincipals(p, rng) {
  const enabled = new Uint8Array(p.principals);
  const take = exactSelector(p.principals, p.enabledPrincipals, rng);
  for (let i = 0; i < p.principals; i++) enabled[i] = take() ? 1 : 0;
  return enabled;
}

// ─── The manager hierarchy ───────────────────────────────────────────────────
//
// An org chart, not a uniform fan-out. Built top-down in layers: one person at
// the top, each layer a multiple of the one above it, and everyone left over in
// the base — the individual contributors, who manage nobody. Within a layer the
// team sizes follow a power law, so a few managers carry a large team, most
// carry a handful, and the tail carries one or two.
//
// Why it matters that this is not uniform: the org-chart walk, the manager
// hierarchy context plugin and the "manager of" reference filter all recurse.
// A uniform two-level fan-out exercises one level of recursion at one width and
// says nothing about a 40-person department under a 6-person executive layer.
//
// Cycles and self-management: a manager is always at a LOWER index than their
// report, by construction, which makes both impossible rather than unlikely.
// Both are asserted in the tests anyway — "impossible by construction" is what
// was said about the last hierarchy that turned out to contain a loop, and a
// real directory contains both (a self-managing CEO record is routine).

// Each layer is this multiple of the layer above it, from the top down.
export const ORG_LAYER_SPANS = Object.freeze([4, 5, 6, 8, 10]);
// A layer is only added while the remainder can still form a base at least this
// many times wider than it — otherwise the "base" would be narrower than the
// layer managing it and most of that layer would manage nobody.
export const ORG_MIN_BASE_SPAN = 6;
// Team size within a layer ∝ 1/(rank+1)^exponent, clamped to [1, cap].
export const ORG_SPAN_SKEW = 0.55;
export const ORG_SPAN_CAP = 90;

// Layer sizes from the top down, summing to exactly `n`. The last entry is the
// base: everyone who manages nobody.
export function planLayerSizes(n, spans = ORG_LAYER_SPANS, minBaseSpan = ORG_MIN_BASE_SPAN) {
  if (n <= 0) return [];
  if (n === 1) return [1];
  const sizes = [1];
  let used = 1;
  for (const s of spans) {
    const next = Math.max(1, Math.round(sizes[sizes.length - 1] * s));
    if (n - used - next < next * minBaseSpan) break;
    sizes.push(next);
    used += next;
  }
  sizes.push(n - used);
  return sizes;
}

// managers[i] = the index of i's manager, or -1 for the person at the top and
// for the share who report to nobody. An Int32Array of one slot per principal —
// 720 KB at full scale, versus a row per assignment, which is the rule the whole
// plan follows.
export function planManagers(n, managerlessShare, rng) {
  const managers = new Int32Array(n).fill(-1);
  const layers = planLayerSizes(n);
  let parentStart = 0;
  let start = layers[0] ?? 0;
  for (let k = 1; k < layers.length; k++) {
    const parents = layers[k - 1];
    const size = layers[k];
    const cap = Math.max(Math.ceil(size / parents), Math.min(ORG_SPAN_CAP, size));
    const teams = shuffleInPlace(powerLawCounts(parents, size, ORG_SPAN_SKEW, cap), rng);
    let child = start;
    const end = start + size;
    for (let m = 0; m < parents && child < end; m++) {
      for (let c = 0; c < teams[m] && child < end; c++) managers[child++] = parentStart + m;
    }
    parentStart = start;
    start = end;
  }

  // Not everyone reports to somebody: contractors, service accounts, and records
  // whose manager has left. A directory where every single row has a manager is
  // as unrealistic as one where none does — and it leaves the "has no manager"
  // half of every reference filter, and the Missing Managers report, with
  // nothing to find. Cleared only in the base layer, so no subtree is orphaned.
  const base = layers.length > 1 ? layers[layers.length - 1] : 0;
  const wanted = Math.round(base * managerlessShare);
  if (wanted > 0) {
    const take = exactSelector(base, wanted, rng);
    for (let i = n - base; i < n; i++) if (take()) managers[i] = -1;
  }
  return managers;
}

// Depth / span facts for the manifest, straight off the plan.
export function managerStats(managers) {
  const n = managers.length;
  const reports = new Uint32Array(n);
  let withManager = 0;
  for (let i = 0; i < n; i++) {
    if (managers[i] >= 0) { reports[managers[i]]++; withManager++; }
  }
  const spans = Array.from(reports).filter(c => c > 0).sort((a, b) => b - a);
  const depth = new Uint16Array(n);
  let maxDepth = 0;
  for (let i = 0; i < n; i++) {
    const m = managers[i];
    depth[i] = m < 0 ? 0 : depth[m] + 1;   // m < i always, so depth[m] is already final
    if (depth[i] > maxDepth) maxDepth = depth[i];
  }
  return {
    principalsWithManager: withManager,
    principalsWithoutManager: n - withManager,
    managers: spans.length,
    maxDirectReports: spans[0] ?? 0,
    medianDirectReports: median(spans),
    levels: maxDepth + 1,
  };
}

// A stride coprime with `n` walks n distinct principals from any start.
export function coprimeStride(n, rng) {
  if (n <= 2) return 1;
  let s = 1 + rng.int(n - 1);
  while (gcd(s, n) !== 1) s = s + 1 === n ? 1 : s + 1;
  return s;
}

export function buildPlan(p) {
  const rng = (label) => stream(p.seed, label);
  const connectors = connectorCatalog(p.connectors, p.directoryConnectorShare, rng('connectors'));
  const connectorPick = weightedPicker(zipfWeights(p.connectors, p.connectorSkew));
  const apps = planApplications(p, connectorPick, rng('applications'));
  const ent = planEntitlements(p, connectorPick, apps, rng('entitlements'));
  return {
    params: p,
    connectors,
    apps,
    entConnector: ent.connector,
    entApp: ent.app,
    entHolders: planHolderCounts(p.entitlements, p.entitlementAssignments, p.assignmentSkew, p.holderCap, rng('entitlement-holders')),
    roleHolders: planHolderCounts(p.roles, p.roleAssignments, p.roleAssignmentSkew, p.holderCap, rng('role-holders')),
    enabled: planPrincipals(p, rng('principals-enabled')),
    managers: planManagers(p.principals, p.managerlessShare, rng('managers')),
    keys: {
      system: idKey(p.seed, 'system'),
      app: idKey(p.seed, 'application'),
      entitlement: idKey(p.seed, 'entitlement'),
      role: idKey(p.seed, 'role'),
      principal: idKey(p.seed, 'principal'),
      name: idKey(p.seed, 'name'),
    },
  };
}

function countBy(arr, n) {
  const out = new Array(n).fill(0);
  for (let i = 0; i < arr.length; i++) out[arr[i]]++;
  return out;
}

function applicationSpan(plan) {
  const spans = Array.from({ length: plan.params.logicalApplications }, () => new Set());
  for (let e = 0; e < plan.entApp.length; e++) spans[plan.entApp[e]].add(plan.entConnector[e]);
  const nonEmpty = spans.filter(s => s.size > 0);
  const multi = nonEmpty.filter(s => s.size > 1).length;
  return {
    applicationsWithMembers: nonEmpty.length,
    applicationsSpanningSystems: multi,
    maxSystemsPerApplication: nonEmpty.reduce((m, s) => Math.max(m, s.size), 0),
  };
}

function holderStats(counts, threshold) {
  const sorted = Array.from(counts).sort((a, b) => b - a);
  return {
    max: sorted[0] ?? 0,
    median: median(sorted),
    top10: sorted.slice(0, 10),
    atOrAbove100k: sorted.filter(c => c >= threshold).length,
  };
}

// Shape facts for the manifest, computed from the plan (no file is re-read).
export function planStats(plan) {
  const perConnector = countBy(plan.entConnector, plan.params.connectors);
  return {
    enabledPrincipals: plan.enabled.reduce((s, v) => s + v, 0),
    entitlementHolders: holderStats(plan.entHolders, 100000),
    roleHolders: holderStats(plan.roleHolders, 100000),
    entitlementsPerConnector: plan.connectors.map((c, i) => ({ system: c.name, entitlements: perConnector[i] })),
    managerHierarchy: managerStats(plan.managers),
    ...applicationSpan(plan),
  };
}
