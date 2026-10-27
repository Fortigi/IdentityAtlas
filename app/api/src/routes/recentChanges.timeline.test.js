import { describe, it, expect } from 'vitest';
import {
  diffRow, buildEntityTimeline, TIMELINE_SKIP_FIELDS,
  timelineAttrEvents, timelineAssignmentEvents, timelineRelationshipEvents, timelineIdentityMemberEvents,
} from './recentChanges.js';

describe('diffRow', () => {
  it('reports changed scalar fields as {field, from, to}', () => {
    const diffs = diffRow(
      { department: 'Sales', jobTitle: 'Rep' },
      { department: 'Marketing', jobTitle: 'Rep' },
    );
    expect(diffs).toEqual([{ field: 'department', from: 'Sales', to: 'Marketing' }]);
  });

  it('skips bookkeeping / sync-churn fields and managerId', () => {
    const diffs = diffRow(
      { managerId: 'a', lastSyncedAt: '2026-01-01', department: 'X' },
      { managerId: 'b', lastSyncedAt: '2026-02-02', department: 'Y' },
    );
    expect(diffs).toEqual([{ field: 'department', from: 'X', to: 'Y' }]);
    expect(TIMELINE_SKIP_FIELDS.has('managerId')).toBe(true);
  });

  it('formats booleans like the UI', () => {
    expect(diffRow({ accountEnabled: true }, { accountEnabled: false }))
      .toEqual([{ field: 'accountEnabled', from: 'Yes', to: 'No' }]);
  });
});

const labels = {
  resource: id => ({ 'res-1': { displayName: 'Finance App', resourceType: 'Group' } }[id] || null),
  principal: id => ({ 'mgr-1': 'Alice Boss', 'u': 'Bob User' }[id] || null),
  identity: id => ({ 'id-1': 'Wim (person)' }[id] || null),
};

describe('buildEntityTimeline — user view', () => {
  it('merges attribute + relationship events, newest first, with counts', () => {
    const rows = [
      { tableName: 'ResourceAssignments', operation: 'I', changedAt: '2026-05-03T10:00:00Z', rowData: { resourceId: 'res-1', principalId: 'u', assignmentType: 'Direct' } },
      { tableName: 'Principals', operation: 'U', changedAt: '2026-05-02T10:00:00Z', prevData: { department: 'Sales', managerId: null }, rowData: { department: 'Marketing', managerId: 'mgr-1' } },
      { tableName: 'IdentityMembers', operation: 'D', changedAt: '2026-05-01T10:00:00Z', rowData: { identityId: 'id-1', principalId: 'u' } },
    ];
    const { events, addedCount, removedCount, changedCount } = buildEntityTimeline('user', 'u', rows, labels);

    expect(events.map(e => e.at)).toEqual([...events.map(e => e.at)].sort().reverse()); // newest first
    const asg = events.find(e => e.eventKind === 'assignment');
    expect(asg.summary).toBe('Added to Finance App (Direct)');
    expect(asg.counterpartyKind).toBe('resource');
    expect(events.find(e => e.eventKind === 'manager').summary).toBe('Manager changed to Alice Boss');
    expect(events.find(e => e.eventKind === 'attribute').attribute).toEqual({ field: 'department', from: 'Sales', to: 'Marketing' });
    expect(events.find(e => e.eventKind === 'identity-member').summary).toBe('Unlinked from identity Wim (person)');

    expect(addedCount).toBe(1);
    expect(removedCount).toBe(1);
    expect(changedCount).toBe(2);
  });
});

describe('buildEntityTimeline — resource view (side detection)', () => {
  it('shows the principal as the counterparty when viewing a resource', () => {
    const rows = [
      { tableName: 'ResourceAssignments', operation: 'I', changedAt: '2026-05-03T10:00:00Z', rowData: { resourceId: 'res-1', principalId: 'u', assignmentType: 'Direct' } },
    ];
    const { events } = buildEntityTimeline('resource', 'res-1', rows, labels);
    expect(events[0].summary).toBe('Bob User granted (Direct)');
    expect(events[0].counterpartyKind).toBe('user');
    expect(events[0].counterpartyId).toBe('u');
  });
});

