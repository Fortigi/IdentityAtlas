// Unit tests for savedFilterHistory.js — turning `_history` snapshots of a
// saved matrix into the trail the History dialog shows. Pure; no DB.

import { describe, it, expect } from 'vitest';
import {
  filterChangeParts, savedMatrixChanges, savedMatrixHistoryEvent, savedMatrixHistory,
  formatHistoryValue,
} from './savedFilterHistory.js';

describe('filterChangeParts', () => {
  it('names the part each changed key belongs to', () => {
    expect(filterChangeParts({ subject: { include: [] } }, { subject: { include: ['a'] } })).toEqual(['subjects']);
    expect(filterChangeParts({ resource: { include: [] } }, { resource: { include: ['a'] } })).toEqual(['resources']);
    expect(filterChangeParts({ managed: 'all' }, { managed: 'gaps' })).toEqual(['governed lens']);
  });

  it('lists parts in reading order, not in the order the keys happen to sit in', () => {
    // `rollup` is written first and `subject` second; the answer must still put
    // subjects first, or the same change reads differently on two events.
    const parts = filterChangeParts(
      { rollup: '', subject: { include: [] } },
      { rollup: 'department', subject: { include: ['x'] } },
    );
    expect(parts).toEqual(['subjects', 'roll-up']);
  });

  it('separates where the analyst had drilled from what the matrix compares', () => {
    // A re-save after expanding a group must not read as "the roll-up changed".
    expect(filterChangeParts({ rollupExpanded: [] }, { rollupExpanded: ['sales'] })).toEqual(['view state']);
    expect(filterChangeParts({ rollupContextId: 'a' }, { rollupContextId: 'b' })).toEqual(['roll-up']);
  });

  it('still reports a key nobody has classified', () => {
    expect(filterChangeParts({}, { somethingNew: true })).toEqual(['other settings']);
  });

  it('compares by value, so an equal filter rebuilt from scratch is not a change', () => {
    expect(filterChangeParts(
      { subject: { include: [{ kind: 'context', contextId: 'c1' }] } },
      { subject: { include: [{ kind: 'context', contextId: 'c1' }] } },
    )).toEqual([]);
  });

  it('counts a key that disappeared, not only one that was added', () => {
    expect(filterChangeParts({ rollup: 'department' }, {})).toEqual(['roll-up']);
  });

  it('reports each part once however many of its keys moved', () => {
    expect(filterChangeParts(
      { rollup: 'a', rollupMetric: 'count' },
      { rollup: 'b', rollupMetric: 'percent' },
    )).toEqual(['roll-up']);
  });
});

describe('formatHistoryValue', () => {
  it('spells absent, boolean and object values the way the rest of the app does', () => {
    expect(formatHistoryValue(null)).toBe('—');
    expect(formatHistoryValue(undefined)).toBe('—');
    expect(formatHistoryValue(true)).toBe('Yes');
    expect(formatHistoryValue(false)).toBe('No');
    expect(formatHistoryValue({ a: 1 })).toBe('{"a":1}');
    expect(formatHistoryValue(0)).toBe('0');
  });
});

describe('savedMatrixChanges', () => {
  it('reports a rename with both sides', () => {
    expect(savedMatrixChanges({ name: 'Sales' }, { name: 'Sales EMEA' }))
      .toEqual([{ field: 'name', label: 'Name', from: 'Sales', to: 'Sales EMEA' }]);
  });

  it('reads a description that was added as coming from nothing', () => {
    expect(savedMatrixChanges({ description: null }, { description: 'Quarterly review' }))
      .toEqual([{ field: 'description', label: 'Description', from: '—', to: 'Quarterly review' }]);
  });

  it('spells the org-default flag rather than printing a boolean', () => {
    expect(savedMatrixChanges({ isDefault: false }, { isDefault: true }))
      .toEqual([{ field: 'isDefault', label: 'Org default', from: 'No', to: 'Yes' }]);
  });

  it('reports the filter by the parts it touched, never as two blobs of JSON', () => {
    const changes = savedMatrixChanges(
      { filter: { subject: { include: [] } } },
      { filter: { subject: { include: ['x'] } } },
    );
    expect(changes).toEqual([{ field: 'filter', label: 'Matrix contents', parts: ['subjects'] }]);
    expect(changes[0].from).toBeUndefined();
  });

  it('ignores the bookkeeping columns that carry the event itself', () => {
    expect(savedMatrixChanges(
      { name: 'Sales', updatedBy: 'anna@example.com', updatedAt: '2026-01-01', id: 'a' },
      { name: 'Sales', updatedBy: 'wim@example.com', updatedAt: '2026-02-02', id: 'a' },
    )).toEqual([]);
  });

  it('reports a column the lists do not name, so the trail cannot go silent', () => {
    expect(savedMatrixChanges({ retention: null }, { retention: 30 }))
      .toEqual([{ field: 'retention', label: 'retention', from: '—', to: '30' }]);
  });

  it('lists the name before the matrix contents when one change did both', () => {
    const changes = savedMatrixChanges(
      { name: 'Sales', filter: { managed: 'all' } },
      { name: 'Sales EMEA', filter: { managed: 'gaps' } },
    );
    expect(changes.map(c => c.field)).toEqual(['name', 'filter']);
  });
});

