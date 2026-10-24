// Parameters of the IdentityIQ-shaped fixture.
//
// The SHAPE (volumes, skew, enabled share, systems spread, applications spanning
// systems, commas, near-collisions) is the scale-dataset fixture's, imported and
// never edited here: both fixtures must describe the same dataset, so a load
// through the CSV crawler and a load through the SQL crawler can be compared.
// Override a shape value at the call site (`shape: { scale: 0.01 }`), not in
// that module.
//
// What is added here is only how IdentityIQ stores that dataset. The customer-
// specific names (the catalogue record, the XML keys) are parameters with
// neutral defaults.

import { resolveParams } from '../../scale-dataset/lib/params.mjs';

export const IIQ_DEFAULTS = Object.freeze({
  // spt_custom record holding the logical-application catalogue.
  catalogName: 'Application_Catalog',
  // Key, inside each entitlement's attributes XML, naming its logical application.
  appNameKey: 'LogicalApplication',
  // Keys of the fields inside each catalogue entry, in order.
  catalogKeys: Object.freeze(['abbreviation', 'applicationOwner', 'cmdbReference', 'connectionType', 'description', 'onboardingArea', 'owner']),
  // Every timestamp is relative to this instant, so a run does not depend on the
  // clock. Epoch milliseconds, like IdentityIQ's own numeric(19,0) columns.
  asOf: Date.UTC(2026, 8, 1),
  historyDays: 3650,
  // Workgroups live in spt_identity next to people (workgroup = 1). Extra rows on
  // top of the shared principal count, so they never change the shared shape.
  workgroups: 60,
  // Share of entitlement grants that came from a role (granted_by_role = 1),
  // which Identity Atlas stores as Indirect.
  roleGrantedShare: 0.2,
  // Share of grants requested through LCM (assigned = 1) rather than aggregated.
  requestedShare: 0.15,
  // Share of entitlements with an owner.
  ownedShare: 0.6,
  // Entitlements per role in spt_bundle_profile_relation.
  roleSizeMin: 1,
  roleSizeMax: 12,
  // Share of entitlements whose logical-application name differs from the
  // catalogue's only by case or a trailing space (the match is by name).
  appNameDriftShare: 0.002,
  // Share of entitlements with no logical application at all.
  unassignedAppShare: 0,
  // spt_managed_attribute.type, as [type, share] pairs summing to 1. In a real
  // instance this is the schema object type the entitlement came from, and
  // 'Entitlement' is a small minority: most rows are account groups. A statement
  // that filters on type = 'Entitlement' therefore loads almost nothing, which a
  // fixture holding only 'Entitlement' rows could never show. Shape follows a
  // production discovery, rounded; the custom type stands for a site's own.
  entitlementTypes: Object.freeze([
    ['group', 0.9], ['role', 0.075], ['workgroup', 0.015], ['CustomType', 0.0094],
    ['Entitlement', 0.0005], ['capability', 0.0001],
  ]),
  // Share of entitlements whose certification frequency has been SET at all.
  // Measured at 3.3% on a production catalogue: almost nothing carries one, and
  // closing that gap is the point of an application-owner access review. A
  // fixture where every entitlement has a frequency cannot show the gap, and
  // the report that reports on it would look finished while reporting nothing.
  certFrequencySetShare: 0.033,
  // The values that ARE set, as [value, share] pairs summing to 1. This is
  // deliberately a dirty vocabulary, because the production one is: a free-text
  // column filled in by hand over years holds a misspelling ('Quaterly'), a
  // bare 'No', and two ways of saying the same thing. Consumers must show these
  // as stored rather than normalise them, and a fixture with four tidy values
  // cannot test that.
  certFrequencies: Object.freeze([
    ['Annually', 0.42], ['Quarterly', 0.24], ['Bi-Annually', 0.13], ['Monthly', 0.09],
    ['No certification', 0.06], ['Not Applicable', 0.04], ['Quaterly', 0.015], ['No', 0.005],
  ]),
});

function assertShare(name, v) {
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1 (got ${v})`);
}

// A [value, share] mix: non-empty, every share positive, and the shares summing
// to 1 — a mix summing to 0.9 would silently push a tenth of the rows into the
// last value, which is exactly the kind of skew a fixture must not invent.
function assertWeighted(name, pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const total = list.reduce((sum, [, share]) => sum + share, 0);
  if (!list.length || list.some(([v, share]) => typeof v !== 'string' || !v || !(share > 0)) || Math.abs(total - 1) > 1e-9) {
    throw new Error(`${name} must be non-empty [value, share] pairs with positive shares summing to 1`);
  }
}

// { shape, iiq } → resolved shape (via the shared resolver) plus validated iiq.
export function resolveIiqParams({ shape = {}, iiq = {} } = {}) {
  const s = resolveParams(shape);
  const p = { ...IIQ_DEFAULTS, ...iiq };
  for (const k of ['roleGrantedShare', 'requestedShare', 'ownedShare', 'appNameDriftShare', 'unassignedAppShare', 'certFrequencySetShare']) assertShare(k, p[k]);
  assertWeighted('entitlementTypes', p.entitlementTypes);
  assertWeighted('certFrequencies', p.certFrequencies);
  if (!Number.isInteger(p.workgroups) || p.workgroups < 0) throw new Error(`workgroups must be a non-negative integer (got ${p.workgroups})`);
  if (!(p.roleSizeMin >= 1 && p.roleSizeMax >= p.roleSizeMin)) throw new Error('roleSizeMin must be >= 1 and <= roleSizeMax');
  for (const k of ['catalogName', 'appNameKey']) {
    if (typeof p[k] !== 'string' || !p[k].trim()) throw new Error(`${k} must be a non-empty string`);
  }
  return { shape: s, iiq: p };
}
