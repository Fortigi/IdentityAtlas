// The pure decisions inside the adjustment engine. The SQL around them runs
// against PostgreSQL in contract-tests/treeAdjustments.contract.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js');
const { rowsToDrop } = await import('./apply.js');
const { returnAddedBy } = await import('./applySplit.js');
const { adjustmentMarks } = await import('./view.js');
const { adjustmentItems, splitCandidates } = await import('./attention.js');
const { followedFields } = await import('./service.js');
const { reapplyAfterSync } = await import('./afterSync.js');
const { dateText } = await import('./ops.js');
const { shapeTree, isSelfOrAncestor } = await import('./treeStore.js');

describe('moving a member', () => {
  const rows = [
    { contextId: 'from', addedBy: 'sync' },
    { contextId: 'elsewhere', addedBy: 'algorithm' },
    { contextId: 'kept', addedBy: 'analyst' },
    { contextId: 'to', addedBy: 'algorithm' },
  ];
  it('always leaves the unit it came from; in a generated tree also the plugin\'s other placement', () => {
    expect(rowsToDrop(rows, { fromUnitId: 'from', toUnitId: 'to' }, 'generated').map(r => r.contextId)).toEqual(['from', 'elsewhere']);
    expect(rowsToDrop(rows, { fromUnitId: 'from', toUnitId: 'to' }, 'synced').map(r => r.contextId)).toEqual(['from']);
  });
});

describe('returnAddedBy', () => {
  it('hands a member back to whoever owns the tree', () => {
    expect([returnAddedBy('generated'), returnAddedBy('synced'), returnAddedBy('manual')]).toEqual(['algorithm', 'sync', 'analyst']);
  });
});

describe('adjustmentMarks', () => {
  it('marks touched, created and interim units from active adjustments only', () => {
    const marks = adjustmentMarks([
      { op: 'moveUnit', subjectId: 'a', status: 'active', payload: {} },
      { op: 'addUnit', subjectId: null, status: 'active', payload: { contextId: 'new' } },
      { op: 'moveMember', subjectId: 'b', status: 'orphaned', payload: { toUnitId: 'b' } },
      { op: 'setManager', subjectId: 'c', status: 'active', payload: { principalId: 'p', interim: true }, validUntil: new Date(2027, 2, 31) },
      { op: 'setManager', subjectId: 'd', status: 'expired', payload: { principalId: 'p', interim: true } },
      { op: 'renameUnit', subjectId: 'e', status: 'reverted', payload: {} },
    ], new Map([['p', 'Bram']]));
    expect([...marks.adjusted].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...marks.created]).toEqual(['new']);
    expect(Object.fromEntries(marks.interim)).toEqual({ c: { name: 'Bram', validUntil: '2027-03-31' } });
  });
});

