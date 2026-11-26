import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./businessRoleOwners.js', () => ({ loadBusinessRoleOwners: vi.fn() }));
vi.mock('./businessRolePeople.js', async (orig) => ({ ...(await orig()), loadParticipants: vi.fn() }));

const { loadBusinessRoleOwners } = await import('./businessRoleOwners.js');
const { loadParticipants } = await import('./businessRolePeople.js');
const {
  snapshotPolicy, buildSnapshot, takeSnapshot, compareSnapshots,
  ROLE_SQL, RESOURCES_SQL, POLICIES_SQL, SNAPSHOT_VERSION,
} = await import('./businessRoleSnapshot.js');
const { ROLE_CONTROL_SQL } = await import('./businessRoleAccessModel.js');
const { catalogJoinSql } = await import('./businessRoleCatalog.js');

const FIN = { id: 'g1', displayName: 'SG-Finance', resourceType: 'Group', systemName: 'Entra ID', roleName: 'Member' };
const PAY = { id: 'g2', displayName: 'SG-Payroll', resourceType: 'Group', systemName: 'Entra ID', roleName: 'Member' };
const RULE_POLICY = { id: 'p1', displayName: 'Everyone in Finance', hasAutoAddRule: true, hasAutoRemoveRule: true, targetRule: '(user.department -eq "Finance")' };

describe('snapshotPolicy', () => {
  it('keeps the ways in and out a policy states, and its rule', () => {
    expect(snapshotPolicy({
      id: 'p2', displayName: 'Request it', allowsRequest: true, allowsDirectAssignment: false, hasAccessReview: true,
      hasExpiration: true, allowsRemovalRequest: null, requiresApproval: true, expiration: { type: 'afterDuration', duration: 'P365D' },
    })).toEqual({
      id: 'p2', displayName: 'Request it', waysIn: ['Request'], waysOut: ['Review', 'Expiry'],
      targetRule: null, requiresApproval: true, expiration: { type: 'afterDuration', duration: 'P365D' },
    });
  });

  it('reads a rule-only policy', () => {
    expect(snapshotPolicy(RULE_POLICY)).toMatchObject({ waysIn: ['Rule'], waysOut: ['Rule'], targetRule: '(user.department -eq "Finance")', requiresApproval: null, expiration: null });
  });
});

describe('buildSnapshot', () => {
  it('keeps the role, its type, resources, policies and owners at that moment', () => {
    const s = buildSnapshot({
      role: { displayName: 'Finance', description: 'd', catalogName: 'Specials', holderCount: 12 },
      model: { waysIn: ['Rule'], waysOut: ['Rule'], control: 'Automatic', reviewRequired: false, reviewGap: false },
      resources: [FIN], policies: [RULE_POLICY],
      owners: [{ id: 'o1', role: 'Accountable', displayName: 'Ann', principalId: 'x' }, { id: 'policy:y', role: 'Responsible', displayName: 'Bob', derivedFrom: ['Approver'] }],
      takenAt: '2026-11-24T15:00:00Z',
    });
    expect(s).toEqual({
      version: SNAPSHOT_VERSION,
      takenAt: '2026-11-24T15:00:00Z',
      role: { displayName: 'Finance', description: 'd', catalogName: 'Specials', holderCount: 12 },
      type: { control: 'Automatic', waysIn: ['Rule'], waysOut: ['Rule'], reviewGap: false },
      resources: [FIN],
      policies: [snapshotPolicy(RULE_POLICY)],
      owners: [{ role: 'Accountable', displayName: 'Ann', derivedFrom: null }, { role: 'Responsible', displayName: 'Bob', derivedFrom: ['Approver'] }],
    });
  });

  it('is Unknown with no policies, and fills what a missing row leaves out', () => {
    const s = buildSnapshot({ role: undefined, model: undefined, resources: [{ id: 'g9', displayName: 'Orphan' }], policies: [], owners: [], takenAt: 't' });
    expect(s.type).toEqual({ control: 'Unknown', waysIn: ['Unknown'], waysOut: ['Unknown'], reviewGap: false });
    expect(s.role).toEqual({ displayName: null, description: null, catalogName: null, holderCount: 0 });
    expect(s.resources).toEqual([{ id: 'g9', displayName: 'Orphan', resourceType: null, systemName: null, roleName: null }]);
  });
});