// ─── Per-event-type handlers (each extracted from buildEntityTimeline) ────
// Every handler mutates a shared accumulator; tests call them in isolation.
const mkAcc = () => ({ events: [], addedCount: 0, removedCount: 0, changedCount: 0 });

describe('timelineAttrEvents', () => {
  it('emits a manager-change event and counts it as a change', () => {
    const acc = mkAcc();
    timelineAttrEvents(
      { tableName: 'Principals', operation: 'U', changedAt: 'T', prevData: { managerId: null }, rowData: { managerId: 'mgr-1' } },
      'u', acc, labels);
    const ev = acc.events.find(e => e.eventKind === 'manager');
    expect(ev.summary).toBe('Manager changed to Alice Boss');
    expect(ev.counterpartyKind).toBe('user');
    expect(acc.changedCount).toBe(1);
  });

  it('emits "Manager removed" with a null counterparty when the manager is cleared', () => {
    const acc = mkAcc();
    timelineAttrEvents({ tableName: 'Principals', operation: 'U', changedAt: 'T', prevData: { managerId: 'mgr-1' }, rowData: { managerId: null } }, 'u', acc, labels);
    const ev = acc.events.find(e => e.eventKind === 'manager');
    expect(ev.summary).toBe('Manager removed');
    expect(ev.counterpartyKind).toBe(null);
  });

  it('emits a formatted attribute diff on update', () => {
    const acc = mkAcc();
    timelineAttrEvents({ tableName: 'Principals', operation: 'U', changedAt: 'T', prevData: { department: 'Sales' }, rowData: { department: 'Marketing' } }, 'u', acc, labels);
    expect(acc.events[0].eventKind).toBe('attribute');
    expect(acc.events[0].summary).toBe('Department: Sales → Marketing');
    expect(acc.changedCount).toBe(1);
  });

  it('emits Created / Deleted for insert / delete', () => {
    const ins = mkAcc();
    timelineAttrEvents({ tableName: 'Resources', operation: 'I', changedAt: 'T', rowData: {} }, 'x', ins, labels);
    expect(ins.events[0].summary).toBe('Created');
    expect(ins.addedCount).toBe(1);
    const del = mkAcc();
    timelineAttrEvents({ tableName: 'Resources', operation: 'D', changedAt: 'T', rowData: {} }, 'x', del, labels);
    expect(del.events[0].summary).toBe('Deleted');
    expect(del.removedCount).toBe(1);
  });
});

describe('timelineAssignmentEvents', () => {
  it('resource is the counterparty when viewing the principal', () => {
    const acc = mkAcc();
    timelineAssignmentEvents({ tableName: 'ResourceAssignments', operation: 'I', changedAt: 'T', rowData: { resourceId: 'res-1', principalId: 'u', assignmentType: 'Direct' } }, 'u', acc, labels);
    expect(acc.events[0].summary).toBe('Added to Finance App (Direct)');
    expect(acc.events[0].counterpartyKind).toBe('resource');
    expect(acc.addedCount).toBe(1);
  });

  it('principal is the counterparty when viewing the resource', () => {
    const acc = mkAcc();
    timelineAssignmentEvents({ tableName: 'ResourceAssignments', operation: 'D', changedAt: 'T', rowData: { resourceId: 'res-1', principalId: 'u', assignmentType: 'Owner' } }, 'res-1', acc, labels);
    expect(acc.events[0].summary).toBe('Bob User removed (Owner)');
    expect(acc.events[0].counterpartyKind).toBe('user');
    expect(acc.removedCount).toBe(1);
  });
});

describe('timelineRelationshipEvents', () => {
  it('child side reads "Added to", parent side reads "Now contains"', () => {
    const child = mkAcc();
    timelineRelationshipEvents({ tableName: 'ResourceRelationships', operation: 'I', changedAt: 'T', rowData: { childResourceId: 'res-x', parentResourceId: 'res-1', relationshipType: 'Contains' } }, 'res-x', child, labels);
    expect(child.events[0].summary).toBe('Added to Finance App (Contains)');
    expect(child.addedCount).toBe(1);

    const parent = mkAcc();
    timelineRelationshipEvents({ tableName: 'ResourceRelationships', operation: 'I', changedAt: 'T', rowData: { childResourceId: 'res-1', parentResourceId: 'res-p' } }, 'res-p', parent, labels);
    expect(parent.events[0].summary).toBe('Now contains Finance App');
  });
});

