import { describe, it, expect, vi } from 'vitest';
import { annotateReferences, objectsAt, collectRefs } from './annotate.js';

const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUT = 'aaaaaaaa-0000-4000-8000-000000000002';
const HELD = 'bbbbbbbb-0000-4000-8000-000000000001';

// A fake scope: the team principal and the held resource open; nothing else.
function fakeAccess() {
  const open = { principal: new Set([TEAM]), resource: new Set([HELD]), identity: new Set(), context: new Set() };
  return {
    accessibleIds: vi.fn(async (kind, ids) => new Set(ids.filter(id => open[kind]?.has(id)))),
  };
}

describe('objectsAt', () => {
  it('walks into arrays along the path', () => {
    const body = { before: { relationships: [{ id: 1 }] }, after: { relationships: [{ id: 2 }, null, 'x'] } };
    expect(objectsAt(body, 'after.relationships')).toEqual([{ id: 2 }]);
    expect(objectsAt([{ a: [{ id: 3 }] }, { a: { id: 4 } }], 'a')).toEqual([{ id: 3 }, { id: 4 }]);
  });

  it('the empty path is the body, or each element of a body array', () => {
    expect(objectsAt({ id: 1 }, '')).toEqual([{ id: 1 }]);
    expect(objectsAt([{ id: 1 }, { id: 2 }], '')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('a missing branch yields nothing', () => {
    expect(objectsAt({ manager: null }, 'manager')).toEqual([]);
    expect(objectsAt({}, 'a.b.c')).toEqual([]);
  });
});

describe('collectRefs', () => {
  it('skips an object without an id, or with a kind that has no detail page', () => {
    const body = { events: [{ counterpartyKind: 'user', counterpartyId: TEAM }, { counterpartyKind: 'leaf', counterpartyId: OUT }, { counterpartyKind: 'user', counterpartyId: null }] };
    const found = collectRefs(body, [{ at: 'events', kindKey: 'counterpartyKind', key: 'counterpartyId' }]);
    expect(found.map(f => [f.kind, f.id, f.flag])).toEqual([['principal', TEAM, 'accessible']]);
  });
});

describe('annotateReferences', () => {
  it('marks every member of a list — the outsider stays listed, flagged false', async () => {
    const body = [{ principalId: TEAM, displayName: 'Tim' }, { principalId: OUT, displayName: 'Olga' }];
    await annotateReferences(body, [{ at: '', kind: 'principal', key: 'principalId' }], fakeAccess());
    expect(body).toEqual([
      { principalId: TEAM, displayName: 'Tim', accessible: true },
      { principalId: OUT, displayName: 'Olga', accessible: false },
    ]);
  });

  it('classifies per kind, in one batch each, with ids de-duplicated and lower-cased', async () => {
    const access = fakeAccess();
    const body = { events: [
      { counterpartyKind: 'user', counterpartyId: TEAM.toUpperCase() },
      { counterpartyKind: 'user', counterpartyId: TEAM },
      { counterpartyKind: 'resource', counterpartyId: HELD },
      { counterpartyKind: 'access-package', counterpartyId: OUT },
    ] };
    await annotateReferences(body, [{ at: 'events', kindKey: 'counterpartyKind', key: 'counterpartyId' }], access);
    expect(body.events.map(e => e.accessible)).toEqual([true, true, true, false]);
    expect(access.accessibleIds).toHaveBeenCalledTimes(2);
    expect(access.accessibleIds).toHaveBeenCalledWith('principal', [TEAM]);
    expect(access.accessibleIds).toHaveBeenCalledWith('resource', [HELD, OUT]);
  });

  it('the first ref with an id decides a shared flag (an account before its person)', async () => {
    const refs = [{ at: '', kind: 'principal', key: 'principalId' }, { at: '', kind: 'identity', key: 'identityId' }];
    const rows = [
      { principalId: TEAM, identityId: OUT },  // the account decides: open
      { principalId: null, identityId: OUT },  // only a person: the person decides
    ];
    await annotateReferences(rows, refs, fakeAccess());
    expect(rows.map(r => r.accessible)).toEqual([true, false]);
  });

  it('a ref with its own flag writes beside the main one', async () => {
    const rows = [{ resourceId: HELD, principalId: OUT }];
    await annotateReferences(rows, [
      { at: '', kind: 'resource', key: 'resourceId' },
      { at: '', kind: 'principal', key: 'principalId', flag: 'principalAccessible' },
    ], fakeAccess());
    expect(rows[0]).toMatchObject({ accessible: true, principalAccessible: false });
  });

  it('leaves a body untouched when there is nothing to mark', async () => {
    const access = fakeAccess();
    expect(await annotateReferences(null, [{ at: '', kind: 'principal', key: 'id' }], access)).toBeNull();
    const body = { error: 'Not found' };
    expect(await annotateReferences(body, [{ at: '', kind: 'principal', key: 'id' }], access)).toEqual({ error: 'Not found' });
    expect(await annotateReferences(body, [], access)).toBe(body);
  });
});
