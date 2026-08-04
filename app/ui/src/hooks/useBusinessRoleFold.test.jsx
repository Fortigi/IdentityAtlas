// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import {
  useBusinessRoleFold, buildRoleChildMap, analyseRoleRows, hideFoldedRows,
  collectFoldedChildRows, summariseFolds, markRoleChildren, rowResourceKey,
  ROLE_FOLD_VERSION,
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

// A resource in two roles is the case the fold has to resolve: it survives the
// first fold, so the role that folded must not claim to have hidden it.
describe('summariseFolds', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const { rolesByChild, childCounts, roleNames } = analyseRoleRows(ROWS, childrenByRole);
  const summarise = (folded) => summariseFolds(ROWS, rolesByChild, childCounts, folded, roleNames);

  it('reports every foldable role as hiding nothing while all are expanded', () => {
    const info = summarise(new Set());
    expect(info.get('BR1')).toEqual({ total: 2, hidden: 0, shownBy: [] });
    expect(info.get('BR2')).toEqual({ total: 2, hidden: 0, shownBy: [] });
  });

  it('counts only the rows the fold really took away, and names who shows the rest', () => {
    const info = summarise(new Set(['BR1']));
    // G1 went; G2 stayed because BR2 grants it and is still expanded.
    expect(info.get('BR1')).toEqual({ total: 2, hidden: 1, shownBy: ['Business Role 2'] });
    // BR2 is not folded, so it hides nothing and owes no explanation.
    expect(info.get('BR2')).toEqual({ total: 2, hidden: 0, shownBy: [] });
  });

  it('counts a shared row under both roles once every one of them is folded', () => {
    const info = summarise(new Set(['BR1', 'BR2']));
    expect(info.get('BR1')).toEqual({ total: 2, hidden: 2, shownBy: [] });
    expect(info.get('BR2')).toEqual({ total: 2, hidden: 2, shownBy: [] });
  });

  it('falls back to the role id when the role keeping a row on screen has no name', () => {
    const rows = [{ id: 'BR1' }, { id: 'BR2' }, { id: 'G2' }];
    const analysis = analyseRoleRows(rows, childrenByRole);
    const info = summariseFolds(rows, analysis.rolesByChild, analysis.childCounts,
      new Set(['BR1']), new Map());
    expect(info.get('BR1').shownBy).toEqual(['BR2']);
  });

  it('tolerates a missing fold set', () => {
    expect(summariseFolds(ROWS, rolesByChild, childCounts, null, roleNames).get('BR1').hidden).toBe(0);
  });
});

