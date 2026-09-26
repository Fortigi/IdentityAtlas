// Parameters of the scale test fixture. Every shape property is a named, seeded,
// documented knob here; the README's parameter table mirrors this object.
//
// Volumes are given at 100% and multiplied by `scale`. The shape knobs are
// ratios and exponents, so a 1% run has the same shape as the full one — that is
// what makes a 1% failure a cheap rehearsal of a 100% failure.

export const DEFAULTS = Object.freeze({
  seed: 20260926,
  scale: 1,

  // ── volumes at 100% ─────────────────────────────────────────────
  connectors: 40,              // technical systems that hold entitlements (not scaled)
  logicalApplications: 1500,   // Contexts.csv rows (TargetType=Resource)
  principals: 180000,          // Users.csv rows
  entitlements: 800000,        // Resources.csv rows that are not roles
  roles: 10000,                // Resources.csv rows with ResourceType=BusinessRole
  entitlementAssignments: 40000000,
  roleAssignments: 1000000,

  // ── shape ───────────────────────────────────────────────────────
  // Disabled majority: exactly this share of principals is enabled.
  enabledShare: 0.25,
  // Assignment skew: membership of the rank-r entitlement ∝ 1/(r+1)^exponent.
  // 1.0 at full scale → a few dozen entitlements held by six figures, median in
  // single digits (see distributions.powerLawCounts).
  assignmentSkew: 1.0,
  roleAssignmentSkew: 1.0,
  // No entitlement is held by more than this share of all principals.
  holderCapShare: 0.95,
  // Systems spread: connector size ∝ 1/(r+1)^exponent → a couple of large
  // connectors and a long tail of small ones.
  connectorSkew: 1.3,
  // Logical application size ∝ 1/(r+1)^exponent.
  applicationSkew: 1.0,
  // Share of an application's entitlements that live OUTSIDE its home connector,
  // spread over up to `maxSecondaryConnectors` other connectors. This is what makes
  // logical applications span systems.
  crossSystemShare: 0.35,
  maxSecondaryConnectors: 4,
  // Share of connectors that are directory-style (entitlement values are LDAP
  // distinguished names — full of commas). The largest connector always is one.
  directoryConnectorShare: 0.3,
  // Share of entitlements (and of principals) whose display name is a
  // near-collision of another: same text differing only by case or a trailing
  // space. Matching in the source is by name, so these must survive the load.
  nameCollisionShare: 0.002,
});

const SCALED = ['logicalApplications', 'principals', 'entitlements', 'roles', 'entitlementAssignments', 'roleAssignments'];

function assertShare(name, v) {
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1 (got ${v})`);
}

// Merge overrides onto DEFAULTS, apply the scale factor, and validate.
export function resolveParams(overrides = {}) {
  const p = { ...DEFAULTS, ...overrides };
  if (!(p.scale > 0)) throw new Error(`scale must be > 0 (got ${p.scale})`);
  if (!Number.isInteger(p.seed)) throw new Error(`seed must be an integer (got ${p.seed})`);
  const out = { ...p };
  for (const k of SCALED) out[k] = Math.max(1, Math.round(p[k] * p.scale));
  // Connectors are not scaled, but a tiny run cannot have more than it has entitlements.
  out.connectors = Math.max(1, Math.min(p.connectors, out.entitlements));
  if (out.connectors > 255) throw new Error(`connectors must be at most 255 (got ${out.connectors})`);
  for (const k of ['enabledShare', 'holderCapShare', 'crossSystemShare', 'directoryConnectorShare', 'nameCollisionShare']) assertShare(k, out[k]);
  out.enabledPrincipals = Math.round(out.principals * out.enabledShare);
  out.holderCap = Math.max(1, Math.floor(out.principals * out.holderCapShare));
  // Keep the per-entitlement mean feasible at small scales: every entitlement holds
  // at least one principal and none holds more than the cap.
  out.entitlementAssignments = clampTotal(out.entitlementAssignments, out.entitlements, out.holderCap);
  out.roleAssignments = clampTotal(out.roleAssignments, out.roles, out.holderCap);
  return out;
}

function clampTotal(total, n, cap) {
  return Math.min(Math.max(total, n), n * cap);
}
