import { describe, it, expect } from 'vitest';
import {
  isPresent, rowAt, attributeMap, resourceGroup, rowKey, sourceSnapshots,
  buildDiffSnapshots, RELATIONSHIP_SOURCES, ENTITY_TABLE,
} from './snapshot.js';

const USER = 'u-1';
const labels = {
  resource: id => ({
    'br-1': { displayName: 'Head of Sales', resourceType: 'BusinessRole' },
    'grp-1': { displayName: 'Finance Team', resourceType: 'Group' },
    'grp-2': { displayName: 'Legal Team', resourceType: 'Group' },
  }[id] || null),
  principal: id => ({ 'mgr-old': 'Alice Old', 'mgr-new': 'Bob New', [USER]: 'Carol' }[id] || null),
  identity: id => ({ 'id-1': 'Carol (person)' }[id] || null),
};

const ra = (resourceId, extra = {}) => ({ resourceId, principalId: USER, assignmentType: 'Direct', ...extra });
const raKey = (resourceId, type = 'Direct') => `${resourceId}|${USER}|${type}`;
const [heldResources, identitySource] = RELATIONSHIP_SOURCES.user;

describe('isPresent', () => {
  it('is false for null and for a soft-deleted row, true otherwise', () => {
    expect(isPresent(null)).toBe(false);
    expect(isPresent({ id: 1, deletedAt: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(isPresent({ id: 1, deletedAt: null })).toBe(true);
  });
});

describe('rowAt', () => {
  const current = { id: 'x', department: 'Now' };
  it('returns the current row when nothing changed after T', () => {
    expect(rowAt(null, current)).toBe(current);
    expect(rowAt(undefined, undefined)).toBeNull();
  });
  it('returns null when the first change after T is the insert', () => {
    expect(rowAt({ operation: 'I', prevData: null }, current)).toBeNull();
  });
  it('returns prevData of the first change after T for an update or delete', () => {
    expect(rowAt({ operation: 'U', prevData: { department: 'Then' } }, current)).toEqual({ department: 'Then' });
    expect(rowAt({ operation: 'D', prevData: { department: 'Gone' } }, null)).toEqual({ department: 'Gone' });
  });
});

describe('attributeMap', () => {
  it('drops bookkeeping, manager, deletedAt and photo fields, and flattens extendedAttributes', () => {
    const map = attributeMap({
      id: 'x', displayName: 'Carol', department: 'Sales', managerId: 'm', deletedAt: null,
      lastSyncedAt: '2026-01-01', updatedAt: '2026-01-01', photo: '\\x00', photoContentType: 'image/png',
      extendedAttributes: { costCenter: '42', badge: null },
    });
    expect(map).toEqual({ displayName: 'Carol', department: 'Sales', 'ext.costCenter': '42', 'ext.badge': null });
  });
  it('ignores a non-object extendedAttributes and returns {} for a missing row', () => {
    expect(attributeMap({ title: 'X', extendedAttributes: ['a'] })).toEqual({ title: 'X' });
    expect(attributeMap(null)).toEqual({});
  });
});

describe('resourceGroup / rowKey', () => {
  it('maps resource types to group names, with fallbacks', () => {
    expect(resourceGroup('BusinessRole')).toBe('Business roles');
    expect(resourceGroup('EntraDirectoryRole')).toBe('Directory roles');
    expect(resourceGroup('SomethingNew')).toBe('SomethingNew');
    expect(resourceGroup(null)).toBe('Resources');
  });
  it('builds the same composite keys as the _history trigger (migration 022)', () => {
    expect(rowKey('ResourceAssignments', ra('r', { assignmentType: 'Eligible' }))).toBe(`r|${USER}|Eligible`);
    expect(rowKey('ResourceRelationships', { parentResourceId: 'p', childResourceId: 'c', relationshipType: 'Contains' })).toBe('p|c|Contains');
    expect(rowKey('IdentityMembers', { identityId: 'i', principalId: 'p' })).toBe('i|p');
    expect(rowKey('Principals', { id: 7 })).toBe('7');
  });
});

describe('sourceSnapshots — held resources of a user', () => {
  const changes = [
    // Added after T: insert, still present.
    { rowId: raKey('br-1'), firstOp: 'I', firstPrev: null, lastOp: 'I', lastData: ra('br-1', { resourceType: 'BusinessRole', governed: true }) },
    // Removed after T: present before, soft-deleted now.
    { rowId: raKey('grp-1'), firstOp: 'U', firstPrev: ra('grp-1'), lastOp: 'U', lastData: ra('grp-1', { deletedAt: '2026-10-01T00:00:00Z' }) },
    // Added and removed again after T: on neither side.
    { rowId: raKey('grp-2', 'Eligible'), firstOp: 'I', firstPrev: null, lastOp: 'D', lastData: ra('grp-2', { assignmentType: 'Eligible' }) },
  ];

  it('places added rows on the right only, removed rows on the left only', () => {
    const r = sourceSnapshots(heldResources, { changes, current: [], total: 1 }, labels);
    expect(r.before.map(i => i.label)).toEqual(['Finance Team']);
    expect(r.after.map(i => i.label)).toEqual(['Head of Sales']);
    expect(r.after[0]).toMatchObject({
      key: `heldResources:${raKey('br-1')}`, group: 'Business roles', kind: 'access-package',
      id: 'br-1', detail: 'Direct · governed',
    });
    expect(r.before[0]).toMatchObject({ group: 'Groups', kind: 'resource', detail: 'Direct' });
    expect(r.omitted).toBe(0);
  });

  it('puts unchanged current rows on both sides, but not a current row that also changed', () => {
    const current = [ra('br-1', { resourceType: 'BusinessRole' }), ra('grp-2')];
    const r = sourceSnapshots(heldResources, { changes, current, total: 2 }, labels);
    // grp-2|Direct never changed → both sides. br-1 is in changes → only right.
    expect(r.before.map(i => i.id)).toEqual(['grp-1', 'grp-2']);
    expect(r.after.map(i => i.id)).toEqual(['br-1', 'grp-2']);
  });

  it('counts unchanged rows the cap left out', () => {
    // 10 present now: 1 changed-and-present (br-1) + 2 listed → 7 omitted.
    const current = [ra('x1'), ra('x2')];
    const r = sourceSnapshots(heldResources, { changes, current, total: 10 }, labels);
    expect(r.omitted).toBe(7);
  });

  it('falls back to the id when a counterparty has no label', () => {
    const r = sourceSnapshots(heldResources, { current: [ra('unknown')], total: 1 }, labels);
    expect(r.before[0]).toMatchObject({ label: 'unknown', group: 'Resources', kind: 'resource' });
  });

  it('treats a row that was soft-deleted at T and is still deleted as absent on both sides', () => {
    const deleted = ra('grp-1', { deletedAt: '2026-01-01T00:00:00Z' });
    const r = sourceSnapshots(heldResources, {
      changes: [{ rowId: raKey('grp-1'), firstOp: 'U', firstPrev: deleted, lastOp: 'U', lastData: { ...deleted, origin: 'Requested' } }],
    }, labels);
    expect(r.before).toEqual([]);
    expect(r.after).toEqual([]);
  });
});

describe('relationship sources per entity kind', () => {
  it('labels each source from the viewed entity\'s side', () => {
    const [members, children, parents] = RELATIONSHIP_SOURCES.resource;
    const rr = { parentResourceId: 'br-1', childResourceId: 'grp-1', relationshipType: 'Contains' };
    expect(members.toItem(ra('grp-1'), labels)).toMatchObject({ group: 'Members', label: 'Carol', kind: 'user', id: USER });
    expect(children.toItem(rr, labels)).toMatchObject({ group: 'Contains', label: 'Finance Team', kind: 'resource', detail: 'Contains' });
    expect(parents.toItem(rr, labels)).toMatchObject({ group: 'Part of', label: 'Head of Sales', kind: 'access-package' });
    expect(identitySource.toItem({ identityId: 'id-1', principalId: USER, isPrimary: true }, labels))
      .toMatchObject({ group: 'Identity', label: 'Carol (person)', kind: 'identity', detail: 'primary account' });
    const [accounts] = RELATIONSHIP_SOURCES.identity;
    expect(accounts.toItem({ identityId: 'id-1', principalId: 'p-9', displayName: 'carol-admin', accountType: 'Admin' }, labels))
      .toMatchObject({ group: 'Linked accounts', label: 'carol-admin', detail: 'Admin' });
    expect(RELATIONSHIP_SOURCES.context).toEqual([]);
    expect(ENTITY_TABLE['access-package']).toBe('Resources');
  });
});

describe('buildDiffSnapshots', () => {
  it('builds both sides, with the manager as a relationship', () => {
    const thenRow = { id: USER, displayName: 'Carol', department: 'Sales', managerId: 'mgr-old' };
    const nowRow = { id: USER, displayName: 'Carol', department: 'Finance', managerId: 'mgr-new', deletedAt: '2026-10-20T00:00:00Z' };
    const out = buildDiffSnapshots({
      thenRow, nowRow, labels,
      sources: [{ source: heldResources, changes: [], current: [ra('grp-2')], total: 5 }],
    });
    expect(out.before).toMatchObject({ exists: true, deleted: false, attributes: { department: 'Sales' } });
    expect(out.after).toMatchObject({ exists: true, deleted: true, attributes: { department: 'Finance' } });
    expect(out.before.relationships.map(i => `${i.group}:${i.label}`)).toEqual(['Manager:Alice Old', 'Groups:Legal Team']);
    expect(out.after.relationships.map(i => `${i.group}:${i.label}`)).toEqual(['Manager:Bob New', 'Groups:Legal Team']);
    expect(out.omittedUnchanged).toBe(4);
  });

  it('marks an entity that did not exist yet', () => {
    const out = buildDiffSnapshots({ thenRow: null, nowRow: { id: 'x', managerId: 'zzz' } });
    expect(out.before).toEqual({ exists: false, deleted: false, attributes: {}, relationships: [] });
    // No label resolvers → the manager falls back to its id.
    expect(out.after.relationships).toEqual([{ key: 'manager:zzz', group: 'Manager', label: 'zzz', kind: 'user', id: 'zzz', detail: '' }]);
  });
});