describe('takeSnapshot', () => {
  beforeEach(() => {
    loadBusinessRoleOwners.mockResolvedValue([{ id: 'o1', role: 'Accountable', displayName: 'Ann' }]);
    loadParticipants.mockResolvedValue([{ participation: 'Approver', subjectType: 'User', principalId: 'u9', displayName: 'Carla' }]);
  });

  it('reads every part for this role and puts them together', async () => {
    const query = vi.fn(async (sql) => {
      if (sql === ROLE_SQL) return { rows: [{ displayName: 'Finance', holderCount: 3 }] };
      if (sql === ROLE_CONTROL_SQL) return { rows: [{ resourceId: 'role-1', policyCount: 1, inRule: true, outRule: true }] };
      if (sql === RESOURCES_SQL) return { rows: [FIN] };
      if (sql === POLICIES_SQL) return { rows: [RULE_POLICY] };
      return { rows: [] };
    });
    const s = await takeSnapshot('role-1', { pool: { query }, now: () => 'NOW' });
    expect(query).toHaveBeenCalledWith(ROLE_SQL, ['role-1']);
    expect(query).toHaveBeenCalledWith(ROLE_CONTROL_SQL, [['role-1']]);
    expect(query).toHaveBeenCalledWith(RESOURCES_SQL, ['role-1']);
    expect(query).toHaveBeenCalledWith(POLICIES_SQL, ['role-1']);
    expect(s).toMatchObject({ takenAt: 'NOW', role: { displayName: 'Finance', holderCount: 3 }, type: { control: 'Automatic' }, resources: [FIN] });
    expect(s.owners.map(o => [o.role, o.displayName])).toEqual([['Accountable', 'Ann'], ['Responsible', 'Carla']]);
  });
});

describe('the statements', () => {
  it('counts holders and reads the catalog of the one role', () => {
    expect(ROLE_SQL).toContain('COUNT(DISTINCT a."principalId")');
    // Migration 117 dropped "GovernanceCatalogs" and "Resources"."catalogId": the
    // catalog is the Catalog context that has the role as a member.
    expect(ROLE_SQL).toContain(catalogJoinSql('r.id'));
    expect(ROLE_SQL).not.toMatch(/GovernanceCatalogs|"catalogId"/);
    expect(ROLE_SQL).toContain('WHERE r.id = $1');
  });

  it('reads the live contained resources with their type and system', () => {
    expect(RESOURCES_SQL).toContain(`rrs."parentResourceId" = $1 AND rrs."relationshipType" = 'Contains'`);
    expect(RESOURCES_SQL).toContain('r."deletedAt" IS NULL');
    expect(RESOURCES_SQL).toContain('s."displayName" AS "systemName"');
  });

  it('reads the rule the same way as the policies tab', () => {
    expect(POLICIES_SQL).toContain(`COALESCE(p."targetRule", p."automaticRequestSettings" #>> '{filter,rule}') AS "targetRule"`);
    expect(POLICIES_SQL).toContain('WHERE p."resourceId" = $1');
  });
});

describe('compareSnapshots', () => {
  const before = { resources: [FIN, PAY], type: { control: 'Manual' }, policies: [snapshotPolicy(RULE_POLICY)] };

  it('is quiet when nothing changed, whatever the order', () => {
    expect(compareSnapshots(before, { ...before, resources: [PAY, FIN] })).toEqual({ added: [], removed: [], type: null, policiesChanged: false });
  });

  it('names resources added and removed', () => {
    const hr = { id: 'g3', displayName: 'SG-HR' };
    expect(compareSnapshots(before, { ...before, resources: [FIN, hr] })).toMatchObject({ added: ['SG-HR'], removed: ['SG-Payroll'] });
  });

  it('says when the type moved', () => {
    expect(compareSnapshots(before, { ...before, type: { control: 'Automatic' } }).type).toEqual({ from: 'Manual', to: 'Automatic' });
    expect(compareSnapshots({}, { type: { control: 'Manual' } }).type).toEqual({ from: 'Unknown', to: 'Manual' });
  });

  it('notices a changed rule, a new policy, or a changed way in', () => {
    const changedRule = snapshotPolicy({ ...RULE_POLICY, targetRule: '(user.department -eq "Sales")' });
    expect(compareSnapshots(before, { ...before, policies: [changedRule] }).policiesChanged).toBe(true);
    expect(compareSnapshots(before, { ...before, policies: [...before.policies, snapshotPolicy({ id: 'p9', allowsRequest: true })] }).policiesChanged).toBe(true);
    expect(compareSnapshots(before, { ...before, policies: [snapshotPolicy({ ...RULE_POLICY, allowsRequest: true })] }).policiesChanged).toBe(true);
  });

  it('copes with an empty or missing picture', () => {
    expect(compareSnapshots(undefined, undefined)).toEqual({ added: [], removed: [], type: null, policiesChanged: false });
  });
});
