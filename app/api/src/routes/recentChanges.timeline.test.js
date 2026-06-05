import { describe, it, expect } from 'vitest';
import { diffRow, buildEntityTimeline, TIMELINE_SKIP_FIELDS } from './recentChanges.js';

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
  resource: id => ({ 'res-1': { displayName: 'Finance App', resourceType: 'EntraGroup' } }[id] || null),
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
