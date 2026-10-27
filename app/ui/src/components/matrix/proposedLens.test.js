import { describe, it, expect } from 'vitest';
import {
  proposalPrincipals, draftLabel, lensPackages, withProposalCoverage, investigationLabel, PROPOSED_CATEGORY,
} from './proposedLens';

const A1 = 'AAAAAAAA-0000-0000-0000-000000000001';
const people = [
  { key: 'i:ann', direct: true, jobTitle: 'Claims handler', accounts: [{ id: A1 }, { id: 'a2' }] },
  { key: 'i:bob', direct: true, jobTitle: 'Loss adjuster', accounts: [{ id: 'b1' }] },
  { key: 'i:cas', direct: false, jobTitle: 'Claims handler', accounts: [{ id: 'c1' }] },
  { key: 'i:dee', direct: true, jobTitle: 'Team lead', accounts: [{ id: 'd1' }] },
];
const ruleOn = (contains, includeChildren = true) => ({ includeChildren, filters: { jobTitle: { values: [], contains } } });

describe('proposalPrincipals', () => {
  it('takes a hand-picked role by its saved members, every account of each, lower-cased', () => {
    expect(proposalPrincipals({ kind: 'requestable', members: ['i:ann', 'i:dee'], entitlements: [] }, people))
      .toEqual([A1.toLowerCase(), 'a2', 'd1']);
  });

  it('evaluates a rule-based role on the people as they are now, plus always include, minus always exclude', () => {
    const p = { kind: 'rule', rule: ruleOn(['handler']), members: ['i:dee'], excluded: ['i:cas'], entitlements: [] };
    expect(proposalPrincipals(p, people).sort()).toEqual([A1.toLowerCase(), 'a2', 'd1'].sort());
  });

  it('keeps a rule to the unit itself when the rule leaves the sub-units out', () => {
    const p = { kind: 'rule', rule: ruleOn(['handler'], false), members: [], entitlements: [] };
    expect(proposalPrincipals(p, people)).not.toContain('c1');
    expect(proposalPrincipals({ ...p, rule: ruleOn(['handler']) }, people)).toContain('c1');
  });

  it('reaches nobody who has left the unit', () => {
    expect(proposalPrincipals({ kind: 'requestable', members: ['i:gone'], entitlements: [] }, people)).toEqual([]);
  });
});

describe('draftLabel', () => {
  it('prefixes the name, trimmed, and names an unnamed one', () => {
    expect(draftLabel({ name: '  Loss Adjuster ' })).toBe('Draft: Loss Adjuster');
    expect(draftLabel({ name: '   ' })).toBe('Draft: Unnamed');
    expect(draftLabel({})).toBe('Draft: Unnamed');
  });
});

describe('lensPackages', () => {
  it('gives one business-role row per entitlement, under the Proposed category', () => {
    const rows = lensPackages([
      { id: 'p1', name: 'Handler', entitlements: ['r1', 'r2'], principals: ['a', 'b', 'c'], investigationName: 'First pass' },
      { id: 'p2', name: 'Lead', entitlements: [], principals: [] },
    ]);
    expect(rows).toEqual([
      { accessPackageId: 'p1', accessPackageName: 'Draft: Handler', resourceId: 'r1', groupId: 'r1', roleName: 'Member', catalogName: 'First pass', categoryName: PROPOSED_CATEGORY, totalAssignments: 3 },
      { accessPackageId: 'p1', accessPackageName: 'Draft: Handler', resourceId: 'r2', groupId: 'r2', roleName: 'Member', catalogName: 'First pass', categoryName: PROPOSED_CATEGORY, totalAssignments: 3 },
    ]);
  });

  it('leaves the catalog empty when the investigation is not named', () => {
    expect(lensPackages([{ id: 'p', name: 'x', entitlements: ['r'], principals: [] }])[0].catalogName).toBeNull();
  });
});

describe('withProposalCoverage', () => {
  const real = [{ memberId: 'a', resourceId: 'R1', accessPackageIds: ['br-1'] }];

  it('adds each member × entitlement of a proposal, next to the real business role on a shared cell', () => {
    const out = withProposalCoverage(real, [{ id: 'p1', principals: ['a', 'b'], entitlements: ['r1', 'R2'] }]);
    const byKey = Object.fromEntries(out.map(c => [`${c.memberId}|${c.resourceId}`, c.accessPackageIds]));
    expect(byKey).toEqual({ 'a|r1': ['br-1', 'p1'], 'a|r2': ['p1'], 'b|r1': ['p1'], 'b|r2': ['p1'] });
  });

  it('lists two proposals that cover one cell and leaves the input untouched', () => {
    const out = withProposalCoverage(real, [
      { id: 'p1', principals: ['a'], entitlements: ['r1'] },
      { id: 'p2', principals: ['a'], entitlements: ['r1'] },
    ]);
    expect(out).toEqual([{ memberId: 'a', resourceId: 'r1', groupId: 'r1', accessPackageIds: ['br-1', 'p1', 'p2'] }]);
    expect(real[0].accessPackageIds).toEqual(['br-1']);
  });

  it('takes groupId when a covered cell has no resourceId, and no covered cells at all', () => {
    expect(withProposalCoverage([{ memberId: 'x', groupId: 'G', accessPackageIds: undefined }], []))
      .toEqual([{ memberId: 'x', resourceId: 'g', groupId: 'g', accessPackageIds: [] }]);
    expect(withProposalCoverage(undefined, [])).toEqual([]);
  });
});

describe('investigationLabel', () => {
  it('names the unit, who saved it and the day', () => {
    expect(investigationLabel({ name: 'First pass', unitName: 'Property Claims', updatedBy: 'ann', updatedAt: '2026-10-27T09:05:00' }))
      .toBe('First pass (Property Claims, ann, 27-10-2026)');
  });

  it('leaves the day out when it cannot be read', () => {
    expect(investigationLabel({ name: 'X', unitName: 'U', updatedBy: 'b', updatedAt: 'not a date' })).toBe('X (U, b)');
  });
});
