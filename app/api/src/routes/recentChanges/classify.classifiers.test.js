// Unit tests for the recent-changes row classifiers (#1031). The lookups are
// mocked (fake display names) while toEvent / resourceCounterpartyKind stay
// real, so every branch — insert/delete, the parent vs child relationship side,
// manager change vs removal, and the "no event" fallbacks — is exercised without
// a DB. The end-to-end wiring is covered by recentChanges.data.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    lookupResource: vi.fn(async (id) => (id ? { displayName: `Res-${id}`, resourceType: 'Group' } : null)),
    lookupPrincipal: vi.fn(async (id) => (id ? `Prin-${id}` : null)),
    lookupIdentity: vi.fn(async (id) => (id ? `Iden-${id}` : null)),
  };
});

const { classifyUserRow, classifyResourceRow, classifyAccessPackageRow, classifyIdentityRow } =
  await import('./classify.js');

const row = (tableName, operation, rowData = {}, prevData = {}) =>
  ({ tableName, operation, changedAt: '2026-01-01T00:00:00Z', rowData, prevData });

describe('classifyUserRow', () => {
  it('assignment insert → Added, added=1', async () => {
    const r = await classifyUserRow(row('ResourceAssignments', 'I', { resourceId: 'r1', assignmentType: 'Direct' }));
    expect(r).toMatchObject({ added: 1, removed: 0 });
    expect(r.event.summary).toBe('Added to Res-r1 (Direct)');
  });
  it('assignment delete → Removed, removed=1', async () => {
    const r = await classifyUserRow(row('ResourceAssignments', 'D', { resourceId: 'r1' }));
    expect(r.removed).toBe(1);
    expect(r.event.summary).toBe('Removed from Res-r1');
  });
  it('assignment update → no event', async () => {
    expect((await classifyUserRow(row('ResourceAssignments', 'U', { resourceId: 'r1' }))).event).toBeNull();
  });
  it('identity link/unlink → event, no counts', async () => {
    const i = await classifyUserRow(row('IdentityMembers', 'I', { identityId: 'id1' }));
    expect(i).toMatchObject({ added: 0, removed: 0 });
    expect(i.event.summary).toBe('Linked to identity Iden-id1');
    expect((await classifyUserRow(row('IdentityMembers', 'D', { identityId: 'id1' }))).event.summary)
      .toBe('Unlinked from identity Iden-id1');
  });
  it('manager changed vs removed', async () => {
    expect((await classifyUserRow(row('Principals', 'U', { managerId: 'm2' }, { managerId: 'm1' }))).event.summary)
      .toBe('Manager changed to Prin-m2');
    expect((await classifyUserRow(row('Principals', 'U', { managerId: null }, { managerId: 'm1' }))).event.summary)
      .toBe('Manager removed');
  });
  it('manager unchanged and unknown table → no event', async () => {
    expect((await classifyUserRow(row('Principals', 'U', { managerId: 'm1' }, { managerId: 'm1' }))).event).toBeNull();
    expect((await classifyUserRow(row('Other', 'I', {}))).event).toBeNull();
  });
});

describe('classifyResourceRow', () => {
  it('assignment granted/removed', async () => {
    const i = await classifyResourceRow(row('ResourceAssignments', 'I', { principalId: 'p1', assignmentType: 'Eligible' }), 'res');
    expect(i.added).toBe(1);
    expect(i.event.summary).toBe('Prin-p1 granted (Eligible)');
    expect((await classifyResourceRow(row('ResourceAssignments', 'D', { principalId: 'p1' }), 'res')).event.summary)
      .toBe('Prin-p1 removed');
  });
  it('relationship where we are the child → Added to / Removed from', async () => {
    expect((await classifyResourceRow(row('ResourceRelationships', 'I', { childResourceId: 'res', parentResourceId: 'par', relationshipType: 'Contains' }), 'res')).event.summary)
      .toBe('Added to Res-par (Contains)');
    expect((await classifyResourceRow(row('ResourceRelationships', 'D', { childResourceId: 'res', parentResourceId: 'par' }), 'res')).event.summary)
      .toBe('Removed from Res-par');
  });
  it('relationship where we are the parent → Contained / No longer contains', async () => {
    expect((await classifyResourceRow(row('ResourceRelationships', 'I', { childResourceId: 'ch', parentResourceId: 'res' }), 'res')).event.summary)
      .toBe('Contained Res-ch');
    expect((await classifyResourceRow(row('ResourceRelationships', 'D', { childResourceId: 'ch', parentResourceId: 'res' }), 'res')).event.summary)
      .toBe('No longer contains Res-ch');
  });
  it('unknown table → no event', async () => {
    expect((await classifyResourceRow(row('Other', 'I', {}), 'res')).event).toBeNull();
  });
});

