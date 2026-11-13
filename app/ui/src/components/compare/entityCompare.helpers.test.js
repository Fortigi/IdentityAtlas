import { describe, it, expect } from 'vitest';
import {
  MAX_COMPARE, parseCompareIds, compareRouteId, isPersonalField, compareSnapshots,
  visibleComparison, toAccount, snapshotName, compareTabLabel,
} from './entityCompare.helpers';

const item = (key, group, label, detail = 'Direct') => ({ key, group, label, kind: 'resource', id: label, detail });

// Three near-identical users. Every way a row can differ appears exactly once,
// so a status rule that only looked at presence, or only at the first two
// columns, or compared labels instead of keys, gets at least one row wrong.
const ann = {
  attributes: { displayName: 'Ann', department: 'Finance', jobTitle: 'Analyst', costCenter: '42', 'ext.badge': 'B1' },
  relationships: [
    item('held:g1|Direct', 'Groups', 'Finance Team'),          // all three
    item('held:g2|Direct', 'Groups', 'Payroll'),               // Ann + Bob
    item('held:g3|Direct', 'Groups', 'VPN'),                   // all three, but Cat holds it Eligible
    item('held:br1|Direct', 'Business roles', 'Head of Finance'), // Ann only
  ],
};
const bob = {
  attributes: { displayName: 'Bob', department: 'Finance', jobTitle: 'Analyst', costCenter: '' },
  relationships: [
    item('held:g1|Direct', 'Groups', 'Finance Team'),
    item('held:g2|Direct', 'Groups', 'Payroll'),
    item('held:g3|Direct', 'Groups', 'VPN'),
  ],
};
const cat = {
  attributes: { displayName: 'Cat', department: 'Finance', jobTitle: 'Senior Analyst', costCenter: null },
  relationships: [
    item('held:g1|Direct', 'Groups', 'Finance Team'),
    { ...item('held:g3|Direct', 'Groups', 'VPN'), detail: 'Eligible' },
  ],
};

const statusOf = (rows, key) => rows.find(r => r.key === key)?.status;

describe('parseCompareIds / compareRouteId', () => {
  it('splits, trims, drops blanks and repeats, and keeps at most three', () => {
    expect(parseCompareIds(' a, b ,,a,c,d')).toEqual(['a', 'b', 'c']);
    expect(MAX_COMPARE).toBe(3);
    expect(parseCompareIds(undefined)).toEqual([]);
    expect(compareRouteId(['x', 'y', 'x'])).toBe('x,y');
  });
});

describe('isPersonalField', () => {
  it('flags naming fields, core or extended, and nothing else', () => {
    expect(isPersonalField('displayName')).toBe(true);
    expect(isPersonalField('ext.employeeId')).toBe(true);
    expect(isPersonalField('department')).toBe(false);
    expect(isPersonalField('ext.department')).toBe(false);
  });
});

describe('compareSnapshots — attributes', () => {
  const { attributes } = compareSnapshots([ann, bob, cat]);

  it('marks a value equal in every column as the same', () => {
    expect(statusOf(attributes, 'department')).toBe('same');
  });
  it('marks a difference in the third column only', () => {
    expect(statusOf(attributes, 'jobTitle')).toBe('differs');
  });
  it('marks a value only some entities have as a difference', () => {
    expect(statusOf(attributes, 'costCenter')).toBe('differs');
    expect(attributes.find(r => r.key === 'costCenter').values).toEqual(['42', '', null]);
  });
  it('leaves out rows empty everywhere and orders core before extended', () => {
    const { attributes: rows } = compareSnapshots([{ attributes: { x: null } }, { attributes: { x: '' } }]);
    expect(rows).toEqual([]);
    expect(attributes.at(-1)).toMatchObject({ key: 'ext.badge', extended: true });
  });
});