describe('savedMatrixHistoryEvent', () => {
  it('credits a creation to whoever first saved it', () => {
    expect(savedMatrixHistoryEvent({
      operation: 'I', changedAt: '2026-03-01T10:00:00Z',
      rowData: { createdBy: 'wim@example.com', updatedBy: 'wim@example.com', name: 'Sales' },
    })).toEqual({ at: '2026-03-01T10:00:00Z', actor: 'wim@example.com', operation: 'created', changes: [] });
  });

  it('falls back to updatedBy when a creation carries no createdBy', () => {
    expect(savedMatrixHistoryEvent({ operation: 'I', rowData: { updatedBy: 'anna@example.com' } }).actor)
      .toBe('anna@example.com');
  });

  it('credits a change to the person the snapshot names as its last writer', () => {
    const event = savedMatrixHistoryEvent({
      operation: 'U', changedAt: '2026-04-02T09:00:00Z',
      prevData: { name: 'Sales', updatedBy: 'wim@example.com' },
      rowData: { name: 'Sales EMEA', updatedBy: 'anna@example.com' },
    });
    expect(event.actor).toBe('anna@example.com');
    expect(event.operation).toBe('changed');
    expect(event.changes).toEqual([{ field: 'name', label: 'Name', from: 'Sales', to: 'Sales EMEA' }]);
  });

  it('drops an update that only re-stamped who saved it', () => {
    expect(savedMatrixHistoryEvent({
      operation: 'U',
      prevData: { name: 'Sales', updatedBy: 'wim@example.com' },
      rowData: { name: 'Sales', updatedBy: 'anna@example.com' },
    })).toBeNull();
  });

  it('does not put a name on a deletion, because nothing records who did it', () => {
    expect(savedMatrixHistoryEvent({
      operation: 'D', changedAt: '2026-05-01T10:00:00Z',
      rowData: { name: 'Sales', updatedBy: 'anna@example.com' },
    })).toEqual({ at: '2026-05-01T10:00:00Z', actor: null, operation: 'deleted', changes: [] });
  });
});

describe('savedMatrixHistory', () => {
  it('keeps the query order and leaves out the no-op updates', () => {
    const events = savedMatrixHistory([
      { operation: 'U', changedAt: '2026-04-02T09:00:00Z', prevData: { name: 'A' }, rowData: { name: 'B', updatedBy: 'anna@example.com' } },
      { operation: 'U', changedAt: '2026-04-01T09:00:00Z', prevData: { name: 'A', updatedBy: 'x' }, rowData: { name: 'A', updatedBy: 'y' } },
      { operation: 'I', changedAt: '2026-03-01T10:00:00Z', rowData: { createdBy: 'wim@example.com' } },
    ]);
    expect(events.map(e => [e.operation, e.at])).toEqual([
      ['changed', '2026-04-02T09:00:00Z'],
      ['created', '2026-03-01T10:00:00Z'],
    ]);
  });

  it('answers an absent or non-array body with an empty trail', () => {
    expect(savedMatrixHistory(undefined)).toEqual([]);
    expect(savedMatrixHistory(null)).toEqual([]);
  });
});