describe('classifyAccessPackageRow', () => {
  it('assignment granted/lost', async () => {
    expect((await classifyAccessPackageRow(row('ResourceAssignments', 'I', { principalId: 'p1' }))).event.summary)
      .toBe('Prin-p1 granted this role');
    expect((await classifyAccessPackageRow(row('ResourceAssignments', 'D', { principalId: 'p1' }))).event.summary)
      .toBe('Prin-p1 lost this role');
  });
  it('relationship added/removed', async () => {
    expect((await classifyAccessPackageRow(row('ResourceRelationships', 'I', { childResourceId: 'c1' }))).event.summary)
      .toBe('Res-c1 added to this role');
    expect((await classifyAccessPackageRow(row('ResourceRelationships', 'D', { childResourceId: 'c1' }))).event.summary)
      .toBe('Res-c1 removed from this role');
  });
  it('unknown table → no event', async () => {
    expect((await classifyAccessPackageRow(row('Other', 'I', {}))).event).toBeNull();
  });
});

describe('classifyIdentityRow', () => {
  it('account linked/unlinked', async () => {
    const i = await classifyIdentityRow(row('IdentityMembers', 'I', { principalId: 'p1' }));
    expect(i.added).toBe(1);
    expect(i.event.summary).toBe('Account Prin-p1 linked');
    const d = await classifyIdentityRow(row('IdentityMembers', 'D', { principalId: 'p1' }));
    expect(d.removed).toBe(1);
    expect(d.event.summary).toBe('Account Prin-p1 unlinked');
  });
  it('other operation → no event', async () => {
    expect((await classifyIdentityRow(row('IdentityMembers', 'U', { principalId: 'p1' }))).event).toBeNull();
  });
});

// ── soft-delete removals ─────────────────────────────────────────────
//
// Memberships are not deleted, they are STAMPED. `ResourceAssignments` is a
// soft-delete table (ingest/engine.js, SOFT_DELETE_TABLES): removing one sets
// `deletedAt`, so the audit trigger writes an UPDATE. Classifying on 'I' and
// 'D' alone therefore showed every addition and no removal at all — on the
// deployment this was found on, 127 removals between June and September were
// invisible, while the 7562 'D' rows the timeline did show had stopped in
// early July, when soft delete landed.

const softDeleted = (tableName, rowData = {}) => row(
  tableName, 'U',
  { ...rowData, deletedAt: '2026-09-21T10:00:00Z' },
  { ...rowData, deletedAt: null },
);
const revived = (tableName, rowData = {}) => row(
  tableName, 'U',
  { ...rowData, deletedAt: null },
  { ...rowData, deletedAt: '2026-09-01T10:00:00Z' },
);
// Something else changed — a backfilled column, a renamed attribute.
const touched = (tableName, rowData = {}) => row(
  tableName, 'U',
  { ...rowData, assignmentType: 'Indirect' },
  { ...rowData, assignmentType: 'Direct' },
);

describe('a membership that was soft-deleted', () => {
  it('reads as a removal on the user timeline', async () => {
    const r = await classifyUserRow(softDeleted('ResourceAssignments', { resourceId: 'r1', assignmentType: 'Direct' }));
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect(r.event.summary).toBe('Removed from Res-r1 (Direct)');
  });

  it('reads as a removal on the resource timeline', async () => {
    const r = await classifyResourceRow(softDeleted('ResourceAssignments', { principalId: 'p1' }), 'r1');
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect(r.event.summary).toBe('Prin-p1 removed');
  });

  it('reads as a removal on an access package', async () => {
    const r = await classifyAccessPackageRow(softDeleted('ResourceAssignments', { principalId: 'p1' }));
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect(r.event.summary).toBe('Prin-p1 lost this role');
  });
});

describe('a membership that came back', () => {
  it('reads as an addition, because re-ingesting one clears deletedAt', async () => {
    const r = await classifyUserRow(revived('ResourceAssignments', { resourceId: 'r1' }));
    expect(r).toMatchObject({ added: 1, removed: 0 });
    expect(r.event.summary).toBe('Added to Res-r1');
  });
});

describe('an update that changed something else', () => {
  it('is not a membership change on any timeline', async () => {
    // The discriminating case. These outnumber the real removals 60:1 in the
    // data (7617 of them), so counting them as changes would bury the ones
    // that matter — and the relationship classifier used to call every
    // non-insert a removal, which is exactly that failure.
    expect(await classifyUserRow(touched('ResourceAssignments', { resourceId: 'r1' }))).toMatchObject({ event: null });
    expect(await classifyResourceRow(touched('ResourceAssignments', { principalId: 'p1' }), 'r1')).toMatchObject({ event: null });
    expect(await classifyAccessPackageRow(touched('ResourceAssignments', { principalId: 'p1' }))).toMatchObject({ event: null });
  });

  it('is not a relationship change either', async () => {
    const r = await classifyResourceRow(
      row('ResourceRelationships', 'U',
        { childResourceId: 'r1', parentResourceId: 'r2', relationshipType: 'Contains' },
        { childResourceId: 'r1', parentResourceId: 'r2', relationshipType: 'Contains' }),
      'r1',
    );
    expect(r).toMatchObject({ event: null, added: 0, removed: 0 });
  });
});