describe('compareSnapshots — relationships', () => {
  const cmp = compareSnapshots([ann, bob, cat]);
  const groups = Object.fromEntries(cmp.groups.map(g => [g.group, g]));
  const groupRows = Object.fromEntries(cmp.groups.flatMap(g => g.rows).map(r => [r.key, r]));

  it('a group held the same way by everyone is the same', () => {
    expect(groupRows['held:g1|Direct'].status).toBe('same');
  });
  it('a group one entity lacks differs, with a gap in that column', () => {
    expect(groupRows['held:g2|Direct'].status).toBe('differs');
    expect(groupRows['held:g2|Direct'].items.map(i => i?.label ?? null)).toEqual(['Payroll', 'Payroll', null]);
  });
  it('a group held differently by one entity differs', () => {
    expect(groupRows['held:g3|Direct'].status).toBe('differs');
  });
  it('orders groups by the diff order and counts per column', () => {
    expect(cmp.groups.map(g => g.group)).toEqual(['Business roles', 'Groups']);
    expect(groups.Groups.counts).toEqual([3, 3, 2]);
    expect(groups.Groups.rows.map(r => r.items.find(Boolean).label)).toEqual(['Finance Team', 'Payroll', 'VPN']);
  });
  it('counts same and differing rows, leaving out personal fields', () => {
    // attributes: department same; jobTitle, costCenter, ext.badge differ (displayName is personal)
    // relationships: g1 same; g2, g3, br1 differ
    expect(cmp.counts).toEqual({ same: 2, differs: 6 });
  });
});

describe('visibleComparison', () => {
  const cmp = compareSnapshots([ann, bob]);

  it('by default shows only differences and hides personal fields', () => {
    const v = visibleComparison(cmp);
    expect(v.attributes.map(r => r.key)).toEqual(['costCenter', 'ext.badge']);
    expect(v.groups.map(g => g.group)).toEqual(['Business roles']);
  });
  it('shows everything when both switches are off', () => {
    const v = visibleComparison(cmp, { onlyDifferences: false, hidePersonal: false });
    expect(v.attributes.map(r => r.key)).toContain('displayName');
    expect(v.attributes.map(r => r.key)).toContain('department');
    expect(v.groups.map(g => g.group)).toEqual(['Business roles', 'Groups']);
  });
  it('keeps personal fields that differ once they are no longer hidden', () => {
    const v = visibleComparison(cmp, { hidePersonal: false });
    expect(v.attributes.map(r => r.key)).toContain('displayName');
    expect(v.attributes.map(r => r.key)).not.toContain('department');
  });
});

describe('toAccount / snapshotName / compareTabLabel', () => {
  it('keys an account on its id, so one without a sign-in name can be picked', () => {
    expect(toAccount({ id: 'sp-1', displayName: 'Backup', principalType: 'ServicePrincipal' }))
      .toEqual({ principalId: 'sp-1', userKey: 'sp-1', displayName: 'Backup', subtitle: 'ServicePrincipal' });
    expect(toAccount({ id: 'u-1', userPrincipalName: 'ann@x' })).toMatchObject({ displayName: 'ann@x', subtitle: 'ann@x' });
    expect(toAccount({})).toMatchObject({ userKey: '', displayName: '', subtitle: '' });
  });
  it('names an entry after its display name, then UPN, then id', () => {
    const e = (attributes) => ({ id: 'id-1', data: { snapshot: { attributes } } });
    expect(snapshotName(e({ displayName: 'Ann', userPrincipalName: 'a@x' }))).toBe('Ann');
    expect(snapshotName(e({ userPrincipalName: 'a@x' }))).toBe('a@x');
    expect(snapshotName({ id: 'id-1' })).toBe('id-1');
    expect(snapshotName(null)).toBe('');
  });
  it('labels the tab with the names', () => {
    const e = (n) => ({ id: n, data: { snapshot: { attributes: { displayName: n } } } });
    expect(compareTabLabel([e('Ann'), e('Bob')])).toBe('Compare: Ann · Bob');
    expect(compareTabLabel([])).toBe('Compare');
  });
});
