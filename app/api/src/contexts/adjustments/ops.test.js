import { describe, it, expect } from 'vitest';
import { validateAdjustment, describeAdjustment, ADJUSTMENT_OPS } from './ops.js';
import { shapeTree } from './treeStore.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1); const FIN = id(2); const ACC = id(3); const IT = id(4); const OUTSIDE = id(99);

// Board > (Finance > Accounting), IT — Board's parent is outside the tree.
function tree(targetType = 'Principal') {
  const rows = [
    { id: TOP, rawParentId: OUTSIDE, name: 'Board', variant: 'generated', targetType },
    { id: FIN, rawParentId: TOP, name: 'Finance', variant: 'generated', targetType },
    { id: ACC, rawParentId: FIN, name: 'Accounting', variant: 'generated', targetType },
    { id: IT, rawParentId: TOP, name: 'IT', variant: 'generated', targetType },
  ];
  return shapeTree('k', { kind: 'generated' }, rows);
}

const fails = (body, message, status = 400, t = tree()) => {
  let err;
  try { validateAdjustment(body, t); } catch (e) { err = e; }
  expect(err?.message).toMatch(message);
  expect(err?.status).toBe(status);
};

describe('validateAdjustment', () => {
  it('knows exactly the six operations', () => {
    expect(ADJUSTMENT_OPS).toEqual(['moveUnit', 'renameUnit', 'moveMember', 'addUnit', 'splitUnit', 'setManager']);
    fails({ op: 'deleteUnit' }, /op must be one of/);
  });

  it('moves a unit anywhere but into itself or below itself, or where it already is', () => {
    expect(validateAdjustment({ op: 'moveUnit', subjectId: ACC, toParentId: IT }, tree()))
      .toMatchObject({ op: 'moveUnit', subjectId: ACC, payload: { toParentId: IT } });
    expect(validateAdjustment({ op: 'moveUnit', subjectId: FIN, toParentId: null }, tree()).payload).toEqual({ toParentId: null });
    fails({ op: 'moveUnit', subjectId: FIN, toParentId: ACC }, /into itself or one of its own sub-units/);
    fails({ op: 'moveUnit', subjectId: FIN, toParentId: FIN }, /into itself/);
    fails({ op: 'moveUnit', subjectId: ACC, toParentId: FIN }, /already there/);
    fails({ op: 'moveUnit', subjectId: TOP, toParentId: '' }, /already there/);
    fails({ op: 'moveUnit', subjectId: OUTSIDE, toParentId: IT }, /not a unit of this tree/, 404);
    fails({ op: 'moveUnit', subjectId: 'nope' }, /subjectId \(uuid\) is required/);
  });

  it('renames to a new, trimmed name', () => {
    expect(validateAdjustment({ op: 'renameUnit', subjectId: FIN, name: '  Finance & Control ', reason: ' typo in HR ' }, tree()))
      .toMatchObject({ payload: { name: 'Finance & Control' }, reason: 'typo in HR' });
    fails({ op: 'renameUnit', subjectId: FIN, name: '   ' }, /name is required/);
    fails({ op: 'renameUnit', subjectId: FIN, name: 'Finance' }, /already has that name/);
  });

  it('moves a member between two different units of the tree, keyed on the target unit', () => {
    const m = id(50).toUpperCase();
    expect(validateAdjustment({ op: 'moveMember', memberId: m, fromUnitId: FIN, toUnitId: IT }, tree()))
      .toMatchObject({ subjectId: IT, memberId: m.toLowerCase(), payload: { fromUnitId: FIN, toUnitId: IT } });
    fails({ op: 'moveMember', memberId: m, fromUnitId: FIN, toUnitId: FIN }, /already in that unit/);
    fails({ op: 'moveMember', memberId: 'x', fromUnitId: FIN, toUnitId: IT }, /memberId/);
  });

  it('adds a unit at the top level or under one of the tree', () => {
    expect(validateAdjustment({ op: 'addUnit', name: 'Physical access' }, tree())).toMatchObject({ subjectId: null, payload: { name: 'Physical access', parentId: null } });
    expect(validateAdjustment({ op: 'addUnit', name: 'Ops', parentId: TOP }, tree())).toMatchObject({ subjectId: TOP, payload: { parentId: TOP } });
    fails({ op: 'addUnit', name: 'Ops', parentId: OUTSIDE }, /not a unit/, 404);
  });

  it('splits accounts by attribute, any tree by picked members', () => {
    expect(validateAdjustment({ op: 'splitUnit', subjectId: IT, attribute: 'department', value: 'Facilities' }, tree()).payload)
      .toEqual({ attribute: 'department', value: 'Facilities', name: 'Facilities' });
    fails({ op: 'splitUnit', subjectId: IT, attribute: 'department', value: 'X' }, /pick members instead/, 400, tree('Resource'));
    fails({ op: 'splitUnit', subjectId: IT, attribute: 'department' }, /attribute and value are required/);
    const picked = validateAdjustment({ op: 'splitUnit', subjectId: IT, memberIds: [id(7), id(7), 'junk'], name: 'Badges' }, tree('Resource'));
    expect(picked.payload).toEqual({ memberIds: [id(7)], name: 'Badges' });
    fails({ op: 'splitUnit', subjectId: IT, memberIds: ['junk'], name: 'X' }, /at least one member/);
    fails({ op: 'splitUnit', subjectId: IT, memberIds: [id(7)] }, /name is required/);
  });

  it('sets a manager, optionally interim until a date', () => {
    expect(validateAdjustment({ op: 'setManager', subjectId: IT, principalId: id(8), interim: true, validUntil: '2027-03-31' }, tree()))
      .toMatchObject({ payload: { principalId: id(8), interim: true }, validUntil: '2027-03-31' });
    expect(validateAdjustment({ op: 'setManager', subjectId: IT, principalId: id(8), interim: 'yes' }, tree()).payload.interim).toBe(false);
    fails({ op: 'setManager', subjectId: IT, principalId: id(8), validUntil: '31-03-2027' }, /YYYY-MM-DD/);
  });
});

