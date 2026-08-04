// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import {
  useBusinessRoleFold, buildRoleChildMap, analyseRoleRows, hideFoldedRows,
  collectFoldedChildRows, markRoleChildren, rowResourceKey, ROLE_FOLD_VERSION,
} from './useBusinessRoleFold';

const storeKey = (k) => `fgraph-rolefold-${k || 'all'}`;

// jsdom in this project runs without an origin, so window.localStorage is
// absent. Back it with a simple in-memory Map for these tests.
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// Fixture from the spec: BR1 contains {G1, G2}, BR2 contains {G2, G3}, G4 in no
// role. Both business roles have a row of their own in the grid.
const AP_GROUPS = [
  { accessPackageId: 'BR1', resourceId: 'G1' },
  { accessPackageId: 'BR1', resourceId: 'G2' },
  { accessPackageId: 'BR2', resourceId: 'G2' },
  { accessPackageId: 'BR2', groupId: 'G3' },
];

const ROWS = [
  { id: 'BR1', displayName: 'Business Role 1' },
  { id: 'G1', displayName: 'Group 1' },
  { id: 'G2', displayName: 'Group 2' },
  { id: 'BR2', displayName: 'Business Role 2' },
  { id: 'G3', displayName: 'Group 3' },
  { id: 'G4', displayName: 'Group 4' },
];

const ids = (rows) => rows.map((r) => r.id);

function render(props = {}) {
  return renderHook(({ p }) => useBusinessRoleFold(p), {
    initialProps: {
      p: {
        accessPackageGroups: AP_GROUPS,
        rows: ROWS,
        storageKey: 'matrix-a',
        ...props,
      },
    },
  });
}

describe('buildRoleChildMap', () => {
  it('maps each business role to the resources it contains', () => {
    const map = buildRoleChildMap(AP_GROUPS);
    expect([...map.get('BR1')]).toEqual(['G1', 'G2']);
    expect([...map.get('BR2')]).toEqual(['G2', 'G3']);
  });

  it('matches ids case-insensitively and accepts the businessRoleId alias', () => {
    const map = buildRoleChildMap([{ businessRoleId: 'br1', groupId: 'g1' }]);
    expect(map.get('BR1').has('G1')).toBe(true);
  });

  it('ignores rows without a resource, and a role that contains itself', () => {
    const map = buildRoleChildMap([
      { accessPackageId: 'BR1', resourceId: null, groupId: null },
      { accessPackageId: 'BR2', resourceId: 'BR2' },
      { accessPackageId: '', resourceId: 'G9' },
    ]);
    expect(map.size).toBe(0);
  });

  it('tolerates a missing list', () => {
    expect(buildRoleChildMap(undefined).size).toBe(0);
  });
});

describe('analyseRoleRows', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);

  it('marks roles present in the grid as foldable and counts their child rows', () => {
    const { foldableRoles, childCounts, rolesByChild } = analyseRoleRows(ROWS, childrenByRole);
    expect([...foldableRoles].sort()).toEqual(['BR1', 'BR2']);
    expect(childCounts.get('BR1')).toBe(2);
    expect(childCounts.get('BR2')).toBe(2);
    // G2 is granted by both roles
    expect([...rolesByChild.get('G2')].sort()).toEqual(['BR1', 'BR2']);
    expect(rolesByChild.has('G4')).toBe(false);
  });

  it('gives no fold affordance to a role that has no row in the grid (D4)', () => {
    const rows = ROWS.filter((r) => r.id !== 'BR1');
    const { foldableRoles, rolesByChild } = analyseRoleRows(rows, childrenByRole);
    expect(foldableRoles.has('BR1')).toBe(false);
    // G1 is only granted by the absent BR1 → nothing can hide it
    expect(rolesByChild.has('G1')).toBe(false);
  });

  it('ignores nested sub-rows when deciding what is present', () => {
    const rows = [
      { id: 'BR1' },
      { id: 'BR1__nested__G1', realGroupId: 'G1', isNestedRow: true, nestLevel: 1 },
    ];
    const { foldableRoles } = analyseRoleRows(rows, childrenByRole);
    expect(foldableRoles.size).toBe(0);
  });

  it('does not count a role whose resources are all outside the grid', () => {
    const { foldableRoles } = analyseRoleRows([{ id: 'BR1' }, { id: 'G4' }], childrenByRole);
    expect(foldableRoles.size).toBe(0);
  });
});

