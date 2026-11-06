import { describe, it, expect } from 'vitest';
import { generatedTreeKey, syncedTreeKey, manualTreeKey, parseTreeKey, baseUnitFilter, treeKeyForContext } from './treeKey.js';

const A = '0b6a3c1e-1111-4222-8333-944455556666';
const R = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('tree keys', () => {
  it('round-trips each kind, and keeps an instance key that contains the separator', () => {
    expect(parseTreeKey(generatedTreeKey(A, 'x~y'))).toEqual({ kind: 'generated', algorithmId: A, instanceKey: 'x~y' });
    expect(parseTreeKey(generatedTreeKey(A, null))).toEqual({ kind: 'generated', algorithmId: A, instanceKey: '' });
    expect(parseTreeKey(syncedTreeKey(7, 'LogicalApplication'))).toEqual({ kind: 'synced', systemId: 7, template: 'LogicalApplication' });
    expect(parseTreeKey(manualTreeKey(R.toUpperCase()))).toEqual({ kind: 'manual', rootId: R });
  });

  it('rejects what is not a key', () => {
    for (const bad of [null, 42, '', 'gen~not-a-uuid~k', 'sync~x~T', 'sync~7~', `ctx~${R}~extra`, 'other~1~2', `gen~${A}`.padEnd(400, 'k')]) {
      expect(parseTreeKey(bad)).toBeNull();
    }
  });

  it('filters each kind on its own source, numbering parameters after an offset', () => {
    const gen = baseUnitFilter(parseTreeKey(generatedTreeKey(A, 'k1')), 1);
    expect(gen.sql).toContain(`c."sourceAlgorithmId" = $2 AND COALESCE(c."sourceInstanceKey", '') = $3`);
    expect(gen.params).toEqual([A, 'k1']);
    const sync = baseUnitFilter(parseTreeKey(syncedTreeKey(7, 'LogicalApplication')));
    expect(sync.sql).toContain(`c."scopeSystemId" = $1 AND c."contextCategory" = $2`);
    expect(sync.params).toEqual([7, 'LogicalApplication']);
    expect(baseUnitFilter(parseTreeKey(manualTreeKey(R)))).toEqual({ sql: 'c.id = $1', params: [R] });
  });

  it('names the tree of a context by its own source, or its root\'s when it was made by hand', () => {
    const gen = { id: '1', variant: 'generated', sourceAlgorithmId: A, sourceInstanceKey: 'k' };
    const synced = { id: '2', variant: 'synced', scopeSystemId: 7, contextCategory: 'LogicalApplication' };
    const manualRoot = { id: R, variant: 'manual' };
    expect(treeKeyForContext(gen, gen)).toBe(`gen~${A}~k`);
    expect(treeKeyForContext({ id: '3', variant: 'manual' }, gen)).toBe(`gen~${A}~k`);
    expect(treeKeyForContext(synced, manualRoot)).toBe('sync~7~LogicalApplication');
    expect(treeKeyForContext({ id: '4', variant: 'manual' }, manualRoot)).toBe(`ctx~${R}`);
    expect(treeKeyForContext({ ...synced, contextCategory: null }, manualRoot)).toBe(`ctx~${R}`);
  });
});
