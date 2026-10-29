// The matrix's "Proposed" lens — the pure part. Saved proposed roles (from the
// workbench's investigations) shown the way the matrix shows business roles:
//
//   proposalPrincipals(proposal, people)  the accounts a proposal reaches now — a rule-based one by its
//                                         saved rule on the unit's current data (+ always include −
//                                         always exclude), any other by its saved members
//   lensPackages(proposals)              each proposal as a business role the matrix bands: "Draft: <name>",
//                                         one row per entitlement (the accessPackageGroups shape)
//   withProposalCoverage(managed, proposals)  the matrix's covered cells (managedByPackages) plus each
//                                         proposal's member × entitlement cells, so they take its colour
// The rest — colours, bands, cell colouring, gaps — is the matrix's own
// (accessPackageModel.js, MatrixCell). Design: docs/architecture/m1-discovery-and-design.md.

import { effectiveMembers } from '@ui/components/workbench/workbench.rule';
import { draftFromSaved } from '@ui/components/workbench/workbench.save';
import { PROPOSED_CATEGORY } from './accessPackageModel';

export { PROPOSED_CATEGORY };

/** The accounts a saved proposal reaches with the unit's people as they are now. Pure. */
export function proposalPrincipals(proposal, people) {
  const [draft] = draftFromSaved({ proposals: [proposal] }).drafts;
  const keys = effectiveMembers(draft, people);
  const out = [];
  for (const p of people) if (keys.has(p.key)) for (const a of p.accounts) out.push(String(a.id).toLowerCase());
  return [...new Set(out)];
}

/** "Draft: <name>". Pure. */
export const draftLabel = (proposal) => `Draft: ${proposal.name?.trim() || 'Unnamed'}`;

/**
 * The proposals as the matrix's business-role rows: one per (proposal, entitlement),
 * under the category "Proposed" so they band together. `investigationName` names
 * where each comes from (the band's tooltip "Catalog"). Pure.
 */
export function lensPackages(proposals) {
  return proposals.flatMap(p => p.entitlements.map(resourceId => ({
    accessPackageId: p.id, accessPackageName: draftLabel(p), resourceId, groupId: resourceId, roleName: 'Member',
    catalogName: p.investigationName ?? null, categoryName: PROPOSED_CATEGORY, totalAssignments: p.principals.length,
  })));
}

/**
 * The matrix's covered cells with the proposals added: each member account ×
 * each entitlement is covered by the proposal (held or not — a cell it covers
 * but the account lacks shows as the matrix's provisioning gap). The real
 * business roles stay: a cell both cover lists both. Pure.
 */
export function withProposalCoverage(managedByPackages, proposals) {
  const byCell = new Map();
  for (const r of managedByPackages || []) {
    const rid = String(r.resourceId || r.groupId).toLowerCase();
    const key = `${rid}|${String(r.memberId).toLowerCase()}`;
    byCell.set(key, { memberId: r.memberId, resourceId: rid, groupId: rid, accessPackageIds: [...(r.accessPackageIds || [])] });
  }
  for (const p of proposals) {
    for (const principalId of p.principals) {
      for (const resourceId of p.entitlements) {
        const rid = String(resourceId).toLowerCase();
        const key = `${rid}|${principalId}`;
        if (!byCell.has(key)) byCell.set(key, { memberId: principalId, resourceId: rid, groupId: rid, accessPackageIds: [] });
        byCell.get(key).accessPackageIds.push(p.id);
      }
    }
  }
  return [...byCell.values()];
}

/** "Property — first pass (Property Claims, ann, 27-10-2026)". Pure. */
export function investigationLabel(inv) {
  const d = new Date(inv.updatedAt);
  const date = Number.isNaN(d.getTime()) ? '' : `, ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  return `${inv.name} (${inv.unitName}, ${inv.updatedBy}${date})`;
}
