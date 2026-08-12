// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useMatrixRowOrder } from './useMatrixRowOrder';

const VERSION = 7; // must match ROW_ORDER_VERSION in the hook
const key = (d) => `fgraph-roworder-${d || 'all'}`;

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

describe('useMatrixRowOrder', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns groups unchanged when no saved order exists', () => {
    const { result } = renderHook(() => useMatrixRowOrder('all'));
    expect(result.current.hasCustomOrder).toBe(false);
    const groups = [{ id: 'a' }, { id: 'b' }];
    expect(result.current.getOrderedGroups(groups)).toEqual(groups);
  });

  it('seeds the saved order from localStorage on first render and applies it', () => {
    localStorage.setItem(key('all'), JSON.stringify({ order: ['b', 'a'], version: VERSION }));
    const { result } = renderHook(() => useMatrixRowOrder('all'));
    expect(result.current.hasCustomOrder).toBe(true);
    expect(result.current.getOrderedGroups([{ id: 'a' }, { id: 'b' }]).map((g) => g.id)).toEqual(['b', 'a']);
  });

  it('appends groups not present in the saved order at the end', () => {
    localStorage.setItem(key('all'), JSON.stringify({ order: ['b'], version: VERSION }));
    const { result } = renderHook(() => useMatrixRowOrder('all'));
    expect(result.current.getOrderedGroups([{ id: 'a' }, { id: 'b' }, { id: 'c' }]).map((g) => g.id))
      .toEqual(['b', 'a', 'c']);
  });

  it('discards (and removes) a saved order from an older version', () => {
    localStorage.setItem(key('all'), JSON.stringify({ order: ['b', 'a'], version: 1 }));
    const { result } = renderHook(() => useMatrixRowOrder('all'));
    expect(result.current.hasCustomOrder).toBe(false);
    expect(localStorage.getItem(key('all'))).toBeNull();
  });

  it('reloads the saved order when the department changes', () => {
    localStorage.setItem(key('sales'), JSON.stringify({ order: ['s1'], version: VERSION }));
    const { result, rerender } = renderHook(({ dept }) => useMatrixRowOrder(dept), { initialProps: { dept: 'eng' } });
    expect(result.current.hasCustomOrder).toBe(false); // eng has no saved order
    rerender({ dept: 'sales' });
    expect(result.current.hasCustomOrder).toBe(true);
    expect(result.current.getOrderedGroups([{ id: 's1' }]).map((g) => g.id)).toEqual(['s1']);
  });

  it('persists updateOrder to localStorage and clears it via resetOrder', () => {
    const { result } = renderHook(() => useMatrixRowOrder('all'));
    act(() => result.current.updateOrder(['x', 'y']));
    expect(result.current.hasCustomOrder).toBe(true);
    const saved = JSON.parse(localStorage.getItem(key('all')));
    expect(saved.order).toEqual(['x', 'y']);
    expect(saved.version).toBe(VERSION);

    act(() => result.current.resetOrder());
    expect(result.current.hasCustomOrder).toBe(false);
    expect(localStorage.getItem(key('all'))).toBeNull();
  });
});
