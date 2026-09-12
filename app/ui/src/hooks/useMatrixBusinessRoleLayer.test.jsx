// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useMatrixBusinessRoleLayer } from './useMatrixBusinessRoleLayer';

// What this file is about: the SWITCH. The pieces it composes — the fold layout
// and the deviation tallies — are covered in useBusinessRoleFold.test.jsx and
// coverageDeviation.test.js. Here the question is only ever "does the matrix's
// own opt-in decide whether any of that happens at all", because that is the
// promise made to everyone who never ticks the box: their matrix is untouched.

// jsdom in this project runs without an origin, so window.localStorage is
// absent. Back it with a Map, as the fold hook's own tests do.
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// BR1 grants G1. G2 is granted by nobody, so it must survive every fold — a
// grid that empties out would satisfy "the rows changed" for the wrong reason.
const AP_GROUPS = [{ accessPackageId: 'BR1', resourceId: 'G1' }];
const ROWS = [
  { id: 'BR1', displayName: 'Business Role 1' },
  { id: 'G1', displayName: 'Group 1' },
  { id: 'G2', displayName: 'Group 2' },
];
// A different list, so "exportRows fell back to exportBase" cannot pass by
// accidentally being the same array as `rows`.
const EXPORT_BASE = [{ id: 'G2', displayName: 'Group 2' }];

const USERS = [{ id: 'u1' }];
// Coverage is keyed by the resource a role hands out: BR1 covers G1 for u1, and
// (migration 061) its own cell too. u1 holds neither, so a folded BR1 owes them
// one "missing" tally on the row it hid.
const MANAGED_AP_MAP = new Map([['g1|u1', ['br1']], ['br1|u1', ['br1']]]);
const AP_GROUP_MAP = new Map([['G1|br1', 'Member']]);

function render(filter, overrides = {}) {
  return renderHook(() => useMatrixBusinessRoleLayer({
    filter,
    accessPackageGroups: AP_GROUPS,
    rows: ROWS,
    storageKey: 'matrix-a',
    exportBase: EXPORT_BASE,
    users: USERS,
    memberships: new Map(),
    managedApMap: MANAGED_AP_MAP,
    apGroupMap: AP_GROUP_MAP,
    userToAgg: new Map(),
    ...overrides,
  }));
}

const ids = (rows) => rows.map((r) => r.id);

beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('useMatrixBusinessRoleLayer — the matrix did not ask for the layer', () => {
  it('hands the rows straight back, with nothing foldable', () => {
    const { result } = render({ rowType: 'principal' });

    expect(result.current.enabled).toBe(false);
    expect(result.current.rows).toEqual(ROWS);         // untouched, in the order given
    expect(result.current.canFoldRoles).toBe(false);
    expect(result.current.hasFoldedRoles).toBe(false);
    expect(result.current.foldableRoles.size).toBe(0);
    expect(result.current.roleFoldInfo.size).toBe(0);
  });

  it('exports the plain row order rather than the under-role layout', () => {
    const { result } = render({ rowType: 'principal' });
    expect(result.current.exportRows).toBe(EXPORT_BASE);
  });

  it('produces no tallies for the cells to draw', () => {
    const { result } = render({ rowType: 'principal' });
    expect(result.current.extraCounts).toBeNull();
    expect(result.current.missingCounts).toBeNull();
  });

  // The flag crosses a network boundary (it is saved with the matrix and read
  // back), so a string "true" or a 1 is a realistic thing to arrive. Anything
  // but the boolean must leave the layer off — the same `=== true` rule the API
  // parser and the wizard normaliser apply, and a mismatch here would show the
  // layer on a matrix the server built rows for without it.
  it.each([['true'], [1], [{}], ['yes']])('stays off for the truthy value %p', (value) => {
    const { result } = render({ rowType: 'principal', includeBusinessRoles: value });
    expect(result.current.enabled).toBe(false);
    expect(result.current.rows).toEqual(ROWS);
  });

  it('stays off when there is no filter at all', () => {
    // The matrix renders before a filter is applied; reading through a missing
    // filter must answer "off", not throw.
    for (const filter of [null, undefined]) {
      const { result } = render(filter);
      expect(result.current.enabled).toBe(false);
    }
  });
});

describe('useMatrixBusinessRoleLayer — the matrix asked for the layer', () => {
  const ON = { rowType: 'principal', includeBusinessRoles: true };

  it('draws the resources a role grants underneath it', () => {
    const { result } = render(ON);

    expect(result.current.enabled).toBe(true);
    expect(result.current.canFoldRoles).toBe(true);
    expect(ids(result.current.rows)).toEqual(['BR1', 'G1', 'G2']);
    // G1 is now the role's child; G2 belongs to no role and stays top-level.
    const byId = new Map(result.current.rows.map((r) => [r.id, r]));
    expect(byId.get('G1').roleParentId).toBe('BR1');
    expect(byId.get('G2').roleParentId).toBeUndefined();
  });

  it('takes the role\'s rows away when it is folded, and counts what it hides', () => {
    const { result } = render(ON);

    act(() => result.current.toggleRoleFold('BR1'));

    expect(ids(result.current.rows)).toEqual(['BR1', 'G2']);
    expect(result.current.hasFoldedRoles).toBe(true);
    // u1 holds BR1 but not the group it grants — one assignment short.
    expect(result.current.missingCounts.get('BR1|u1')).toBe(1);
  });

  it('exports every resource even while a role is folded', () => {
    const { result } = render(ON);
    act(() => result.current.foldAllRoles());

    expect(ids(result.current.rows)).not.toContain('G1');
    // The export is the grid's structure without the folds — never the fallback
    // list, and never missing the row the fold took off screen.
    expect(ids(result.current.exportRows)).toEqual(['BR1', 'G1', 'G2']);
    expect(result.current.exportRows).not.toBe(EXPORT_BASE);
  });

  it('unfolds everything again', () => {
    const { result } = render(ON);
    act(() => result.current.foldAllRoles());
    act(() => result.current.unfoldAllRoles());

    expect(ids(result.current.rows)).toEqual(['BR1', 'G1', 'G2']);
    expect(result.current.hasFoldedRoles).toBe(false);
  });
});