describe('hideFoldedRows', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const { rolesByChild } = analyseRoleRows(ROWS, childrenByRole);

  it('returns the rows untouched when nothing is folded', () => {
    expect(hideFoldedRows(ROWS, rolesByChild, new Set())).toBe(ROWS);
  });

  it('keeps a shared resource visible while one of its roles is expanded (D3)', () => {
    expect(ids(hideFoldedRows(ROWS, rolesByChild, new Set(['BR1']))))
      .toEqual(['BR1', 'G2', 'BR2', 'G3', 'G4']);
  });

  it('hides a shared resource once every role granting it is folded (D3)', () => {
    expect(ids(hideFoldedRows(ROWS, rolesByChild, new Set(['BR1', 'BR2']))))
      .toEqual(['BR1', 'BR2', 'G4']);
  });

  it('takes a hidden row\'s expanded nested sub-rows with it', () => {
    const rows = [
      { id: 'BR1' },
      { id: 'G1' },
      { id: 'G1__nested__X', isNestedRow: true, nestLevel: 1 },
      { id: 'G1__nested__X__nested__Y', isNestedRow: true, nestLevel: 2 },
      { id: 'G2' },
      { id: 'G4' },
    ];
    const analysis = analyseRoleRows(rows, childrenByRole);
    expect(ids(hideFoldedRows(rows, analysis.rolesByChild, new Set(['BR1']))))
      .toEqual(['BR1', 'G4']);
  });

  it('keeps nested sub-rows of a row that stays visible', () => {
    const rows = [
      { id: 'BR1' },
      { id: 'G1' },
      { id: 'G4' },
      { id: 'G4__nested__X', isNestedRow: true, nestLevel: 1 },
    ];
    const analysis = analyseRoleRows(rows, childrenByRole);
    expect(ids(hideFoldedRows(rows, analysis.rolesByChild, new Set(['BR1']))))
      .toEqual(['BR1', 'G4', 'G4__nested__X']);
  });
});

describe('collectFoldedChildRows', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const { rolesByChild } = analyseRoleRows(ROWS, childrenByRole);

  it('is empty when nothing is folded', () => {
    expect(collectFoldedChildRows(ROWS, rolesByChild, new Set()).size).toBe(0);
  });

  it('lists the rows a folded role took away', () => {
    const byRole = collectFoldedChildRows(ROWS, rolesByChild, new Set(['BR1', 'BR2']));
    expect(ids(byRole.get('BR1'))).toEqual(['G1', 'G2']);
    expect(ids(byRole.get('BR2'))).toEqual(['G2', 'G3']);
  });

  it('omits a shared resource that is still visible because one role is expanded', () => {
    const byRole = collectFoldedChildRows(ROWS, rolesByChild, new Set(['BR1']));
    // G2 is also granted by the expanded BR2, so it never left the grid.
    expect(ids(byRole.get('BR1'))).toEqual(['G1']);
    expect(byRole.has('BR2')).toBe(false);
  });

  it('ignores nested sub-rows — they follow the row they hang under', () => {
    const rows = [...ROWS, { id: 'G1__nested__X', realGroupId: 'G1', isNestedRow: true, nestLevel: 1 }];
    const byRole = collectFoldedChildRows(rows, rolesByChild, new Set(['BR1', 'BR2']));
    expect(ids(byRole.get('BR1'))).toEqual(['G1', 'G2']);
  });
});

describe('markRoleChildren', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const { foldableRoles, rolesByChild } = analyseRoleRows(ROWS, childrenByRole);
  const parents = (rows) => rows.map((r) => r.roleParentId || null);

  it('marks the resources sitting directly under the role that grants them', () => {
    const marked = markRoleChildren(ROWS, foldableRoles, rolesByChild);
    expect(ids(marked)).toEqual(ids(ROWS));
    expect(parents(marked)).toEqual([null, 'BR1', 'BR1', null, 'BR2', null]);
  });

  it('does not indent a resource that is not adjacent to one of its roles', () => {
    // G1 has drifted below G4, away from BR1's block.
    const rows = [{ id: 'BR1' }, { id: 'G4' }, { id: 'G1' }];
    expect(parents(markRoleChildren(rows, foldableRoles, rolesByChild))).toEqual([null, null, null]);
  });

  it('carries the marking onto a child row\'s own nested sub-rows', () => {
    const rows = [
      { id: 'BR1' },
      { id: 'G1' },
      { id: 'G1__nested__X', isNestedRow: true, nestLevel: 1 },
      { id: 'G4' },
      { id: 'G4__nested__Y', isNestedRow: true, nestLevel: 1 },
    ];
    expect(parents(markRoleChildren(rows, foldableRoles, rolesByChild)))
      .toEqual([null, 'BR1', 'BR1', null, null]);
  });

  it('returns the rows untouched when nothing can be marked', () => {
    expect(markRoleChildren(ROWS, new Set(), rolesByChild)).toBe(ROWS);
    expect(markRoleChildren([{ id: 'G4' }], foldableRoles, rolesByChild)).toHaveLength(1);
  });
});