// ─── Soft delete ─────────────────────────────────────────────────────
// Principals, Resources and ResourceAssignments are soft-delete tables: a
// removal is an UPDATE that stamps deletedAt. The timeline used to look for
// 'D' only, so a removed role never appeared on a user's timeline.
const softDel = (tableName, before, after, extra = {}) => ({
  tableName, operation: 'U', changedAt: '2026-09-08T14:32:00Z',
  prevData: { ...extra, deletedAt: before }, rowData: { ...extra, deletedAt: after },
});

describe('timeline — soft-deleted assignments', () => {
  const asg = { resourceId: 'res-1', principalId: 'u', assignmentType: 'Direct' };

  it('a stamped deletedAt reads as a removal on the user side, coloured as removed', () => {
    const acc = mkAcc();
    timelineAssignmentEvents(softDel('ResourceAssignments', null, '2026-09-08T14:32:00Z', asg), 'u', acc, labels);
    expect(acc.events).toHaveLength(1);
    expect(acc.events[0].summary).toBe('Removed from Finance App (Direct)');
    expect(acc.events[0].operation).toBe('removed');
    expect(acc.removedCount).toBe(1);
    expect(acc.addedCount).toBe(0);
  });

  it('a cleared deletedAt reads as granted again on the resource side', () => {
    const acc = mkAcc();
    timelineAssignmentEvents(softDel('ResourceAssignments', '2026-09-01T00:00:00Z', null, asg), 'res-1', acc, labels);
    expect(acc.events[0].summary).toBe('Bob User granted (Direct)');
    expect(acc.events[0].operation).toBe('added');
    expect(acc.addedCount).toBe(1);
  });

  it('an update that did not cross deletedAt is no event at all', () => {
    const acc = mkAcc();
    timelineAssignmentEvents({ tableName: 'ResourceAssignments', operation: 'U', changedAt: 'T',
      prevData: { ...asg, state: 'a' }, rowData: { ...asg, state: 'b' } }, 'u', acc, labels);
    expect(acc).toEqual(mkAcc());
  });
});

describe('timeline — a held resource deleted in the source', () => {
  const role = { id: 'br-old', displayName: 'Head of Finance', resourceType: 'BusinessRole' };

  it('shows on the user timeline under the snapshot name, linking to the role', () => {
    const acc = mkAcc();
    timelineAttrEvents(softDel('Resources', null, '2026-09-08T14:32:00Z', role), 'u', acc, labels);
    expect(acc.events).toHaveLength(1);
    expect(acc.events[0]).toMatchObject({
      summary: 'Head of Finance deleted in source', operation: 'removed',
      counterpartyKind: 'access-package', counterpartyId: 'br-old', eventKind: 'assignment',
    });
    expect(acc.removedCount).toBe(1);
  });

  it('a restored held resource reads as restored and links to a plain resource', () => {
    const acc = mkAcc();
    timelineAttrEvents(softDel('Resources', '2026-09-01T00:00:00Z', null, { id: 'g1', displayName: 'Sales', resourceType: 'Group' }), 'u', acc, labels);
    expect(acc.events[0]).toMatchObject({ summary: 'Sales restored in source', operation: 'added', counterpartyKind: 'resource' });
    expect(acc.addedCount).toBe(1);
  });

  it('ignores a held resource that was only edited or newly created', () => {
    const edited = mkAcc();
    timelineAttrEvents({ tableName: 'Resources', operation: 'U', changedAt: 'T',
      prevData: { ...role, displayName: 'Old' }, rowData: role }, 'u', edited, labels);
    expect(edited).toEqual(mkAcc());
    const created = mkAcc();
    timelineAttrEvents({ tableName: 'Resources', operation: 'I', changedAt: 'T', rowData: role }, 'u', created, labels);
    expect(created).toEqual(mkAcc());
  });

  it('falls back to the id when the snapshot has no name', () => {
    const acc = mkAcc();
    timelineAttrEvents(softDel('Resources', null, 'T', { id: 'x9' }), 'u', acc, labels);
    expect(acc.events[0].summary).toBe('x9 deleted in source');
  });
});

