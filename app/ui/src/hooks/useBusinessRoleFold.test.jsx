// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import {
  useBusinessRoleFold, buildRoleChildMap, analyseRoleRows, buildRoleLayout,
  rowResourceKey, ROLE_FOLD_VERSION,
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

describe('buildRoleLayout', () => {
  const childrenByRole = buildRoleChildMap(AP_GROUPS);
  const analysis = analyseRoleRows(ROWS, childrenByRole);
  const layout = (folded, rows = ROWS, a = analysis) => buildRoleLayout(rows, a, folded);
  const parents = (rows) => rows.map((r) => r.roleParentId || null);

  // The point of the redesign (requestor feedback on #370): G2 is granted by BR1
  // and BR2, so it has a row under each of them.
  it('draws every resource under each business role that grants it', () => {
    const { visibleRows } = layout(new Set());
    expect(ids(visibleRows)).toEqual(['BR1', 'G1', 'G2', 'BR2', 'G2', 'G3', 'G4']);
    expect(parents(visibleRows)).toEqual([null, 'BR1', 'BR1', null, 'BR2', 'BR2', null]);
  });

  it('gives each copy of a shared row a key of its own', () => {
    const keys = layout(new Set()).visibleRows.filter((r) => r.id === 'G2').map((r) => r.rowKey);
    expect(keys).toEqual(['BR1::G2', 'BR2::G2']);
  });

  it('names the other granting roles on each copy, and all of them in the tooltip', () => {
    const [underBr1, underBr2] = layout(new Set()).visibleRows.filter((r) => r.id === 'G2');
    expect(underBr1.roleOwners).toEqual([{ id: 'BR2', name: 'Business Role 2' }]);
    expect(underBr2.roleOwners).toEqual([{ id: 'BR1', name: 'Business Role 1' }]);
    expect(underBr1.roleGrantedBy).toBe('Business Role 1, Business Role 2');
    expect(underBr1.roleGrantIds).toEqual(['BR1', 'BR2']);
  });

  it('says nothing about a resource no role in the grid grants', () => {
    const g4 = layout(new Set()).visibleRows.find((r) => r.id === 'G4');
    expect(g4.roleOwners).toBeUndefined();
    expect(g4.roleGrantedBy).toBeUndefined();
    expect(g4.rowKey).toBeUndefined();
  });

  it('leaves a resource with a single granting role unmarked by the chip', () => {
    const g1 = layout(new Set()).visibleRows.find((r) => r.id === 'G1');
    expect(g1.roleOwners).toBeUndefined();
    expect(g1.roleGrantedBy).toBe('Business Role 1');
  });

  // A resource is drawn under its roles wherever the saved row order puts it,
  // so it can never end up orphaned from the role that grants it.
  it('files a resource under its role even when the row order moved it away', () => {
    const rows = [{ id: 'BR1', displayName: 'Business Role 1' }, { id: 'G4' }, { id: 'G1' }];
    const { visibleRows } = layout(new Set(), rows, analyseRoleRows(rows, childrenByRole));
    expect(ids(visibleRows)).toEqual(['BR1', 'G1', 'G4']);
    expect(visibleRows[1].roleParentId).toBe('BR1');
  });

  it('folds away only the copies belonging to the folded role', () => {
    const { visibleRows } = layout(new Set(['BR1']));
    expect(ids(visibleRows)).toEqual(['BR1', 'BR2', 'G2', 'G3', 'G4']);
    // The surviving G2 is BR2's copy — the one the reader can still unfold from.
    expect(visibleRows[2].roleParentId).toBe('BR2');
  });

  it('leaves roles plus ungranted resources when everything is folded', () => {
    expect(ids(layout(new Set(['BR1', 'BR2'])).visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
  });

  it('reports what each role folds away, shared rows included', () => {
    expect(layout(new Set()).roleFoldInfo.get('BR1')).toEqual({ total: 2 });
    const folded = layout(new Set(['BR1']));
    expect(folded.roleFoldInfo.get('BR1')).toEqual({ total: 2 });
    expect(ids(folded.foldedChildRows.get('BR1'))).toEqual(['G1', 'G2']);
    expect(folded.foldedChildRows.has('BR2')).toBe(false);
  });

  it('carries an expanded row\'s nested sub-rows with it, under every role', () => {
    const rows = [
      { id: 'BR1', displayName: 'Business Role 1' },
      { id: 'G2', displayName: 'Group 2' },
      { id: 'G2__nested__X', isNestedRow: true, nestLevel: 1 },
      { id: 'BR2', displayName: 'Business Role 2' },
      { id: 'G4' },
    ];
    const a = analyseRoleRows(rows, childrenByRole);
    const { visibleRows } = buildRoleLayout(rows, a, new Set());
    expect(ids(visibleRows))
      .toEqual(['BR1', 'G2', 'G2__nested__X', 'BR2', 'G2', 'G2__nested__X', 'G4']);
    expect(visibleRows[2].rowKey).toBe('BR1::G2__nested__X');
    expect(visibleRows[5].rowKey).toBe('BR2::G2__nested__X');
    expect(visibleRows[5].roleParentId).toBe('BR2');
    // Folding the role takes the sub-rows with the row they hang under.
    expect(ids(buildRoleLayout(rows, a, new Set(['BR1'])).visibleRows))
      .toEqual(['BR1', 'BR2', 'G2', 'G2__nested__X', 'G4']);
  });

  it('leaves a grid without business roles exactly as it found it', () => {
    const rows = [{ id: 'G4' }, { id: 'G5' }];
    const a = analyseRoleRows(rows, childrenByRole);
    expect(ids(buildRoleLayout(rows, a, new Set()).visibleRows)).toEqual(['G4', 'G5']);
    expect(buildRoleLayout(rows, a, undefined).roleFoldInfo.size).toBe(0);
  });

  it('falls back to the role id when the other granting role has no display name', () => {
    const rows = [{ id: 'BR1' }, { id: 'BR2' }, { id: 'G2' }];
    const a = analyseRoleRows(rows, childrenByRole);
    const [first] = buildRoleLayout(rows, a, new Set()).visibleRows.filter((r) => r.id === 'G2');
    expect(first.roleOwners).toEqual([{ id: 'BR2', name: 'BR2' }]);
  });

  // A business role contained in another one is a row in its own right — it
  // keeps its place (and its own children) rather than being filed under its
  // parent, where its fold chevron would be unreachable once the parent folded.
  it('does not relocate a business role that another role contains', () => {
    const apGroups = [...AP_GROUPS, { accessPackageId: 'BR2', resourceId: 'BR1' }];
    const children = buildRoleChildMap(apGroups);
    const a = analyseRoleRows(ROWS, children);
    expect(a.rolesByChild.has('BR1')).toBe(false);
    expect(a.childCounts.get('BR2')).toBe(2);
    expect(ids(buildRoleLayout(ROWS, a, new Set()).visibleRows))
      .toEqual(['BR1', 'G1', 'G2', 'BR2', 'G2', 'G3', 'G4']);
  });
});

describe('rowResourceKey', () => {
  it('prefers the real resource id of a synthetic row', () => {
    expect(rowResourceKey({ id: 'g1__owner', realGroupId: 'g1' })).toBe('G1');
    expect(rowResourceKey({ id: 'g2' })).toBe('G2');
  });
});

describe('useBusinessRoleFold', () => {
  // G2 is granted by both roles, so it has a row under each of them.
  const EXPANDED = ['BR1', 'G1', 'G2', 'BR2', 'G2', 'G3', 'G4'];

  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('starts expanded and exposes the foldable roles', () => {
    const { result } = render();
    expect(result.current.canFoldRoles).toBe(true);
    expect(result.current.hasFoldedRoles).toBe(false);
    expect(ids(result.current.visibleRows)).toEqual(EXPANDED);
    expect(result.current.roleFoldInfo.get('BR1')).toEqual({ total: 2 });
  });

  it('renders the resources of an expanded role as its children', () => {
    const { result } = render();
    const byId = new Map(result.current.visibleRows.map((r) => [r.id, r]));
    expect(byId.get('G1').roleParentId).toBe('BR1');
    expect(byId.get('G3').roleParentId).toBe('BR2');
    expect(byId.get('G4').roleParentId).toBeUndefined();
  });

  it('files a resource under its role wherever the row order puts it', () => {
    // G1 moved to the bottom of the grid, out of BR1's block.
    const rows = ROWS.filter((r) => r.id !== 'G1').concat(ROWS.find((r) => r.id === 'G1'));
    const { result } = render({ rows });
    const g1 = result.current.visibleRows.find((r) => r.id === 'G1');
    expect(g1.roleParentId).toBe('BR1');
    expect(g1.roleOwners).toBeUndefined();
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
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G2', 'G3', 'G4']);
    act(() => result.current.toggleRoleFold('BR1'));
    expect(ids(result.current.visibleRows)).toEqual(EXPANDED);
  });

  // Feedback on #370 — the whole shared-resource story, end to end: G2 is
  // granted by BR1 and BR2, so it has a row under each and each fold takes only
  // its own copy.
  it('shows a resource two roles grant under both, and folds one copy at a time', () => {
    const { result } = render();
    act(() => result.current.toggleRoleFold('BR1'));

    // BR2's copy is still on screen, drawn as BR2's child and naming BR1 too.
    const g2 = result.current.visibleRows.filter((r) => r.id === 'G2');
    expect(g2).toHaveLength(1);
    expect(g2[0].roleParentId).toBe('BR2');
    expect(g2[0].roleGrantedBy).toBe('Business Role 1, Business Role 2');
    // BR1 folded both of the resources it grants — its own copies, all of them.
    expect(result.current.roleFoldInfo.get('BR1')).toEqual({ total: 2 });
    expect(ids(result.current.foldedChildRows.get('BR1'))).toEqual(['G1', 'G2']);

    act(() => result.current.toggleRoleFold('BR2'));
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
  });

  it('folds every role at once, leaving roles plus ungranted resources', () => {
    const { result } = render();
    act(() => result.current.foldAllRoles());
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G4']);
    act(() => result.current.unfoldAllRoles());
    expect(ids(result.current.visibleRows)).toEqual(EXPANDED);
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
    expect(ids(result.current.visibleRows)).toEqual(['BR1', 'BR2', 'G2', 'G3', 'G4']);
    rerender({ p: { accessPackageGroups: AP_GROUPS, rows: ROWS, storageKey: 'matrix-b' } });
    expect(ids(result.current.visibleRows)).toEqual(EXPANDED);
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
