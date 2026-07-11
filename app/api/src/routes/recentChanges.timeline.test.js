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