describe('markRoleChildren', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const { foldableRoles, rolesByChild, roleNames } = analyseRoleRows(ROWS, childrenByRole);
  const parents = (rows) => rows.map((r) => r.roleParentId || null);
  const mark = (rows, roles = foldableRoles) => markRoleChildren(rows, roles, rolesByChild, roleNames);
  const owners = (rows) => rows.map((r) => (r.roleOwners || []).map((o) => o.name));

  it('marks the resources sitting directly under the role that grants them', () => {
    const marked = mark(ROWS);
    expect(ids(marked)).toEqual(ids(ROWS));
    expect(parents(marked)).toEqual([null, 'BR1', 'BR1', null, 'BR2', null]);
  });

  it('does not indent a resource that is not adjacent to one of its roles', () => {
    // G1 has drifted below G4, away from BR1's block.
    const rows = [{ id: 'BR1' }, { id: 'G4' }, { id: 'G1' }];
    expect(parents(mark(rows))).toEqual([null, null, null]);
  });

  it('carries the marking onto a child row\'s own nested sub-rows', () => {
    const rows = [
      { id: 'BR1' },
      { id: 'G1' },
      { id: 'G1__nested__X', isNestedRow: true, nestLevel: 1 },
      { id: 'G4' },
      { id: 'G4__nested__Y', isNestedRow: true, nestLevel: 1 },
    ];
    expect(parents(mark(rows))).toEqual([null, 'BR1', 'BR1', null, null]);
  });

  it('returns the rows untouched when nothing can be marked', () => {
    expect(markRoleChildren(ROWS, new Set(), rolesByChild, roleNames)).toBe(ROWS);
    expect(mark([{ id: 'G4' }])).toHaveLength(1);
  });

  // Rows keep whatever position the user drags them to, so "which role does
  // this group belong to?" must be answerable from the row itself.
  it('names the granting role on a resource that was moved away from it', () => {
    const rows = [{ id: 'BR1', displayName: 'Business Role 1' }, { id: 'G4' }, { id: 'G1' }];
    const marked = mark(rows);
    expect(owners(marked)).toEqual([[], [], ['Business Role 1']]);
    expect(marked[2].roleGrantedBy).toBe('Business Role 1');
  });

  it('does not repeat the role a resource already sits under', () => {
    const marked = mark(ROWS);
    const byId = new Map(marked.map((r) => [r.id, r]));
    expect(byId.get('G1').roleOwners).toBeUndefined();
    // G2 sits under BR1 but is granted by BR2 as well — that one still needs saying.
    expect(byId.get('G2').roleOwners.map((o) => o.name)).toEqual(['Business Role 2']);
    expect(byId.get('G2').roleGrantedBy).toBe('Business Role 1, Business Role 2');
  });

  it('falls back to the role id when the role row has no display name', () => {
    const rows = [{ id: 'BR1' }, { id: 'G4' }, { id: 'G1' }];
    const nameless = analyseRoleRows(rows, childrenByRole);
    const marked = markRoleChildren(rows, nameless.foldableRoles, nameless.rolesByChild, nameless.roleNames);
    expect(marked[2].roleOwners).toEqual([{ id: 'BR1', name: 'BR1' }]);
  });

  it('says nothing about a resource no role in the grid grants', () => {
    const marked = mark(ROWS);
    const g4 = marked.find((r) => r.id === 'G4');
    expect(g4.roleOwners).toBeUndefined();
    expect(g4.roleGrantedBy).toBeUndefined();
  });

  // A folded role hides its resources, so anything still drawn below it is only
  // there because another role grants it — it must not be indented under the
  // collapsed one.
  it('draws no children under a folded role', () => {
    const rows = hideFoldedRows(ROWS, rolesByChild, new Set(['BR1']));
    const marked = markRoleChildren(rows, foldableRoles, rolesByChild, roleNames, new Set(['BR1']));
    const g2 = marked.find((r) => r.id === 'G2');
    expect(g2.roleParentId).toBeUndefined();
    // ...and it names both roles instead, the expanded one first, since that is
    // the role keeping it on screen.
    expect(g2.roleOwners.map((o) => o.name)).toEqual(['Business Role 2', 'Business Role 1']);
    expect(marked.find((r) => r.id === 'G3').roleParentId).toBe('BR2');
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
    expect(result.current.roleFoldInfo.get('BR1')).toEqual({ total: 2, hidden: 0, shownBy: [] });
  });

  it('renders the resources of an expanded role as its children', () => {
    const { result } = render();
    const byId = new Map(result.current.visibleRows.map((r) => [r.id, r]));
    expect(byId.get('G1').roleParentId).toBe('BR1');
    expect(byId.get('G3').roleParentId).toBe('BR2');
    expect(byId.get('G4').roleParentId).toBeUndefined();
  });

  it('names the granting role on a resource the user dragged away from it', () => {
    // G1 moved to the bottom of the grid, out of BR1's block.
    const rows = ROWS.filter((r) => r.id !== 'G1').concat(ROWS.find((r) => r.id === 'G1'));
    const { result } = render({ rows });
    const g1 = result.current.visibleRows.find((r) => r.id === 'G1');
    expect(g1.roleParentId).toBeUndefined();
    expect(g1.roleOwners).toEqual([{ id: 'BR1', name: 'Business Role 1' }]);
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

  // Feedback on #370 — the whole shared-resource story, end to end: G2 is
  // granted by BR1 and BR2.
  it('keeps a resource two roles grant until both fold, and says so on the role row', () => {
    const { result } = render();
    act(() => result.current.toggleRoleFold('BR1'));

    // Still on screen, no longer drawn as BR1's child, and naming both roles.
    const g2 = result.current.visibleRows.find((r) => r.id === 'G2');
    expect(g2.roleParentId).toBeUndefined();
    expect(g2.roleGrantedBy).toBe('Business Role 1, Business Role 2');
    // BR1 folded one of the two resources it grants, and BR2 is showing the other.
    expect(result.current.roleFoldInfo.get('BR1')).toEqual({
      total: 2, hidden: 1, shownBy: ['Business Role 2'],
    });
    // It is not counted as hidden by either role, so no deviation tally claims it.
    expect(ids(result.current.foldedChildRows.get('BR1'))).toEqual(['G1']);

    act(() => result.current.toggleRoleFold('BR2'));
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
    expect(result.current.roleFoldInfo.get('BR1')).toEqual({ total: 2, hidden: 2, shownBy: [] });
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
