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
    ...applicationSpan(plan),
  };
}