describe('timeline — the viewed entity itself soft-deleted', () => {
  it('reads "Deleted in source" instead of a Deleted At attribute diff', () => {
    const acc = mkAcc();
    timelineAttrEvents(softDel('Resources', null, '2026-09-08T14:32:00Z', { id: 'br-old', displayName: 'X' }), 'br-old', acc, labels);
    expect(acc.events.map(e => e.summary)).toEqual(['Deleted in source']);
    expect(acc.events[0].operation).toBe('removed');
    expect(acc.removedCount).toBe(1);
    expect(acc.changedCount).toBe(0);
  });

  it('reads "Restored in source" when the stamp is cleared, alongside real attribute edits', () => {
    const acc = mkAcc();
    timelineAttrEvents({ tableName: 'Principals', operation: 'U', changedAt: 'T',
      prevData: { id: 'u', deletedAt: 'T0', department: 'A' }, rowData: { id: 'u', deletedAt: null, department: 'B' } }, 'u', acc, labels);
    expect(acc.events.map(e => e.summary)).toEqual(['Restored in source', 'Department: A → B']);
    expect(acc.addedCount).toBe(1);
    expect(acc.changedCount).toBe(1);
  });
});

describe('timeline — relationships and identity links follow changeAction', () => {
  const rel = { childResourceId: 'res-x', parentResourceId: 'res-1', relationshipType: 'Contains' };

  it('a backfilled relationship column is no longer read as "Removed from"', () => {
    const acc = mkAcc();
    timelineRelationshipEvents({ tableName: 'ResourceRelationships', operation: 'U', changedAt: 'T',
      prevData: { ...rel, roleName: null }, rowData: { ...rel, roleName: 'Member' } }, 'res-x', acc, labels);
    expect(acc).toEqual(mkAcc());
  });

  it('a hard-deleted relationship reads as removed from both sides', () => {
    const child = mkAcc();
    timelineRelationshipEvents({ tableName: 'ResourceRelationships', operation: 'D', changedAt: 'T', rowData: rel }, 'res-x', child, labels);
    expect(child.events[0].summary).toBe('Removed from Finance App (Contains)');
    expect(child.removedCount).toBe(1);
    const parent = mkAcc();
    timelineRelationshipEvents({ tableName: 'ResourceRelationships', operation: 'D', changedAt: 'T',
      rowData: { childResourceId: 'res-1', parentResourceId: 'res-p' } }, 'res-p', parent, labels);
    expect(parent.events[0].summary).toBe('No longer contains Finance App');
  });

  it('an identity-link update that changed nothing relevant is skipped', () => {
    const acc = mkAcc();
    timelineIdentityMemberEvents({ tableName: 'IdentityMembers', operation: 'U', changedAt: 'T',
      prevData: { identityId: 'id-1', principalId: 'u', confidence: 1 }, rowData: { identityId: 'id-1', principalId: 'u', confidence: 2 } }, 'u', acc, labels);
    expect(acc).toEqual(mkAcc());
  });
});

describe('timelineIdentityMemberEvents', () => {
  it('linked account is the counterparty when viewing the identity', () => {
    const acc = mkAcc();
    timelineIdentityMemberEvents({ tableName: 'IdentityMembers', operation: 'I', changedAt: 'T', rowData: { identityId: 'id-1', principalId: 'u' } }, 'id-1', acc, labels);
    expect(acc.events[0].summary).toBe('Account Bob User linked');
    expect(acc.events[0].counterpartyKind).toBe('user');
    expect(acc.addedCount).toBe(1);
  });

  it('identity is the counterparty when viewing the principal', () => {
    const acc = mkAcc();
    timelineIdentityMemberEvents({ tableName: 'IdentityMembers', operation: 'D', changedAt: 'T', rowData: { identityId: 'id-1', principalId: 'u' } }, 'u', acc, labels);
    expect(acc.events[0].summary).toBe('Unlinked from identity Wim (person)');
    expect(acc.events[0].counterpartyKind).toBe('identity');
    expect(acc.removedCount).toBe(1);
  });
});
