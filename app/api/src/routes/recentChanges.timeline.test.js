import { describe, it, expect } from 'vitest';
import { diffPrincipalRow, buildUserTimeline, TIMELINE_SKIP_FIELDS } from './recentChanges.js';

describe('diffPrincipalRow', () => {
  it('reports changed scalar fields as {field, from, to}', () => {
    const diffs = diffPrincipalRow(
      { department: 'Sales', jobTitle: 'Rep' },
      { department: 'Marketing', jobTitle: 'Rep' },
    );
    expect(diffs).toEqual([{ field: 'department', from: 'Sales', to: 'Marketing' }]);
  });

  it('skips bookkeeping / sync-churn fields and managerId', () => {
    const diffs = diffPrincipalRow(
      { managerId: 'a', lastSyncedAt: '2026-01-01', department: 'X' },
      { managerId: 'b', lastSyncedAt: '2026-02-02', department: 'Y' },
    );
    expect(diffs).toEqual([{ field: 'department', from: 'X', to: 'Y' }]);
    expect(TIMELINE_SKIP_FIELDS.has('managerId')).toBe(true);
  });

  it('formats booleans and nulls like the UI', () => {
    const diffs = diffPrincipalRow({ accountEnabled: true }, { accountEnabled: false });
    expect(diffs).toEqual([{ field: 'accountEnabled', from: 'Yes', to: 'No' }]);
  });
});

describe('buildUserTimeline', () => {
  const labels = {
    resource: id => ({ 'res-1': { displayName: 'Finance App', resourceType: 'EntraGroup' } }[id] || null),
    principal: id => ({ 'mgr-1': 'Alice Boss' }[id] || null),
    identity: id => ({ 'id-1': 'Wim (person)' }[id] || null),
  };

  it('merges attribute + relationship events, newest first, with counts', () => {
    const rows = [
      { tableName: 'ResourceAssignments', operation: 'I', changedAt: '2026-05-03T10:00:00Z', rowData: { resourceId: 'res-1', principalId: 'u', assignmentType: 'Direct' } },
      { tableName: 'Principals', operation: 'U', changedAt: '2026-05-02T10:00:00Z', prevData: { department: 'Sales', managerId: null }, rowData: { department: 'Marketing', managerId: 'mgr-1' } },
      { tableName: 'IdentityMembers', operation: 'D', changedAt: '2026-05-01T10:00:00Z', rowData: { identityId: 'id-1', principalId: 'u' } },
    ];
    const { events, addedCount, removedCount, changedCount } = buildUserTimeline(rows, labels);

    // sorted newest-first
    expect(events.map(e => e.at)).toEqual([...events.map(e => e.at)].sort().reverse());
    // assignment added
    const asg = events.find(e => e.eventKind === 'assignment');
    expect(asg.operation).toBe('added');
    expect(asg.summary).toBe('Added to Finance App (Direct)');
    expect(asg.counterpartyKind).toBe('resource');
    // manager change is its own event, not an attribute
    const mgr = events.find(e => e.eventKind === 'manager');
    expect(mgr.summary).toBe('Manager changed to Alice Boss');
    // attribute change carries the structured diff and is NOT the managerId
    const attr = events.find(e => e.eventKind === 'attribute');
    expect(attr.attribute).toEqual({ field: 'department', from: 'Sales', to: 'Marketing' });
    expect(events.some(e => e.eventKind === 'attribute' && e.attribute.field === 'managerId')).toBe(false);
    // identity unlink
    const idm = events.find(e => e.eventKind === 'identity-member');
    expect(idm.operation).toBe('removed');

    expect(addedCount).toBe(1);   // assignment I
    expect(removedCount).toBe(1); // identity D
    expect(changedCount).toBe(2); // manager + department
  });

  it('emits one event per changed attribute field', () => {
    const rows = [{
      tableName: 'Principals', operation: 'U', changedAt: '2026-05-02T10:00:00Z',
      prevData: { department: 'A', jobTitle: 'X' }, rowData: { department: 'B', jobTitle: 'Y' },
    }];
    const { events } = buildUserTimeline(rows, labels);
    expect(events.filter(e => e.eventKind === 'attribute')).toHaveLength(2);
  });
});