describe('rowResourceKey', () => {
  it('prefers the real resource id of a synthetic row', () => {
    expect(rowResourceKey({ id: 'g1__owner', realGroupId: 'g1' })).toBe('G1');
    expect(rowResourceKey({ id: 'g2' })).toBe('G2');
  });
});

describe('useBusinessRoleFold', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('starts expanded and exposes the foldable roles', () => {
    const { result } = render();
    expect(result.current.canFoldRoles).toBe(true);
    expect(result.current.hasFoldedRoles).toBe(false);
    expect(ids(result.current.visibleRows)).toEqual(ids(ROWS));
    expect(result.current.roleChildCounts.get('BR1')).toBe(2);
  });

  it('renders the resources of an expanded role as its children', () => {
    const { result } = render();
    const byId = new Map(result.current.visibleRows.map((r) => [r.id, r]));
    expect(byId.get('G1').roleParentId).toBe('BR1');
    expect(byId.get('G3').roleParentId).toBe('BR2');
    expect(byId.get('G4').roleParentId).toBeUndefined();
  });

  it('reports the rows each folded role took away', () => {
    const { result } = render();
    expect(result.current.foldedChildRows.size).toBe(0);
    act(() => result.current.foldAllRoles());
    expect(ids(result.current.foldedChildRows.get('BR1'))).toEqual(['G1', 'G2']);
    expect(ids(result.current.foldedChildRows.get('BR2'))).toEqual(['G2', 'G3']);
  });

  it('offers no fold at all for a matrix without business-role rows', () => {
    const { result } = render({ accessPackageGroups: [] });
    expect(result.current.canFoldRoles).toBe(false);
    expect(result.current.foldableRoles.size).toBe(0);
  });

  it('folds and unfolds a single role', () => {
    const { result } = render();
    act(() => result.current.toggleRoleFold('br1'));
    expect(result.current.hasFoldedRoles).toBe(true);
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'G2', 'BR2', 'G3', 'G4']);
    act(() => result.current.toggleRoleFold('BR1'));
    expect(ids(result.current.visibleRows)).toEqual(ids(ROWS));
  });

  it('folds every role at once, leaving roles plus ungranted resources', () => {
    const { result } = render();
    act(() => result.current.foldAllRoles());
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
    act(() => result.current.unfoldAllRoles());
    expect(ids(result.current.visibleRows)).toEqual(ids(ROWS));
  });

  it('persists folds per matrix and restores them on a later mount', () => {
    const first = render();
    act(() => first.result.current.foldAllRoles());
    const saved = JSON.parse(localStorage.getItem(storeKey('matrix-a')));
    expect(saved.version).toBe(ROLE_FOLD_VERSION);
    expect(saved.folded.sort()).toEqual(['BR1', 'BR2']);

    const second = render();
    expect(ids(second.result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
  });

  it('clears the stored entry when everything is unfolded again', () => {
    const { result } = render();
    act(() => result.current.foldAllRoles());
    act(() => result.current.unfoldAllRoles());
    expect(localStorage.getItem(storeKey('matrix-a'))).toBeNull();
  });

  it('keeps fold state independent per matrix filter', () => {
    localStorage.setItem(storeKey('matrix-a'), JSON.stringify({ version: ROLE_FOLD_VERSION, folded: ['BR1'] }));
    const { result, rerender } = render();
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'G2', 'BR2', 'G3', 'G4']);
    rerender({ p: { accessPackageGroups: AP_GROUPS, rows: ROWS, storageKey: 'matrix-b' } });
    expect(ids(result.current.visibleRows)).toEqual(ids(ROWS));
  });

  it('discards a stored fold set written by an older version', () => {
    localStorage.setItem(storeKey('matrix-a'), JSON.stringify({ version: ROLE_FOLD_VERSION - 1, folded: ['BR1'] }));
    const { result } = render();
    expect(result.current.hasFoldedRoles).toBe(false);
    expect(localStorage.getItem(storeKey('matrix-a'))).toBeNull();
  });

  it('survives unreadable and unwritable storage', () => {
    localStorage.setItem(storeKey('matrix-a'), '{not json');
    const { result } = render();
    expect(result.current.hasFoldedRoles).toBe(false);
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    act(() => result.current.foldAllRoles());
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
  });
});
