// Pure helpers for the effective-access engine.
//
// These are the per-row / per-group reshaping steps extracted out of the async traversal
// entrypoints in engine.js (effectiveAccessAtNode, effectiveAccessForNodes) so each stays a
// thin orchestrator. Everything here is synchronous and side-effect-free — no DB, no logging —
// which is what makes it directly unit-testable. Behaviour is identical to the inline code it
// replaced.

import { badgeForAce } from './policies.js';
import { capabilityResourceId } from '../lib/capabilityId.js';

// Whether a grant declared at `target` reaches the focus node, honouring propagationScope +
// distance. Returns { distance, atFocus } for a reaching grant, or null when it does not apply
// (target outside the collected tree, or its scope does not propagate to this node).
export function grantReach(depthByNode, target, scope) {
  const distance = depthByNode.get(target);
  if (distance === undefined) return null; // target outside the collected tree
  const atFocus = distance === 0;
  const propagationScope = scope ?? 'selfAndDescendants';
  const reaches = atFocus
    ? propagationScope === 'self' || propagationScope === 'selfAndDescendants'
    : propagationScope === 'descendants' || propagationScope === 'selfAndDescendants';
  return reaches ? { distance, atFocus } : null;
}

// One ACE as the resolution policy expects it. `effect` absent means allow (pre-038 rows / mocks).
export function buildAce(effect, distance, atFocus, viaGroupId) {
  return { effect: effect ?? 'allow', distance, explicit: atFocus, viaGroupId };
}

// Group the reaching grant rows for a single principal by capability. Returns Map<cap, ace[]>.
export function groupAtNodeAces(rows, depthByNode, principalId) {
  const byCap = new Map();
  for (const row of rows) {
    const reach = grantReach(depthByNode, row.target, row.scope);
    if (!reach) continue;
    const viaGroupId = row.holder === principalId ? null : row.holder;
    const ace = buildAce(row.effect, reach.distance, reach.atFocus, viaGroupId);
    if (!byCap.has(row.cap)) byCap.set(row.cap, []);
    byCap.get(row.cap).push(ace);
  }
  return byCap;
}

// Resolve each capability's ACE set to at most one capability row, dropping `none` results and
// sorting for stable ordering.
export function resolveAtNodeCapabilities(byCap, policy, nodeId) {
  const capabilities = [];
  for (const [cap, aces] of byCap) {
    const res = policy.resolve(aces);
    if (res.effective === 'none') continue;
    capabilities.push({
      capabilityId: cap,
      capabilityResourceId: capabilityResourceId(nodeId, cap),
      effective: res.effective,
      badge: res.decisiveAce ? badgeForAce(res.decisiveAce) : null,
    });
  }
  capabilities.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  return capabilities;
}

// Truncation summary for effectiveAccessAtNode — null when neither expansion was capped.
export function atNodeTruncation(holdersTruncated, holders, ancestorsTruncated, depthByNode) {
  if (!holdersTruncated && !ancestorsTruncated) return null;
  return {
    holders: holdersTruncated ? holders.size : undefined,
    ancestors: ancestorsTruncated ? depthByNode.size : undefined,
  };
}

// Group the reaching grant rows at one focus node by (capability, holder). Returns
// Map<key, { cap, rolename, rtype, holder, aces }>.
export function groupForNodeGrants(grantRows, depthByNode) {
  const byCapHolder = new Map();
  for (const g of grantRows) {
    const reach = grantReach(depthByNode, g.target, g.scope);
    if (!reach) continue;
    const key = `${g.cap} ${g.holder}`;
    if (!byCapHolder.has(key)) {
      byCapHolder.set(key, { cap: g.cap, rolename: g.rolename, rtype: g.rtype, holder: g.holder, aces: [] });
    }
    byCapHolder.get(key).aces.push(buildAce(g.effect, reach.distance, reach.atFocus, null));
  }
  return byCapHolder;
}

// Emit the matrix rows for one focus node: one row per (capability, holder) that resolves to a
// non-`none` effective result. `meta` is the focus node's { name, label } (may be undefined).
export function emitNodeRows(byCapHolder, policy, node, meta) {
  const scopeName = meta?.name || node;
  const rows = [];
  for (const { cap, rolename, rtype, holder, aces } of byCapHolder.values()) {
    const res = policy.resolve(aces);
    if (res.effective === 'none') continue;
    const roleLabel = rolename || cap;
    rows.push({
      resourceId: capabilityResourceId(node, cap),
      nodeId: node,
      capabilityId: cap,
      resourceType: rtype,
      displayName: meta?.label ? `${roleLabel} @ ${meta.label}: ${scopeName}` : `${roleLabel} @ ${scopeName}`,
      principalId: holder,
      membershipType: res.decisiveAce ? badgeForAce(res.decisiveAce) : 'Indirect',
    });
  }
  return rows;
}