describe('attention', () => {
  it('turns every overtaken adjustment into one item with its fix, and ignores applied and undone ones', () => {
    const items = adjustmentItems([
      { id: '1', status: 'needsDecision', description: 'Rename X', suggestion: { name: 'Y' }, subjectId: 's', statusDetail: 'gone' },
      { id: '2', status: 'orphaned', description: 'Move A' },
      { id: '3', status: 'matches', description: 'Move B' },
      { id: '4', status: 'expired', description: 'Bram is interim manager of C' },
      { id: '5', status: 'active', description: 'fine' },
      { id: '6', status: 'reverted', description: 'undone' },
    ]);
    expect(items.map(i => [i.kind, i.severity, i.action.type])).toEqual([
      ['decision', 'warn', 'follow'], ['orphaned', 'bad', 'remove'], ['matches', 'ok', 'remove'], ['expired', 'warn', 'remove'],
    ]);
    expect(items[0]).toMatchObject({ id: 'adj:1', unitId: 's', detail: 'gone', action: { label: 'Follow to Y', adjustmentId: '1' } });
  });

  it('proposes splitting off a minority department of two or more, largest first, not twice', () => {
    const tree = shapeTree('k', { kind: 'generated' }, [
      { id: 'it', rawParentId: null, name: 'IT', variant: 'generated' },
      { id: 'fin', rawParentId: null, name: 'Finance', variant: 'generated' },
      { id: 'mine', rawParentId: null, name: 'By hand', variant: 'manual' },
    ]);
    const rows = [
      { contextId: 'it', value: 'IT', count: 6 }, { contextId: 'it', value: 'Facilities', count: 3 }, { contextId: 'it', value: 'HR', count: 1 },
      { contextId: 'fin', value: 'Finance', count: 5 }, { contextId: 'fin', value: 'Control', count: 2 }, { contextId: 'fin', value: null, count: 9 },
      { contextId: 'mine', value: 'A', count: 5 }, { contextId: 'mine', value: 'B', count: 5 },
    ];
    const items = splitCandidates(rows, tree, new Set(['fin|Control']));
    expect(items.map(i => i.id)).toEqual(['split:it:Facilities']);
    expect(items[0]).toMatchObject({ action: { type: 'split', subjectId: 'it', attribute: 'department', value: 'Facilities' } });
    expect(items[0].detail).toBe('3 of its 10 members are in department "Facilities"; most are in "IT". They may be a separate team, or one managed on an interim basis.');
    expect(splitCandidates(rows, tree, new Set()).map(i => i.id)).toEqual(['split:it:Facilities', 'split:fin:Control']);
  });
});

describe('following a proposal', () => {
  it('points the adjustment at the new unit, or the new value for a split', () => {
    const move = { op: 'moveMember', subjectId: 'old', payload: { fromUnitId: 'f', toUnitId: 'old' }, suggestion: { contextId: 'new' } };
    expect(followedFields(move)).toEqual({ subjectId: 'new', payload: { fromUnitId: 'f', toUnitId: 'new' } });
    const rename = { op: 'renameUnit', subjectId: 'old', payload: { name: 'N' }, suggestion: { contextId: 'new' } };
    expect(followedFields(rename)).toEqual({ subjectId: 'new', payload: { name: 'N' } });
    const split = { op: 'splitUnit', subjectId: 'u', payload: { attribute: 'department', value: 'Old' }, suggestion: { value: 'New' } };
    expect(followedFields(split)).toEqual({ subjectId: 'u', payload: { attribute: 'department', value: 'New' } });
    expect(() => followedFields({ op: 'renameUnit', payload: {}, suggestion: null })).toThrow(/nothing to follow/);
  });
});

describe('the ingest hook', () => {
  it('only reacts to a sync of contexts or their members, from a known source', async () => {
    const runner = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await reapplyAfterSync(runner, 'Principals', 7)).toBe(0);
    expect(await reapplyAfterSync(runner, 'Contexts', null)).toBe(0);
    expect(runner.query).not.toHaveBeenCalled();
    expect(await reapplyAfterSync(runner, 'ContextMembers', 7)).toBe(0);
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('"scopeSystemId" = $1'), [7]);
  });
});

describe('small helpers', () => {
  it('reads a DATE as the calendar day, from a Date or a string', () => {
    expect(dateText(new Date(2027, 0, 5))).toBe('2027-01-05');
    expect(dateText('2027-01-05T00:00:00Z')).toBe('2027-01-05');
    expect([dateText(null), dateText('')]).toEqual([null, null]);
  });

  it('knows a unit\'s ancestors and treats a parent outside the tree as the top', () => {
    const tree = shapeTree('k', { kind: 'manual' }, [
      { id: 'a', rawParentId: 'outside', name: 'A' }, { id: 'b', rawParentId: 'a', name: 'B' }, { id: 'c', rawParentId: 'b', name: 'C' },
    ]);
    expect(tree.byId.get('a').parentId).toBeNull();
    expect(isSelfOrAncestor(tree, 'a', 'c')).toBe(true);
    expect(isSelfOrAncestor(tree, 'c', 'a')).toBe(false);
    expect(isSelfOrAncestor(tree, 'b', 'b')).toBe(true);
  });
});
