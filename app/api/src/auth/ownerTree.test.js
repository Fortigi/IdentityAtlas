import { describe, it, expect, vi } from 'vitest';
import { buildOwnerForest, loadOwnerTree, withAncestors, OWNER_ANCESTORS_SQL, OWNER_TREE_SQL } from './ownerTree.js';

const row = (id, parentContextId = null, over = {}) => ({ id, displayName: id, parentContextId, contextCategory: 'OrganizationalUnit', ...over });
const shape = n => ({ [n.id]: n.children.map(shape) });

describe('buildOwnerForest', () => {
  it('nests sub-units under what is held and marks the role only where it is held', () => {
    const [root] = buildOwnerForest([row('cto'), row('dev', 'cto'), row('qa', 'dev')], [{ id: 'cto', role: 'Accountable' }]);
    expect(shape(root)).toEqual({ cto: [{ dev: [{ qa: [] }] }] });
    expect(root.role).toBe('Accountable');
    expect(root.children[0].role).toBeNull();
  });

  it('leaves out a variant in scope that is neither held nor below something held', () => {
    const out = buildOwnerForest([row('cto'), row('variant', null, { targetType: 'Resource' })], [{ id: 'cto', role: 'Responsible' }]);
    expect(out.map(n => n.id)).toEqual(['cto']);
  });

  it('keeps separately held contexts as separate roots', () => {
    const out = buildOwnerForest([row('azure'), row('cto')], [{ id: 'azure', role: 'Accountable' }, { id: 'cto', role: 'Accountable' }]);
    expect(out.map(n => n.id)).toEqual(['azure', 'cto']);
  });

  it('shows a held context below another held one once, as a child with its own role', () => {
    const out = buildOwnerForest([row('cto'), row('dev', 'cto')], [{ id: 'dev', role: 'Responsible' }, { id: 'cto', role: 'Accountable' }]);
    expect(out.map(shape)).toEqual([{ cto: [{ dev: [] }] }]);
    expect(out[0].children[0].role).toBe('Responsible');
  });

  it('shows a held context two levels below another held one once', () => {
    const out = buildOwnerForest([row('cto'), row('dev', 'cto'), row('qa', 'dev')], [{ id: 'qa', role: 'Responsible' }, { id: 'cto', role: 'Accountable' }]);
    expect(out.map(shape)).toEqual([{ cto: [{ dev: [{ qa: [] }] }] }]);
  });

  it('matches ids whatever their case, ignores a held id that has no row', () => {
    const out = buildOwnerForest([row('ABC')], [{ id: 'abc', role: 'Accountable' }, { id: 'gone', role: 'Accountable' }]);
    expect(out.map(n => n.id)).toEqual(['ABC']);
    expect(out[0].role).toBe('Accountable');
  });

  it('survives a parent cycle and still shows both', () => {
    const out = buildOwnerForest([row('a', 'b'), row('b', 'a')], [{ id: 'a', role: 'Accountable' }, { id: 'b', role: 'Accountable' }]);
    const seen = [];
    const walk = (n) => { seen.push(n.id); n.children.forEach(walk); };
    out.forEach(walk);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});

describe('withAncestors', () => {
  it('lists the names above each root, top of the tree first, per root', () => {
    const out = withAncestors([{ id: 'CTO' }, { id: 'azure' }, { id: 'hr' }], [
      { rootId: 'cto', displayName: 'Management', depth: 1 },
      { rootId: 'cto', displayName: 'Board', depth: 2 },
      { rootId: 'hr', displayName: 'People', depth: 1 },
    ]);
    expect(out.map(r => r.ancestors)).toEqual([['Board', 'Management'], [], ['People']]);
  });
});

describe('loadOwnerTree', () => {
  it('reads exactly the owner\'s scope, then only what is above its roots', async () => {
    const db = { query: vi.fn(async sql => (sql === OWNER_TREE_SQL
      ? { rows: [row('cto'), row('dev', 'cto')] }
      : { rows: [{ rootId: 'cto', displayName: 'Management', depth: 1 }] })) };
    const out = await loadOwnerTree(db, { contextIds: new Set(['cto', 'dev']), contexts: [{ id: 'cto', role: 'Accountable' }] });
    expect(db.query).toHaveBeenNthCalledWith(1, OWNER_TREE_SQL, [['cto', 'dev']]);
    expect(db.query).toHaveBeenNthCalledWith(2, OWNER_ANCESTORS_SQL, [['cto']]);
    expect(out[0].id).toBe('cto');
    expect(out[0].ancestors).toEqual(['Management']);
  });

  it('asks for no ancestors when there is no tree', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await loadOwnerTree(db, { contextIds: new Set(), contexts: [] })).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
