import { describe, it, expect } from 'vitest';
import { graphReducer, initGraphState } from '@ui/components/graph/graphState';

const ROOT = { key: 'user:u1', entityKind: 'user', entityId: 'u1', label: 'Ann', typeLabel: 'User' };
const items = (n) => Array.from({ length: n }, (_, i) => ({ entityKind: 'resource', entityId: `r${i}`, label: `R${i}` }));
const REL = { key: 'assignments-direct', title: 'Direct', label: 'member of', dir: 'out', count: 3, items: items(3) };

describe('graphReducer', () => {
  it('starts with the root at the centre, no list, not loading', () => {
    const s = initGraphState(ROOT);
    expect(s.positions).toEqual({ 'user:u1': { x: 0, y: 0 } });
    expect(s).toMatchObject({ pinned: {}, list: null, loading: false, expanded: [] });
  });

  it('places every node an expansion adds, and drops the positions of collapsed ones', () => {
    let s = graphReducer(initGraphState(ROOT), { type: 'expand', key: 'user:u1', relations: [REL] });
    expect(Object.keys(s.positions).sort()).toEqual(['resource:r0', 'resource:r1', 'resource:r2', 'user:u1']);
    s = graphReducer(s, { type: 'collapse', key: 'user:u1' });
    expect(Object.keys(s.positions)).toEqual(['user:u1']);
  });

  it('opens a cluster and places its objects', () => {
    const big = { ...REL, items: null, count: 12 };
    let s = graphReducer(initGraphState(ROOT), { type: 'expand', key: 'user:u1', relations: [big] });
    expect(Object.keys(s.positions)).toEqual(['user:u1', 'cluster:user:u1:assignments-direct']);
    s = graphReducer(s, { type: 'cluster', key: 'cluster:user:u1:assignments-direct', items: items(12) });
    expect(Object.keys(s.positions)).toHaveLength(13);
  });

  it('moves only the dragged node, then pins it where it was dropped', () => {
    const s0 = graphReducer(initGraphState(ROOT), { type: 'expand', key: 'user:u1', relations: [REL] });
    const moved = graphReducer(s0, { type: 'move', key: 'resource:r1', x: 333, y: 222 });
    expect(moved.positions['resource:r1']).toEqual({ x: 333, y: 222 });
    expect(moved.positions['resource:r0']).toBe(s0.positions['resource:r0']);
    expect(moved.pinned).toEqual({});
    const pinned = graphReducer(moved, { type: 'pin', key: 'resource:r1', x: 333, y: 222 });
    expect(pinned.pinned).toEqual({ 'resource:r1': { x: 333, y: 222 } });
    expect(pinned.positions['resource:r1']).toEqual({ x: 333, y: 222 });
    // A later expansion keeps the pin.
    const later = graphReducer(pinned, { type: 'expand', key: 'resource:r0', relations: [{ ...REL, key: 'x', dir: 'in', items: [{ entityKind: 'user', entityId: 'u2' }] }] });
    expect(later.positions['resource:r1']).toEqual({ x: 333, y: 222 });
  });

  it('keeps the list and the loading flag, and resets everything', () => {
    let s = graphReducer(initGraphState(ROOT), { type: 'loading', value: true });
    s = graphReducer(s, { type: 'list', list: { label: 'Ann → Direct', items: [] } });
    expect(s).toMatchObject({ loading: true, list: { label: 'Ann → Direct' } });
    const other = { ...ROOT, key: 'user:u9', entityId: 'u9' };
    expect(graphReducer(s, { type: 'reset', root: other })).toEqual(initGraphState(other));
  });

  it('ignores an unknown action', () => {
    const s = initGraphState(ROOT);
    expect(graphReducer(s, { type: 'nope' })).toBe(s);
  });
});