describe('describeAdjustment', () => {
  const names = { [FIN]: 'Finance', [IT]: 'IT' };
  const nameOf = (x) => names[x] || null;

  it('says what each operation does, by the units\' current names', () => {
    expect(describeAdjustment({ op: 'moveUnit', subjectId: FIN, payload: { toParentId: IT } }, { nameOf })).toBe('Move Finance under IT');
    expect(describeAdjustment({ op: 'moveUnit', subjectId: FIN, payload: { toParentId: null } }, { nameOf })).toBe('Move Finance to the top level');
    expect(describeAdjustment({ op: 'renameUnit', subjectId: FIN, snapshot: { name: 'Fin' }, payload: { name: 'Finance' } }, { nameOf })).toBe('Rename Fin to "Finance"');
    expect(describeAdjustment({ op: 'moveMember', payload: { fromUnitId: FIN, toUnitId: IT } }, { nameOf, memberName: 'Eva' })).toBe('Move Eva from Finance to IT');
    expect(describeAdjustment({ op: 'addUnit', payload: { name: 'Ops', parentId: null } }, { nameOf })).toBe('Add unit "Ops" at the top level');
    expect(describeAdjustment({ op: 'splitUnit', subjectId: IT, payload: { attribute: 'department', value: 'Facilities' } }, { nameOf })).toBe('Split department "Facilities" off IT');
    expect(describeAdjustment({ op: 'splitUnit', subjectId: IT, payload: { memberIds: [1, 2], name: 'B' } }, { nameOf })).toBe('Split 2 member(s) off IT into "B"');
    expect(describeAdjustment({ op: 'setManager', subjectId: IT, payload: { interim: true }, validUntil: '2027-03-31' }, { nameOf, managerName: 'Bram' }))
      .toBe('Bram is interim manager of IT until 2027-03-31');
    expect(describeAdjustment({ op: 'setManager', subjectId: IT, payload: { interim: false } }, { nameOf })).toBe('Someone manages IT');
  });

  it('falls back to the remembered name when the unit is gone', () => {
    expect(describeAdjustment({ op: 'moveUnit', subjectId: id(77), snapshot: { name: 'Old unit' }, payload: { toParentId: id(78) } }, { nameOf }))
      .toBe('Move Old unit under a unit that is gone');
  });
});
